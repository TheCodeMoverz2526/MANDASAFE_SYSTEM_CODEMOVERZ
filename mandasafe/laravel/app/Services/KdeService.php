<?php

namespace App\Services;

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
     */
    public static function findHotspots(array $records, array $bounds, array $options = []): array
    {
        if ($records === []) {
            return [];
        }

        return MlBridge::run('hotspots.py', [
            'records' => $records,
            'bounds' => $bounds,
            'options' => $options,
        ]);
    }
}
