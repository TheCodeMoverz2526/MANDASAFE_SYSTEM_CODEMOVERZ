<?php

namespace App\Console\Commands;

use App\Services\AnalyticsService;
use Illuminate\Console\Command;

/**
 * Hosts without Python (Vercel's PHP runtime) cannot run ml/prone_area_forest.py, so the
 * prone-area prediction is computed on a machine that can and saved into the app, where
 * AnalyticsService::proneAreas() serves it whenever the live model cannot run. Re-run this
 * and redeploy after importing new accident data.
 */
class SnapshotProneAreas extends Command
{
    protected $signature = 'mandasafe:snapshot-prone-areas';

    protected $description = 'Run the prone-area model locally and save its result for hosts without Python';

    public function handle(AnalyticsService $analytics): int
    {
        $result = $analytics->runProneAreaModel();
        if (empty($result['trained'])) {
            $this->error('The model did not train: ' . ($result['reason'] ?? 'unknown reason'));

            return self::FAILURE;
        }

        $result['model']['snapshotAt'] = now()->toDateString();
        $path = AnalyticsService::proneAreaSnapshotPath();
        if (! is_dir(dirname($path))) {
            mkdir(dirname($path), 0755, true);
        }
        file_put_contents($path, json_encode($result));
        $this->info('Saved ' . count($result['cells'] ?? []) . ' cells to ' . $path);

        return self::SUCCESS;
    }
}
