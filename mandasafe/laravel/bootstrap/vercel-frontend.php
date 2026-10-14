<?php

/*
 * Vercel build step (`composer run vercel`, which the PHP runtime calls after installing
 * dependencies). The MandaSafe pages live one level above this app, outside the folder Vercel
 * deploys, so the files the pages load (the same allowlist StaticSiteController serves) are
 * copied into frontend/ and MANDASAFE_FRONTEND_ROOT points there on Vercel.
 */

$source = dirname(__DIR__, 2);
$target = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'frontend';

if (! is_file($source . '/index.html')) {
    fwrite(STDERR, "The MandaSafe pages ({$source}/index.html) are missing. In the Vercel project settings, "
        . "enable \"Include files outside the root directory in the Build Step\".\n");
    exit(1);
}

$copy = static function (string $from, string $to) use (&$copy): void {
    if (is_dir($from)) {
        @mkdir($to, 0755, true);
        foreach (scandir($from) as $name) {
            if ($name !== '.' && $name !== '..') {
                $copy("{$from}/{$name}", "{$to}/{$name}");
            }
        }

        return;
    }
    @mkdir(dirname($to), 0755, true);
    copy($from, $to) || exit("Could not copy {$from}\n");
};

$paths = array_merge(
    array_map('basename', glob($source . '/*.html')),
    ['script.js', 'login.js', 'styles.css', 'assets', 'css', 'js', 'vendor', 'data/mandaluyong-barangays.geojson']
);
foreach ($paths as $path) {
    if (file_exists("{$source}/{$path}")) {
        $copy("{$source}/{$path}", "{$target}/{$path}");
    }
}

echo 'Copied ' . count($paths) . " front-end paths into {$target}\n";
