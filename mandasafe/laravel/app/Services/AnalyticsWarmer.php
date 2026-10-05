<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Starts `php artisan mandasafe:warm` in the background after the data changes, so the
 * forecasts, hotspots and other models are recomputed before the next visitor needs them.
 *
 * The process is launched once the current response has been sent (a terminating callback;
 * under PHP-FPM the visitor's connection is already closed by then), which also means every
 * database write of the request has committed before the warm reads the data. Several writes
 * in a row just start several processes; the command holds a lock, so only one does the work
 * and it repeats until it has caught up with the newest data.
 *
 * Disabled in tests (MANDASAFE_BACKGROUND_WARM=false), where every figure must be fresh.
 */
class AnalyticsWarmer
{
    /** Set while the warm command runs, so it computes instead of serving the stale result. */
    public static bool $warming = false;

    private static bool $scheduled = false;

    public static function enabled(): bool
    {
        return (bool) config('mandasafe.background_warm', true)
            && (int) config('mandasafe.analytics_cache_seconds') > 0;
    }

    /** Ask for a warm once this request is over. Safe to call any number of times. */
    public static function kick(): void
    {
        if (! self::enabled() || self::$warming || self::$scheduled) {
            return;
        }
        self::$scheduled = true;

        app()->terminating(static function () {
            self::$scheduled = false;
            self::launch();
        });
    }

    private static function launch(): void
    {
        try {
            $php = self::phpCli();
            $artisan = base_path('artisan');

            if (PHP_OS_FAMILY === 'Windows') {
                $command = 'start "" /B ' . escapeshellarg($php) . ' ' . escapeshellarg($artisan) . ' mandasafe:warm > NUL 2>&1';
                $handle = popen($command, 'r');
                if ($handle !== false) {
                    pclose($handle);
                }

                return;
            }

            exec(escapeshellarg($php) . ' ' . escapeshellarg($artisan) . ' mandasafe:warm > /dev/null 2>&1 &');
        } catch (Throwable $e) {
            // Not fatal: the next visitor's request computes the figures itself instead.
            Log::warning('Could not start the background analytics warm', ['error' => $e->getMessage()]);
        }
    }

    /**
     * The command-line PHP. Under PHP-FPM, PHP_BINARY is the FPM daemon, which cannot run
     * artisan, so the CLI is taken from MANDASAFE_PHP_CLI (default: "php" on the PATH).
     */
    private static function phpCli(): string
    {
        if (in_array(PHP_SAPI, ['cli', 'cli-server'], true) && PHP_BINARY !== '') {
            return PHP_BINARY;
        }

        return (string) config('mandasafe.php_cli', 'php');
    }
}
