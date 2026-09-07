<?php

namespace App\Console\Commands;

use App\Services\AnalyticsService;
use Illuminate\Console\Command;

/**
 * The forecasts and the KDE hotspot surface are the only genuinely heavy work in MandaSafe,
 * and they only change when the data does. Running this after an import means the first
 * person to open a page gets it instantly instead of paying for the first computation.
 */
class WarmAnalytics extends Command
{
    protected $signature = 'mandasafe:warm';

    protected $description = 'Compute and cache the predictions, stats, hotspots and summary';

    public function handle(AnalyticsService $analytics): int
    {
        foreach (['predictions', 'stats', 'hotspots', 'summary'] as $name) {
            $started = microtime(true);
            $result = $analytics->{$name}();
            $this->line(sprintf(
                '  %-12s %6.0f ms  (%d %s)',
                $name,
                (microtime(true) - $started) * 1000,
                is_array($result) ? count($result) : 1,
                is_array($result) && array_is_list($result) ? 'rows' : 'fields'
            ));
        }

        $this->info('Analytics cache warm.');

        return self::SUCCESS;
    }
}
