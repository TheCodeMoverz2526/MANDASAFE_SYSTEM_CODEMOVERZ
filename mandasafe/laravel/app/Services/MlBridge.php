<?php

namespace App\Services;

use Illuminate\Support\Facades\Process;
use RuntimeException;

/**
 * All of MandaSafe's actual model training/inference (the severity Random Forest, the KDE
 * hotspot surface) lives in Python (scikit-learn) now -- see ml/, one level above this Laravel
 * app. This shells out to the configured interpreter, feeding a script JSON on stdin and
 * parsing the JSON it prints back on stdout.
 */
class MlBridge
{
    public static function run(string $script, array $payload): array
    {
        $python = config('mandasafe.python_bin');
        $scriptPath = config('mandasafe.ml_root') . DIRECTORY_SEPARATOR . $script;

        $result = Process::input(json_encode($payload))
            ->env(self::pythonEnvironment())
            ->timeout(120)
            ->run([$python, $scriptPath]);

        if (! $result->successful()) {
            throw new RuntimeException("ML script {$script} failed: " . $result->errorOutput());
        }

        $decoded = json_decode($result->output(), true);
        if (! is_array($decoded)) {
            throw new RuntimeException("ML script {$script} returned invalid JSON.");
        }

        return $decoded;
    }

    /**
     * `php artisan serve` on Windows hands the web process only a short list of environment
     * variables, and SYSTEMROOT is not among them. Without it Python cannot load Windows'
     * networking layer, so `import sklearn` dies with "WinError 10106" and every prediction
     * silently falls back to the heuristic. These are put back explicitly.
     */
    private static function pythonEnvironment(): array
    {
        if (PHP_OS_FAMILY !== 'Windows') {
            return [];
        }

        $systemRoot = getenv('SYSTEMROOT') ?: getenv('SystemRoot') ?: getenv('WINDIR') ?: 'C:\\Windows';
        $temp = getenv('TEMP') ?: getenv('TMP') ?: sys_get_temp_dir();

        return array_filter([
            'SYSTEMROOT' => $systemRoot,
            'WINDIR' => getenv('WINDIR') ?: $systemRoot,
            'TEMP' => $temp,
            'TMP' => $temp,
            'PATH' => getenv('PATH') ?: $systemRoot . '\\System32;' . $systemRoot,
            'USERPROFILE' => getenv('USERPROFILE') ?: null,
            'APPDATA' => getenv('APPDATA') ?: null,
            'LOCALAPPDATA' => getenv('LOCALAPPDATA') ?: null,
            // Keep the JSON on stdout plain UTF-8 whatever the console code page is.
            'PYTHONIOENCODING' => 'utf-8',
        ], fn ($value) => $value !== null && $value !== false && $value !== '');
    }
}
