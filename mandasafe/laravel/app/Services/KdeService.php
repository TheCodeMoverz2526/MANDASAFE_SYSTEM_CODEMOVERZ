<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Finds genuine spatial hotspots (density peaks) instead of a raw road-count, via a 2D Gaussian
 * Kernel Density Estimate over incident coordinates. The KDE itself -- projection to meter-space,
 * cross-validated bandwidth selection and the density surface -- is computed by scikit-learn in
 * ml/hotspots.py; see that file for the algorithm. This just hands it the records.
 */
class KdeService
{
    /**
     * @param  array  $records  [['lat' => .., 'lng' => .., 'weight' => .., 'ref' => incident], ...]
     * @param  array  $bounds  ['minLat' => .., 'maxLat' => .., 'minLng' => .., 'maxLng' => ..]
     * @param  bool  $degraded  set true when the empty/fallback result came from a failure
     *                          (Python crashed, subprocess flaked) rather than a real "no
     *                          hotspots" answer -- callers use this to avoid caching a transient
     *                          hiccup as if it were the correct answer for a full day.
     */
    public static function findHotspots(array $records, array $bounds, array $options = [], bool &$degraded = false): array
    {
        $degraded = false;

        if ($records === []) {
            return [];
        }

        try {
            return MlBridge::run('hotspots.py', [
                'records' => $records,
                'bounds' => $bounds,
                'options' => $options,
            ]);
        } catch (Throwable $e) {
            // No Python here (the hosted site has none) or it failed: compute the same KDE in
            // PHP instead of showing an empty map with every barangay at 0%.
            Log::warning('hotspots.py unavailable, using the PHP KDE', ['error' => $e->getMessage()]);

            try {
                return self::findHotspotsInPhp($records, $bounds, $options);
            } catch (Throwable $fallbackError) {
                Log::warning('PHP KDE failed, returning no hotspots', ['error' => $fallbackError->getMessage()]);
                $degraded = true;

                return [];
            }
        }
    }

    private const METERS_PER_DEG_LAT = 111320.0;

    /**
     * The same Gaussian KDE as ml/hotspots.py, in plain PHP, with the same output: the top
     * well-separated density peaks, and (withBarangays) every barangay's heat, intensity and
     * map spot. Two differences keep it fast enough without numpy:
     *
     *  - The bandwidth comes from Silverman's rule (weighted, isotropic) instead of a
     *    cross-validated search, kept between 40 m and 1 km like the search's candidates.
     *  - Accidents are merged onto a grid of bandwidth/4 before the density is summed. Points
     *    that close together change the density by well under 1%, and thousands of records
     *    become a few hundred or thousand distinct points.
     */
    private static function findHotspotsInPhp(array $records, array $bounds, array $options): array
    {
        $gridSize = (int) ($options['gridSize'] ?? 36);
        $topN = (int) ($options['topN'] ?? 8);
        $minSeparation = (float) ($options['minSeparationMeters'] ?? 400);
        $minRelativeDensity = (float) ($options['minRelativeDensity'] ?? 0.12);
        $sampleRadius = (float) ($options['sampleRadiusMeters'] ?? 260);

        $originLat = ($bounds['minLat'] + $bounds['maxLat']) / 2;
        $originLng = ($bounds['minLng'] + $bounds['maxLng']) / 2;
        $cosLat = cos(deg2rad($originLat));
        $project = fn (float $lat, float $lng) => [
            ($lng - $originLng) * self::METERS_PER_DEG_LAT * $cosLat,
            ($lat - $originLat) * self::METERS_PER_DEG_LAT,
        ];

        $xs = $ys = $ws = [];
        foreach ($records as $i => $record) {
            [$xs[$i], $ys[$i]] = $project((float) $record['lat'], (float) $record['lng']);
            $ws[$i] = max((float) ($record['weight'] ?? 1), 0.01);
        }
        $h = self::silvermanBandwidth($xs, $ys, $ws);

        // Merge nearby points; each bin sits at its points' weighted centre.
        $step = $h / 4;
        $bins = [];
        $binOf = [];
        foreach ($xs as $i => $x) {
            $key = (int) floor($x / $step) . ':' . (int) floor($ys[$i] / $step);
            $bins[$key] ??= ['x' => 0.0, 'y' => 0.0, 'w' => 0.0];
            $bins[$key]['x'] += $x * $ws[$i];
            $bins[$key]['y'] += $ys[$i] * $ws[$i];
            $bins[$key]['w'] += $ws[$i];
            $binOf[$i] = $key;
        }
        $bx = $by = $bw = [];
        foreach ($bins as $key => $bin) {
            $bx[$key] = $bin['x'] / $bin['w'];
            $by[$key] = $bin['y'] / $bin['w'];
            $bw[$key] = $bin['w'];
        }
        $sumW = array_sum($bw);
        $norm = 1 / (2 * M_PI * $h * $h * $sumW);
        $cutoff = 5 * $h;   // beyond 5 bandwidths a point adds less than 0.0004% of its peak
        $twoH2 = 2 * $h * $h;
        $density = function (float $x, float $y) use ($bx, $by, $bw, $cutoff, $twoH2, $norm): float {
            $total = 0.0;
            foreach ($bx as $key => $px) {
                $dx = $x - $px;
                if ($dx > $cutoff || $dx < -$cutoff) {
                    continue;
                }
                $dy = $y - $by[$key];
                if ($dy > $cutoff || $dy < -$cutoff) {
                    continue;
                }
                $total += $bw[$key] * exp(-($dx * $dx + $dy * $dy) / $twoH2);
            }

            return $total * $norm;
        };

        // The density surface over the city grid, and its peaks.
        $padLat = ($bounds['maxLat'] - $bounds['minLat']) * 0.04;
        $padLng = ($bounds['maxLng'] - $bounds['minLng']) * 0.04;
        $latStep = ($bounds['maxLat'] - $bounds['minLat'] + $padLat * 2) / $gridSize;
        $lngStep = ($bounds['maxLng'] - $bounds['minLng'] + $padLng * 2) / $gridSize;
        $cells = [];
        $maxDensity = 0.0;
        for ($i = 0; $i <= $gridSize; $i++) {
            for ($j = 0; $j <= $gridSize; $j++) {
                $lat = $bounds['minLat'] - $padLat + $i * $latStep;
                $lng = $bounds['minLng'] - $padLng + $j * $lngStep;
                [$x, $y] = $project($lat, $lng);
                $d = $density($x, $y);
                $maxDensity = max($maxDensity, $d);
                $cells[] = ['lat' => $lat, 'lng' => $lng, 'x' => $x, 'y' => $y, 'density' => $d];
            }
        }

        $peaks = [];
        if ($maxDensity > 0) {
            usort($cells, fn ($a, $b) => $b['density'] <=> $a['density']);
            $chosen = [];
            foreach ($cells as $cell) {
                if ($cell['density'] / $maxDensity < $minRelativeDensity || count($chosen) >= $topN) {
                    break;
                }
                foreach ($chosen as [$cx, $cy]) {
                    if (hypot($cell['x'] - $cx, $cell['y'] - $cy) < $minSeparation) {
                        continue 2;
                    }
                }
                $roads = $barangays = [];
                $nearby = $fatal = 0;
                foreach ($xs as $k => $x) {
                    if (hypot($x - $cell['x'], $ys[$k] - $cell['y']) > $sampleRadius) {
                        continue;
                    }
                    $ref = $records[$k]['ref'] ?? [];
                    $roads[$ref['road'] ?? 'Unknown'] = ($roads[$ref['road'] ?? 'Unknown'] ?? 0) + 1;
                    $barangays[$ref['barangay'] ?? 'Unknown'] = ($barangays[$ref['barangay'] ?? 'Unknown'] ?? 0) + 1;
                    $fatal += ($ref['sev'] ?? null) === 'Fatal' ? 1 : 0;
                    $nearby++;
                }
                if ($nearby === 0) {
                    continue;
                }
                arsort($roads);
                arsort($barangays);
                $peaks[] = [
                    'lat' => $cell['lat'], 'lng' => $cell['lng'],
                    'density' => $cell['density'],
                    'intensity' => round($cell['density'] / $maxDensity, 2),
                    'incidentCount' => $nearby,
                    'road' => (string) array_key_first($roads),
                    'barangay' => (string) array_key_first($barangays),
                    'fatalCount' => $fatal,
                    'bandwidthMeters' => round($h, 1),
                ];
                $chosen[] = [$cell['x'], $cell['y']];
            }

            // One peak per road/barangay pair, the strongest, as hotspots.py does.
            $byLocation = [];
            foreach ($peaks as $peak) {
                $key = $peak['barangay'] . '||' . $peak['road'];
                if (! isset($byLocation[$key]) || $peak['density'] > $byLocation[$key]['density']) {
                    $byLocation[$key] = $peak;
                }
            }
            $peaks = array_values($byLocation);
            usort($peaks, fn ($a, $b) => $b['density'] <=> $a['density']);
        }

        if (empty($options['withBarangays'])) {
            return $peaks;
        }

        // Every barangay's heat: the density at each of its accidents, weighted by severity,
        // summed. Its map spot is its densest accident inside its own boundary.
        $binDensity = [];
        foreach (array_keys($bx) as $key) {
            $binDensity[$key] = $density($bx[$key], $by[$key]);
        }
        $boundaries = $options['boundaries'] ?? [];
        $centroids = $options['centroids'] ?? [];
        $ranking = [];
        foreach ($records as $i => $record) {
            $ref = $record['ref'] ?? [];
            $name = $ref['barangay'] ?? 'Unknown';
            $ranking[$name] ??= ['barangay' => $name, 'heat' => 0.0, 'incidentCount' => 0, 'fatalCount' => 0, 'peak' => -1.0, 'lat' => null, 'lng' => null];
            $entry = &$ranking[$name];
            $d = $binDensity[$binOf[$i]];
            $entry['incidentCount']++;
            $entry['heat'] += $d * $ws[$i];
            $entry['fatalCount'] += ($ref['sev'] ?? null) === 'Fatal' ? 1 : 0;
            $rings = $boundaries[$name] ?? null;
            if ((! $rings || self::inside((float) $record['lng'], (float) $record['lat'], $rings)) && $d > $entry['peak']) {
                $entry['peak'] = $d;
                $entry['lat'] = (float) $record['lat'];
                $entry['lng'] = (float) $record['lng'];
            }
            unset($entry);
        }

        $ranking = array_values($ranking);
        usort($ranking, fn ($a, $b) => [$b['heat'], $b['incidentCount']] <=> [$a['heat'], $a['incidentCount']]);
        $topHeat = $ranking !== [] && $ranking[0]['heat'] > 0 ? $ranking[0]['heat'] : 1.0;
        foreach ($ranking as &$b) {
            if ($b['lat'] === null) {
                $b['lat'] = $centroids[$b['barangay']]['lat'] ?? null;
                $b['lng'] = $centroids[$b['barangay']]['lng'] ?? null;
            }
            $b['intensity'] = round($b['heat'] / $topHeat, 4);
            $b['bandwidthMeters'] = round($h, 1);
            unset($b['peak']);
        }
        unset($b);

        return ['peaks' => $peaks, 'barangays' => $ranking];
    }

    /** Weighted Silverman's rule for an isotropic 2-D Gaussian kernel, in metres. */
    private static function silvermanBandwidth(array $xs, array $ys, array $ws): float
    {
        $sumW = array_sum($ws);
        if (count($xs) < 2 || $sumW <= 0) {
            return 150.0;
        }
        $mx = $my = 0.0;
        foreach ($xs as $i => $x) {
            $mx += $x * $ws[$i];
            $my += $ys[$i] * $ws[$i];
        }
        $mx /= $sumW;
        $my /= $sumW;
        $vx = $vy = $sumW2 = 0.0;
        foreach ($xs as $i => $x) {
            $vx += $ws[$i] * ($x - $mx) ** 2;
            $vy += $ws[$i] * ($ys[$i] - $my) ** 2;
            $sumW2 += $ws[$i] ** 2;
        }
        $sigma = sqrt(max(($vx + $vy) / (2 * $sumW), 1e-6));
        $effectiveN = max(2, $sumW * $sumW / $sumW2);
        // 2-D Silverman: n^(-1/6). Kept within the range hotspots.py searches.
        $h = $sigma * $effectiveN ** (-1 / 6);

        return min(max($h, 40.0), 1000.0);
    }

    /** Ray-casting point-in-polygon over a barangay's outer ring(s) of [lng, lat]. */
    private static function inside(float $lng, float $lat, array $rings): bool
    {
        foreach ($rings as $ring) {
            $hit = false;
            $count = count($ring);
            for ($i = 0, $j = $count - 1; $i < $count; $j = $i++) {
                [$xi, $yi] = $ring[$i];
                [$xj, $yj] = $ring[$j];
                if (($yi > $lat) !== ($yj > $lat) && $lng < ($xj - $xi) * ($lat - $yi) / ($yj - $yi) + $xi) {
                    $hit = ! $hit;
                }
            }
            if ($hit) {
                return true;
            }
        }

        return false;
    }
}
