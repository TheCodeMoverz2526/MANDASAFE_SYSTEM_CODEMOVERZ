<?php

/*
|--------------------------------------------------------------------------
| Router for PHP's built-in web server
|--------------------------------------------------------------------------
|
| Used by `php artisan serve` (which picks up a server.php in the app root) and by
| start-mandasafe.bat. PHP's built-in server answers one request at a time, and a single
| MandaSafe page asks for a dozen files, so booting Laravel for each stylesheet and image
| made every page wait in line. The MandaSafe pages and assets are plain files, so they are
| sent straight from disk here — with an ETag so the browser can reuse its copy, and gzip
| for text — and only /api/... calls go on to Laravel.
|
| The rules mirror StaticSiteController, which still serves the pages under any other web
| server (Apache, nginx) and handles whatever this file passes on.
|
*/

$publicPath = __DIR__ . '/public';
$uri = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '');

// Files in laravel/public (favicon.ico, robots.txt) — let the built-in server send them.
if ($uri !== '/' && is_file($publicPath . $uri)) {
    return false;
}

$serveStatic = function (string $uri): bool {
    if (! in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
        return false;
    }

    $requested = trim($uri, '/');
    if ($requested === 'api' || str_starts_with($requested, 'api/') || $requested === 'up') {
        return false;
    }

    // A custom front-end root is a Laravel config value; let Laravel resolve it.
    $env = @file_get_contents(__DIR__ . '/.env') ?: '';
    if (getenv('MANDASAFE_FRONTEND_ROOT') !== false || preg_match('/^\s*MANDASAFE_FRONTEND_ROOT\s*=/m', $env)) {
        return false;
    }

    $root = realpath(dirname(__DIR__));
    if ($root === false) {
        return false;
    }
    if ($requested === '') {
        $requested = 'index.html';
    }

    // Nothing inside the Laravel app (.env, the database, vendor/) is web content, and
    // neither are dotfiles — leave those to Laravel, which answers 403.
    $firstSegment = strtolower(strtok($requested, '/'));
    if ($firstSegment === strtolower(basename(__DIR__)) || str_starts_with($firstSegment, '.')) {
        return false;
    }

    $filePath = realpath($root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $requested));
    if ($filePath === false || ! is_file($filePath) || ! str_starts_with($filePath, $root . DIRECTORY_SEPARATOR)) {
        return false;
    }

    $types = [
        'css' => 'text/css', 'html' => 'text/html', 'js' => 'application/javascript',
        'json' => 'application/json', 'geojson' => 'application/json', 'svg' => 'image/svg+xml',
        'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'ico' => 'image/x-icon',
        'webp' => 'image/webp', 'woff' => 'font/woff', 'woff2' => 'font/woff2',
        'csv' => 'text/csv', 'txt' => 'text/plain',
    ];
    $textTypes = ['css', 'html', 'js', 'json', 'geojson', 'svg', 'csv', 'txt'];

    $extension = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
    $isText = in_array($extension, $textTypes, true);
    $contentType = ($types[$extension] ?? 'application/octet-stream') . ($isText ? '; charset=utf-8' : '');

    $mtime = filemtime($filePath);
    $size = filesize($filePath);
    $etag = '"' . dechex($mtime) . '-' . dechex($size) . '"';

    header('Content-Type: ' . $contentType);
    header('ETag: ' . $etag);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
    header('Vary: Accept-Encoding');
    // Pages, scripts and styles are re-checked on every load (a cheap 304 when unchanged), so
    // an edit shows up straight away. Images, fonts and the bundled Leaflet rarely change.
    header($isText && ! str_starts_with($requested, 'vendor/')
        ? 'Cache-Control: no-cache'
        : 'Cache-Control: public, max-age=86400');

    $ifNoneMatch = $_SERVER['HTTP_IF_NONE_MATCH'] ?? '';
    if ($ifNoneMatch !== '' && in_array($etag, array_map('trim', explode(',', $ifNoneMatch)), true)) {
        http_response_code(304);

        return true;
    }

    $body = file_get_contents($filePath);
    if ($isText && $size > 1024 && str_contains($_SERVER['HTTP_ACCEPT_ENCODING'] ?? '', 'gzip')) {
        $body = gzencode($body, 6);
        header('Content-Encoding: gzip');
    }
    header('Content-Length: ' . strlen($body));
    if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') {
        echo $body;
    }

    return true;
};

if ($serveStatic($uri)) {
    return true;
}

require_once $publicPath . '/index.php';
