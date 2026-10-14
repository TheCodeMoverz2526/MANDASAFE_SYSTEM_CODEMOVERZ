<?php

namespace App\Services;

/**
 * Shared spatial helpers: barangay centroids + incident coordinate resolution, used by both
 * the KDE hotspot engine and the prediction module. Port of the old geo.js.
 *
 * The boundaries are read once per process and memoised, exactly as the Node version did.
 */
class GeoService
{
    private static ?array $centroids = null;
    private static ?array $bounds = null;
    private static array $polygons = [];

    /** The outer ring(s) of a Polygon / MultiPolygon as lists of [lng, lat]; holes are ignored. */
    private static function outerRings(array $geometry): array
    {
        $coordinates = $geometry['coordinates'] ?? [];

        return match ($geometry['type'] ?? null) {
            'Polygon' => isset($coordinates[0]) ? [$coordinates[0]] : [],
            'MultiPolygon' => array_values(array_filter(array_map(fn ($polygon) => $polygon[0] ?? null, $coordinates))),
            default => [],
        };
    }

    /** @return array<string, array<int, array<int, array{0: float, 1: float}>>> barangay => outer rings */
    public static function barangayPolygons(): array
    {
        self::load();

        return self::$polygons;
    }

    /** Flattens any GeoJSON coordinate nesting down to a flat list of [lng, lat] pairs. */
    private static function walkCoordinates($node, array &$points): void
    {
        if (! is_array($node) || $node === []) {
            return;
        }

        if (is_numeric($node[0] ?? null) && is_numeric($node[1] ?? null)) {
            $points[] = [(float) $node[0], (float) $node[1]];

            return;
        }

        foreach ($node as $child) {
            self::walkCoordinates($child, $points);
        }
    }

    private static function load(): void
    {
        if (self::$centroids !== null && self::$bounds !== null) {
            return;
        }

        self::$centroids = [];
        $minLat = INF;
        $maxLat = -INF;
        $minLng = INF;
        $maxLng = -INF;

        $path = config('mandasafe.geojson');
        $raw = is_string($path) && is_file($path) ? file_get_contents($path) : false;
        $geojson = $raw === false ? null : json_decode($raw, true);

        foreach ($geojson['features'] ?? [] as $feature) {
            $points = [];
            self::walkCoordinates($feature['geometry']['coordinates'] ?? [], $points);
            if ($points === []) {
                continue;
            }

            $sumLng = 0.0;
            $sumLat = 0.0;
            foreach ($points as [$lng, $lat]) {
                $sumLng += $lng;
                $sumLat += $lat;
                $minLat = min($minLat, $lat);
                $maxLat = max($maxLat, $lat);
                $minLng = min($minLng, $lng);
                $maxLng = max($maxLng, $lng);
            }

            $name = $feature['properties']['brgy_name'] ?? null;
            if ($name !== null) {
                self::$centroids[$name] = [
                    'lat' => $sumLat / count($points),
                    'lng' => $sumLng / count($points),
                ];
                self::$polygons[$name] = self::outerRings($feature['geometry'] ?? []);
            }
        }

        // Boundary file missing or unreadable — fall back to the city's bounding box so the
        // hotspot grid still has somewhere sensible to sit.
        self::$bounds = is_finite($minLat)
            ? ['minLat' => $minLat, 'maxLat' => $maxLat, 'minLng' => $minLng, 'maxLng' => $maxLng]
            : ['minLat' => 14.55, 'maxLat' => 14.61, 'minLng' => 121.00, 'maxLng' => 121.06];
    }

    /** @return array<string, array{lat: float, lng: float}> */
    public static function barangayCentroids(): array
    {
        self::load();

        return self::$centroids;
    }

    /** @return array{minLat: float, maxLat: float, minLng: float, maxLng: float} */
    public static function mandaluyongBounds(): array
    {
        self::load();

        return self::$bounds;
    }

    /**
     * Resolves a usable [lat, lng] for an incident: its own coordinates if present, otherwise
     * its barangay's centroid. Returns null if neither is available.
     */
    public static function resolveIncidentPoint(array $incident): ?array
    {
        $lat = is_numeric($incident['lat'] ?? null) ? (float) $incident['lat'] : null;
        $lng = is_numeric($incident['lng'] ?? null) ? (float) $incident['lng'] : null;

        // Coordinates outside the city are treated like missing ones. The data has a pile of
        // 232 records from 23 different barangays sharing one point in Quezon City (a
        // placeholder), which otherwise shows up as a fake hotspot and drags every density
        // figure toward it. A small margin keeps accidents on the boundary roads.
        if ($lat !== null && $lng !== null && is_finite($lat) && is_finite($lng) && self::insideCity($lat, $lng)) {
            return ['lat' => $lat, 'lng' => $lng];
        }

        $centroid = self::barangayCentroids()[$incident['barangay'] ?? ''] ?? null;

        return $centroid ? ['lat' => $centroid['lat'], 'lng' => $centroid['lng']] : null;
    }

    /** Within Mandaluyong's bounding box, give or take about 300 m. */
    private static function insideCity(float $lat, float $lng): bool
    {
        $b = self::mandaluyongBounds();
        $margin = 0.003;

        return $lat >= $b['minLat'] - $margin && $lat <= $b['maxLat'] + $margin
            && $lng >= $b['minLng'] - $margin && $lng <= $b['maxLng'] + $margin;
    }
}
