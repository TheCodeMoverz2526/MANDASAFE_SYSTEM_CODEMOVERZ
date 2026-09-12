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

        $result = Process::input(json_encode($payload))->run([$python, $scriptPath]);

        if (! $result->successful()) {
            throw new RuntimeException("ML script {$script} failed: " . $result->errorOutput());
        }

        $decoded = json_decode($result->output(), true);
        if (! is_array($decoded)) {
            throw new RuntimeException("ML script {$script} returned invalid JSON.");
        }

        return $decoded;
    }
}
