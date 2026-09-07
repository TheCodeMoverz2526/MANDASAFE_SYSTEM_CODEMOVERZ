<?php

namespace App\Services;

/**
 * 2D Gaussian Kernel Density Estimation over incident coordinates, projected to a local
 * meter-space so the kernel is isotropic in real distance rather than raw lat/lng degrees.
 * Used to find genuine spatial hotspots (density peaks) instead of a raw road-count.
 * Port of kde.js.
 */
class KdeService
{
    private const METERS_PER_DEG_LAT = 111320;

    private static function project(float $lat, float $lng, float $originLat, float $originLng): array
    {
        $cosLat = cos($originLat * M_PI / 180);

        return [
            'x' => ($lng - $originLng) * self::METERS_PER_DEG_LAT * $cosLat,
            'y' => ($lat - $originLat) * self::METERS_PER_DEG_LAT,
        ];
    }

    /**
     * Silverman's rule of thumb, weighted by an effective sample size (sum(w)^2 / sum(w^2))
     * so heavily-weighted points (e.g. fatal incidents) do not understate the bandwidth.
     */
    public static function silvermanBandwidth(array $values, array $weights): float
    {
        $n = count($values);
        if ($n < 2) {
            return 150.0; // fallback: ~1.5 city blocks, avoids a degenerate zero-width kernel
        }

        $sumW = array_sum($weights);
        $mean = 0.0;
        foreach ($values as $i => $value) {
            $mean += $value * $weights[$i];
        }
        $mean /= $sumW;

        $variance = 0.0;
        $sumWSquared = 0.0;
        foreach ($values as $i => $value) {
            $variance += $weights[$i] * ($value - $mean) ** 2;
            $sumWSquared += $weights[$i] ** 2;
        }
        $variance /= $sumW;

        $std = sqrt(max($variance, 1e-6));
        $effectiveN = max(2, ($sumW * $sumW) / $sumWSquared);
        $h = 1.06 * $std * $effectiveN ** (-1 / 5);

        return max($h, 40.0); // never collapse below ~40m — keeps the surface smooth at city scale
    }

    /**
     * @param  array  $records  [['lat' => .., 'lng' => .., 'weight' => .., 'ref' => incident], ...]
     * @param  array  $bounds  ['minLat' => .., 'maxLat' => .., 'minLng' => .., 'maxLng' => ..]
     */
    public static function findHotspots(array $records, array $bounds, array $options = []): array
    {
        $gridSize = $options['gridSize'] ?? 36;
        $topN = $options['topN'] ?? 8;
        $minSeparationMeters = $options['minSeparationMeters'] ?? 400;
        $minRelativeDensity = $options['minRelativeDensity'] ?? 0.12;
        $sampleRadiusMeters = $options['sampleRadiusMeters'] ?? 260;

        if ($records === []) {
            return [];
        }

        $originLat = ($bounds['minLat'] + $bounds['maxLat']) / 2;
        $originLng = ($bounds['minLng'] + $bounds['maxLng']) / 2;

        $px = [];
        $py = [];
        $weights = [];
        foreach ($records as $record) {
            $point = self::project((float) $record['lat'], (float) $record['lng'], $originLat, $originLng);
            $px[] = $point['x'];
            $py[] = $point['y'];
            $weights[] = max($record['weight'], 0.01);
        }
        $sumW = array_sum($weights);

        $hx = self::silvermanBandwidth($px, $weights);
        $hy = self::silvermanBandwidth($py, $weights);

        // Incidents without their own coordinates fall back to their barangay centroid, so
        // thousands of records collapse onto a couple of dozen distinct points. Summing their
        // weights per point gives the identical density sum for a fraction of the work.
        $merged = [];
        foreach ($px as $i => $x) {
            $key = $x . ',' . $py[$i];
            if (! isset($merged[$key])) {
                $merged[$key] = ['x' => $x, 'y' => $py[$i], 'w' => 0.0];
            }
            $merged[$key]['w'] += $weights[$i];
        }
        $mx = array_column($merged, 'x');
        $my = array_column($merged, 'y');
        $mw = array_column($merged, 'w');
        $pointCount = count($mx);

        $padLat = ($bounds['maxLat'] - $bounds['minLat']) * 0.04;
        $padLng = ($bounds['maxLng'] - $bounds['minLng']) * 0.04;
        $latStep = ($bounds['maxLat'] - $bounds['minLat'] + $padLat * 2) / $gridSize;
        $lngStep = ($bounds['maxLng'] - $bounds['minLng'] + $padLng * 2) / $gridSize;

        // gaussian(ux) * gaussian(uy) == exp(-0.5 * (ux^2 + uy^2)) / (2 * pi)
        $norm = 1 / (2 * M_PI * $sumW * $hx * $hy);

        $cells = [];
        $maxDensity = 0.0;
        for ($i = 0; $i <= $gridSize; $i++) {
            $lat = $bounds['minLat'] - $padLat + $i * $latStep;
            for ($j = 0; $j <= $gridSize; $j++) {
                $lng = $bounds['minLng'] - $padLng + $j * $lngStep;
                $point = self::project($lat, $lng, $originLat, $originLng);
                $x = $point['x'];
                $y = $point['y'];

                $total = 0.0;
                for ($k = 0; $k < $pointCount; $k++) {
                    $ux = ($x - $mx[$k]) / $hx;
                    $uy = ($y - $my[$k]) / $hy;
                    $total += $mw[$k] * exp(-0.5 * ($ux * $ux + $uy * $uy));
                }

                $density = $total * $norm;
                if ($density > $maxDensity) {
                    $maxDensity = $density;
                }
                $cells[] = ['lat' => $lat, 'lng' => $lng, 'x' => $x, 'y' => $y, 'density' => $density];
            }
        }

        if ($maxDensity <= 0) {
            return [];
        }

        usort($cells, fn ($a, $b) => $b['density'] <=> $a['density']);

        $hotspots = [];
        foreach ($cells as $cell) {
            if ($cell['density'] / $maxDensity < $minRelativeDensity) {
                break;
            }
            if (count($hotspots) >= $topN) {
                break;
            }

            $tooClose = false;
            foreach ($hotspots as $hotspot) {
                if (hypot($hotspot['x'] - $cell['x'], $hotspot['y'] - $cell['y']) < $minSeparationMeters) {
                    $tooClose = true;
                    break;
                }
            }
            if ($tooClose) {
                continue;
            }

            $roadCounts = [];
            $barangayCounts = [];
            $nearbyCount = 0;
            $fatalCount = 0;
            foreach ($records as $index => $record) {
                if (hypot($px[$index] - $cell['x'], $py[$index] - $cell['y']) > $sampleRadiusMeters) {
                    continue;
                }
                $nearbyCount++;
                $road = $record['ref']['road'] ?? 'Unknown';
                $barangay = $record['ref']['barangay'] ?? 'Unknown';
                $roadCounts[$road] = ($roadCounts[$road] ?? 0) + 1;
                $barangayCounts[$barangay] = ($barangayCounts[$barangay] ?? 0) + 1;
                if (($record['ref']['sev'] ?? null) === 'Fatal') {
                    $fatalCount++;
                }
            }
            if ($nearbyCount === 0) {
                continue;
            }

            arsort($roadCounts);
            arsort($barangayCounts);

            $hotspots[] = [
                'lat' => $cell['lat'],
                'lng' => $cell['lng'],
                'x' => $cell['x'],
                'y' => $cell['y'],
                'density' => $cell['density'],
                'intensity' => round(($cell['density'] / $maxDensity) * 100) / 100,
                'incidentCount' => $nearbyCount,
                'road' => array_key_first($roadCounts) ?? 'Unknown',
                'barangay' => array_key_first($barangayCounts) ?? 'Unknown',
                'fatalCount' => $fatalCount,
            ];
        }

        // When many incidents share the exact same fallback (barangay-centroid) coordinates,
        // the kernel's spread can still surface more than one grid peak for the same road —
        // collapse those down to the single strongest peak per road/barangay pair.
        $byLocation = [];
        foreach ($hotspots as $hotspot) {
            $key = $hotspot['barangay'] . '||' . $hotspot['road'];
            if (! isset($byLocation[$key]) || $hotspot['density'] > $byLocation[$key]['density']) {
                $byLocation[$key] = $hotspot;
            }
        }

        $result = array_values($byLocation);
        usort($result, fn ($a, $b) => $b['density'] <=> $a['density']);

        return array_map(function ($hotspot) {
            unset($hotspot['x'], $hotspot['y']);

            return $hotspot;
        }, $result);
    }
}
