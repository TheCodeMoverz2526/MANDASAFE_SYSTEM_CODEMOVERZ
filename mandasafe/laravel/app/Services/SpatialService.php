<?php

namespace App\Services;

use App\Models\Barangay;
use App\Models\Incident;
use Illuminate\Support\Facades\DB;

/**
 * MandaSafe's spatial layer on top of SQLite.
 *
 * Geometry is stored in the OGC Well-Known Text standard with SRID 4326 (WGS 84, the GPS
 * coordinate system the records use): the 27 barangay boundaries as MULTIPOLYGONs in the
 * `barangays` table, each accident as a POINT in `incidents.geom_wkt`. Two indexes make the
 * spatial queries fast without a geometry extension:
 *
 *  - every barangay's bounding box (min/max lat/lng columns) rejects most polygons before
 *    the exact point-in-polygon test runs, and
 *  - every accident's geohash (a base-32 code of nested grid cells; 7 characters ≈ 153 m ×
 *    153 m) is indexed, so "accidents near here" is a prefix lookup on nine cells instead of a
 *    scan of the whole table.
 *
 * Each accident is also joined to the barangay its coordinates actually fall in
 * (`barangay_id`), independent of the barangay name typed on the record, and given a
 * `location_status` so records whose point and name disagree can be found and corrected.
 */
class SpatialService
{
    public const SRID = 4326;

    public const GEOHASH_PRECISION = 7;

    private const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

    private const EARTH_RADIUS_M = 6371008.8;

    /** Location statuses, from best to worst. */
    public const INSIDE = 'inside';            // point is inside the barangay named on the record

    public const OTHER_BARANGAY = 'other_barangay'; // point is in Mandaluyong, but another barangay

    public const OUTSIDE_CITY = 'outside_city';  // point is outside all 27 barangays

    public const NO_LOCATION = 'no_location';    // record has no coordinates

    /** @var array<int, array{id: int, name: string, bbox: array, rings: array}>|null */
    private static ?array $polygons = null;

    /* ------------------------------------------------------------------ geometry */

    public static function pointWkt(float $lat, float $lng): string
    {
        return sprintf('POINT(%.6F %.6F)', $lng, $lat);
    }

    /** @param  array<int, array<int, array{0: float, 1: float}>>  $polygons  outer rings of [lng, lat] */
    public static function multiPolygonWkt(array $polygons): string
    {
        $parts = array_map(function ($ring) {
            return '((' . implode(', ', array_map(fn ($p) => sprintf('%.9F %.9F', $p[0], $p[1]), $ring)) . '))';
        }, $polygons);

        return 'MULTIPOLYGON(' . implode(', ', $parts) . ')';
    }

    /** Outer rings of a GeoJSON Polygon or MultiPolygon, as lists of [lng, lat]. */
    public static function outerRings(array $geometry): array
    {
        return match ($geometry['type'] ?? null) {
            'Polygon' => [$geometry['coordinates'][0]],
            'MultiPolygon' => array_map(fn ($polygon) => $polygon[0], $geometry['coordinates']),
            default => [],
        };
    }

    public static function geohash(float $lat, float $lng, int $precision = self::GEOHASH_PRECISION): string
    {
        $latRange = [-90.0, 90.0];
        $lngRange = [-180.0, 180.0];
        $hash = '';
        $bit = 0;
        $char = 0;
        $even = true;

        while (strlen($hash) < $precision) {
            // Bits alternate: longitude, latitude, longitude, ...
            $char <<= 1;
            if ($even) {
                $mid = ($lngRange[0] + $lngRange[1]) / 2;
                if ($lng >= $mid) {
                    $char |= 1;
                    $lngRange[0] = $mid;
                } else {
                    $lngRange[1] = $mid;
                }
            } else {
                $mid = ($latRange[0] + $latRange[1]) / 2;
                if ($lat >= $mid) {
                    $char |= 1;
                    $latRange[0] = $mid;
                } else {
                    $latRange[1] = $mid;
                }
            }
            $even = ! $even;
            if (++$bit === 5) {
                $hash .= self::GEOHASH_ALPHABET[$char];
                $bit = 0;
                $char = 0;
            }
        }

        return $hash;
    }

    /** Great-circle distance in meters (haversine). */
    public static function distanceMeters(float $lat1, float $lng1, float $lat2, float $lng2): float
    {
        $dLat = deg2rad($lat2 - $lat1);
        $dLng = deg2rad($lng2 - $lng1);
        $a = sin($dLat / 2) ** 2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng / 2) ** 2;

        return 2 * self::EARTH_RADIUS_M * asin(min(1.0, sqrt($a)));
    }

    /** Ray-casting point-in-polygon over one ring of [lng, lat]. */
    public static function inRing(float $lat, float $lng, array $ring): bool
    {
        $inside = false;
        $count = count($ring);
        for ($i = 0, $j = $count - 1; $i < $count; $j = $i++) {
            [$xi, $yi] = $ring[$i];
            [$xj, $yj] = $ring[$j];
            if (($yi > $lat) !== ($yj > $lat) && $lng < ($xj - $xi) * ($lat - $yi) / ($yj - $yi) + $xi) {
                $inside = ! $inside;
            }
        }

        return $inside;
    }

    /**
     * Area in km² and centroid of a set of outer rings, on a local equirectangular projection
     * — accurate to well under 1% at a city's scale.
     *
     * @return array{area_km2: float, lat: float, lng: float}
     */
    public static function areaAndCentroid(array $rings): array
    {
        $all = array_merge(...$rings);
        $lat0 = array_sum(array_column($all, 1)) / count($all);
        $mx = 111320.0 * cos(deg2rad($lat0));
        $my = 111320.0;

        $area = 0.0;
        $cx = 0.0;
        $cy = 0.0;
        foreach ($rings as $ring) {
            $n = count($ring);
            for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
                $x0 = $ring[$j][0] * $mx;
                $y0 = $ring[$j][1] * $my;
                $x1 = $ring[$i][0] * $mx;
                $y1 = $ring[$i][1] * $my;
                $cross = $x0 * $y1 - $x1 * $y0;
                $area += $cross;
                $cx += ($x0 + $x1) * $cross;
                $cy += ($y0 + $y1) * $cross;
            }
        }
        $area /= 2;

        return [
            'area_km2' => abs($area) / 1e6,
            'lat' => $area == 0.0 ? $lat0 : $cy / (6 * $area) / $my,
            'lng' => $area == 0.0 ? $all[0][0] : $cx / (6 * $area) / $mx,
        ];
    }

    /* ------------------------------------------------------------------ barangays */

    /**
     * Loads the official boundary GeoJSON into the `barangays` table (insert or refresh by
     * PSGC code). Called by the spatial-schema migration and by `mandasafe:spatial-sync`.
     */
    public static function seedBarangays(?string $path = null): int
    {
        $path ??= config('mandasafe.geojson');
        $raw = is_string($path) && is_file($path) ? file_get_contents($path) : false;
        $geojson = $raw === false ? null : json_decode($raw, true);
        $count = 0;

        foreach ($geojson['features'] ?? [] as $feature) {
            $props = $feature['properties'] ?? [];
            $rings = self::outerRings($feature['geometry'] ?? []);
            if (empty($props['brgy_name']) || $rings === []) {
                continue;
            }
            $lngs = array_merge(...array_map(fn ($r) => array_column($r, 0), $rings));
            $lats = array_merge(...array_map(fn ($r) => array_column($r, 1), $rings));
            $shape = self::areaAndCentroid($rings);

            DB::table('barangays')->updateOrInsert(
                ['psgc_code' => (string) ($props['psgc_10d'] ?? $props['brgy_code'] ?? $props['brgy_name'])],
                [
                    'name' => $props['brgy_name'],
                    'city' => $props['city_name'] ?? 'City of Mandaluyong',
                    'srid' => self::SRID,
                    'geom_wkt' => self::multiPolygonWkt($rings),
                    'min_lat' => min($lats),
                    'max_lat' => max($lats),
                    'min_lng' => min($lngs),
                    'max_lng' => max($lngs),
                    'centroid_lat' => round($shape['lat'], 7),
                    'centroid_lng' => round($shape['lng'], 7),
                    'area_km2' => round($shape['area_km2'], 4),
                ]
            );
            $count++;
        }

        self::$polygons = null;

        return $count;
    }

    /** Boundary rings per barangay, parsed once from the stored WKT. */
    private static function polygons(): array
    {
        if (self::$polygons !== null) {
            return self::$polygons;
        }

        self::$polygons = [];
        foreach (DB::table('barangays')->get() as $row) {
            preg_match_all('/\(\(([^()]+)\)\)/', $row->geom_wkt, $matches);
            $rings = array_map(fn ($ring) => array_map(
                fn ($pair) => array_map('floatval', preg_split('/\s+/', trim($pair))),
                explode(',', $ring)
            ), $matches[1]);

            self::$polygons[] = [
                'id' => (int) $row->id,
                'name' => $row->name,
                'bbox' => [(float) $row->min_lat, (float) $row->max_lat, (float) $row->min_lng, (float) $row->max_lng],
                'rings' => $rings,
            ];
        }

        return self::$polygons;
    }

    /**
     * The barangay a point falls inside (bounding box first, then the exact polygon test),
     * or null when it is outside Mandaluyong.
     *
     * @return array{id: int, name: string}|null
     */
    public static function locate(float $lat, float $lng): ?array
    {
        foreach (self::polygons() as $polygon) {
            [$minLat, $maxLat, $minLng, $maxLng] = $polygon['bbox'];
            if ($lat < $minLat || $lat > $maxLat || $lng < $minLng || $lng > $maxLng) {
                continue;
            }
            foreach ($polygon['rings'] as $ring) {
                if (self::inRing($lat, $lng, $ring)) {
                    return ['id' => $polygon['id'], 'name' => $polygon['name']];
                }
            }
        }

        return null;
    }

    /* ------------------------------------------------------------------ incidents */

    /** The spatial columns for one accident, from its coordinates and the barangay named on it. */
    public static function incidentColumns($lat, $lng, ?string $barangay): array
    {
        if (! is_numeric($lat) || ! is_numeric($lng)) {
            return ['geom_wkt' => null, 'geohash' => null, 'barangay_id' => null, 'location_status' => self::NO_LOCATION];
        }

        $lat = (float) $lat;
        $lng = (float) $lng;
        $found = self::locate($lat, $lng);
        $status = $found === null ? self::OUTSIDE_CITY
            : (strcasecmp(trim((string) $barangay), $found['name']) === 0 ? self::INSIDE : self::OTHER_BARANGAY);

        return [
            'geom_wkt' => self::pointWkt($lat, $lng),
            'geohash' => self::geohash($lat, $lng),
            'barangay_id' => $found['id'] ?? null,
            'location_status' => $status,
        ];
    }

    /** Recomputes the spatial columns of every accident, in chunks. Returns how many. */
    public static function syncAllIncidents(): int
    {
        self::$polygons = null;
        $count = 0;

        DB::transaction(function () use (&$count) {
            DB::table('incidents')->select('id', 'lat', 'lng', 'barangay')->orderBy('id')
                ->chunk(1000, function ($rows) use (&$count) {
                    foreach ($rows as $row) {
                        DB::table('incidents')->where('id', $row->id)
                            ->update(self::incidentColumns($row->lat, $row->lng, $row->barangay));
                        $count++;
                    }
                });
        });

        return $count;
    }

    /** The 3×3 block of geohash cells around a point — every cell a nearby point can be in. */
    public static function neighbourCells(float $lat, float $lng, int $precision = self::GEOHASH_PRECISION): array
    {
        // Cell size at this precision, from the bit split (lng gets the extra bit when odd).
        $bits = $precision * 5;
        $lngBits = intdiv($bits + 1, 2);
        $latBits = intdiv($bits, 2);
        $dLat = 180 / (2 ** $latBits);
        $dLng = 360 / (2 ** $lngBits);

        $cells = [];
        foreach ([-1, 0, 1] as $i) {
            foreach ([-1, 0, 1] as $j) {
                $cells[] = self::geohash($lat + $i * $dLat, $lng + $j * $dLng, $precision);
            }
        }

        return array_values(array_unique($cells));
    }

    /**
     * Accidents within `$meters` of a point, nearest first. The geohash index narrows the
     * search to the 3×3 block of cells around the point; the exact haversine distance decides.
     * The block always reaches at least one cell beyond the point, so the cell size is chosen
     * no smaller than the radius: 7 characters (~140 m cells) up to 140 m, 6 (~600 m) up to
     * 600 m, 5 (~4.8 km) up to 4.5 km — beyond that every located accident is checked.
     */
    public static function nearby(float $lat, float $lng, float $meters): array
    {
        $precision = $meters <= 140 ? 7 : ($meters <= 600 ? 6 : ($meters <= 4500 ? 5 : 0));

        $query = Incident::query()->whereNotNull('geohash');
        if ($precision > 0) {
            $cells = self::neighbourCells($lat, $lng, $precision);
            $query->where(function ($q) use ($cells) {
                foreach ($cells as $cell) {
                    $q->orWhere('geohash', 'like', $cell . '%');
                }
            });
        }
        $candidates = $query->get();

        $found = [];
        foreach ($candidates as $incident) {
            $distance = self::distanceMeters($lat, $lng, (float) $incident->lat, (float) $incident->lng);
            if ($distance <= $meters) {
                $found[] = $incident->toApi() + ['distanceMeters' => round($distance, 1)];
            }
        }
        usort($found, fn ($a, $b) => $a['distanceMeters'] <=> $b['distanceMeters']);

        return $found;
    }

    /**
     * Per barangay: accidents whose coordinates fall inside it, accidents per km², and how
     * many records' coordinates disagree with the barangay typed on them — plus city totals
     * per location status. A spatial join through `barangay_id`, not a name match.
     */
    public static function summary(): array
    {
        $statusCounts = DB::table('incidents')->select('location_status', DB::raw('count(*) as n'))
            ->groupBy('location_status')->pluck('n', 'location_status')->all();

        $rows = DB::table('barangays')
            ->leftJoin('incidents', 'incidents.barangay_id', '=', 'barangays.id')
            ->groupBy('barangays.id', 'barangays.name', 'barangays.psgc_code', 'barangays.area_km2', 'barangays.centroid_lat', 'barangays.centroid_lng')
            ->orderBy('barangays.name')
            ->select(
                'barangays.name', 'barangays.psgc_code', 'barangays.area_km2', 'barangays.centroid_lat', 'barangays.centroid_lng',
                DB::raw('count(incidents.id) as accidents'),
                DB::raw("sum(case when incidents.location_status = '" . self::OTHER_BARANGAY . "' then 1 else 0 end) as labelled_elsewhere")
            )
            ->get();

        $barangays = $rows->map(fn ($row) => [
            'barangay' => $row->name,
            'psgcCode' => $row->psgc_code,
            'areaKm2' => (float) $row->area_km2,
            'centroid' => ['lat' => (float) $row->centroid_lat, 'lng' => (float) $row->centroid_lng],
            'accidentsInside' => (int) $row->accidents,
            'accidentsPerKm2' => $row->area_km2 > 0 ? round($row->accidents / $row->area_km2, 1) : null,
            'recordsNamingAnotherBarangay' => (int) $row->labelled_elsewhere,
        ])->all();

        return [
            'srid' => self::SRID,
            'geohashPrecision' => self::GEOHASH_PRECISION,
            'locationStatus' => [
                self::INSIDE => (int) ($statusCounts[self::INSIDE] ?? 0),
                self::OTHER_BARANGAY => (int) ($statusCounts[self::OTHER_BARANGAY] ?? 0),
                self::OUTSIDE_CITY => (int) ($statusCounts[self::OUTSIDE_CITY] ?? 0),
                self::NO_LOCATION => (int) ($statusCounts[self::NO_LOCATION] ?? 0),
            ],
            'barangays' => $barangays,
        ];
    }
}
