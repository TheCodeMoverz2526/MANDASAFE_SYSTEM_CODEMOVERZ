<?php

namespace App\Console\Commands;

use App\Models\Setting;
use App\Services\AnalyticsService;
use App\Services\AnalyticsWarmer;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;

/**
 * The forecasts and the KDE hotspot surface are the only genuinely heavy work in MandaSafe,
 * and they only change when the data does. This computes and caches all of them, so the
 * first person to open a page gets it instantly instead of paying for the first computation.
 *
 * Runs by hand after a deploy or import, and in the background after every change to the
 * data (AnalyticsWarmer). Only one copy works at a time; it repeats until the cache matches
 * the newest data, so edits made while it was running are picked up too.
 */
class WarmAnalytics extends Command
{
    protected $signature = 'mandasafe:warm';

    protected $description = 'Compute and cache the predictions, stats, hotspots, summary, prone-area and severity models';

    public function handle(AnalyticsService $analytics): int
    {
        $lock = Cache::lock('mandasafe:warming', 900);
        if (! $lock->get()) {
            $this->line('Another warm is already running; it will pick up the newest data.');

            return self::SUCCESS;
        }

        AnalyticsWarmer::$warming = true;

        try {
            for ($round = 1; $round <= 5; $round++) {
                $version = Setting::dataVersion();

                foreach (['predictions', 'stats', 'hotspots', 'summary', 'proneAreas', 'severityClassification'] as $name) {
                    $started = microtime(true);
                    $result = $analytics->{$name}();
                    $this->line(sprintf(
                        '  %-22s %6.0f ms  (%d %s)',
                        $name,
                        (microtime(true) - $started) * 1000,
                        is_array($result) ? count($result) : 1,
                        is_array($result) && array_is_list($result) ? 'rows' : 'fields'
                    ));
                }

                // The data may have changed while the models ran (Setting reads the database).
                if (Setting::dataVersion() === $version) {
                    break;
                }
                $this->line('  The data changed while warming; warming again.');
            }
        } finally {
            AnalyticsWarmer::$warming = false;
            $lock->release();
        }

        $this->info('Analytics cache warm.');

        return self::SUCCESS;
    }
}
