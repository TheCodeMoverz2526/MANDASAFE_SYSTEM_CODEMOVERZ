<?php

namespace App\Console\Commands;

use App\Services\SpatialService;
use Illuminate\Console\Command;

/**
 * Reloads the 27 barangay boundaries into the `barangays` table from the official GeoJSON and
 * recomputes every accident's spatial columns (POINT, geohash, located barangay, status).
 * Run it after replacing the boundary file or after writing incidents outside the app.
 */
class SpatialSync extends Command
{
    protected $signature = 'mandasafe:spatial-sync';

    protected $description = 'Reload barangay boundaries and recompute every accident\'s spatial columns';

    public function handle(): int
    {
        $barangays = SpatialService::seedBarangays();
        $this->line("  barangays   {$barangays} boundaries loaded");

        $started = microtime(true);
        $incidents = SpatialService::syncAllIncidents();
        $this->line(sprintf('  incidents   %d located in %.1f s', $incidents, microtime(true) - $started));

        foreach (SpatialService::summary()['locationStatus'] as $status => $count) {
            $this->line(sprintf('    %-15s %d', $status, $count));
        }

        $this->info('Spatial data in sync.');

        return self::SUCCESS;
    }
}
