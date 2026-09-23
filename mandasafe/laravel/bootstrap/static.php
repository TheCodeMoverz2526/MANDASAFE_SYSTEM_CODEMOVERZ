<?php

/**
 * Serves the MandaSafe pages and assets WITHOUT booting Laravel.
 *
 * Every page pulls in eight or so plain files — the HTML, css/style.css, the three
 * js/ files, Leaflet's js and css, the seal — and each one used to travel the full
 * framework route: Composer's autoloader, the container, the service providers, the
 * router, only to end in readfile(). On this machine that cost ~320ms per file no
 * matter how small it was (OPcache is off, so PHP recompiles the framework from disk
 * every request), and `php artisan serve` answers one request at a time, so a single
 * page spent seconds serving files that never needed PHP at all.
 *
 * This runs before the autoloader. A request that resolves to a readable static file
 * is answered here and the boot never happens; everything else — /api/..., anything
 * missing, anything suspicious — returns false and falls through to Laravel unchanged.
 *
 * It mirrors StaticSiteController, which stays as the fallback for a server that
 * routes differently. Keep the two in step: same root, same guards, same MIME table.
 *
 * @return bool true when the request has been answered in full
 */
return (static function (): bool {
    // Only ever a read. Anything else is the application's business.
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'HEAD') {
        return false;
    }

    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if (! is_string($path)) {
        return false;
    }
    $requested = trim(rawurldecode($path), '/');

    // An unmatched /api/... path is a client mistake and Laravel says so properly.
    if ($requested === 'api' || str_starts_with($requested, 'api/')) {
        return false;
    }

    if ($requested === '') {
        $requested = 'index.html';
    }

    // Mirrors config('mandasafe.frontend_root'): the pages sit one level above the
    // Laravel app. Reading .env here would mean parsing it before the framework
    // exists, so only a real environment variable is honoured; a MANDASAFE_FRONTEND_ROOT
    // set in .env alone still works, just through Laravel's slower path.
    $root = realpath(getenv('MANDASAFE_FRONTEND_ROOT') ?: dirname(__DIR__, 2));
    if ($root === false) {
        return false;
    }

    // The Laravel app lives under the site root; nothing inside it (.env, the database,
    // vendor/) is web content, and neither are dotfiles.
    $firstSegment = strtolower(strtok($requested, '/'));
    if ($firstSegment === strtolower(basename(dirname(__DIR__))) || str_starts_with($firstSegment, '.')) {
        return false;
    }

    $filePath = realpath($root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $requested));
    if ($filePath === false || ! is_file($filePath) || ! is_readable($filePath)) {
        return false;
    }
    if (! str_starts_with($filePath, $root . DIRECTORY_SEPARATOR)) {
        return false;
    }

    $types = [
        'css' => 'text/css',
        'html' => 'text/html',
        'js' => 'application/javascript',
        'json' => 'application/json',
        'svg' => 'image/svg+xml',
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'geojson' => 'application/json',
        'ico' => 'image/x-icon',
        'webp' => 'image/webp',
        'woff' => 'font/woff',
        'woff2' => 'font/woff2',
        'csv' => 'text/csv',
        'txt' => 'text/plain',
    ];
    $textTypes = ['css', 'html', 'js', 'json', 'geojson', 'svg', 'csv', 'txt'];

    $extension = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));

    // An unknown extension is not obviously web content — let Laravel decide.
    if (! isset($types[$extension])) {
        return false;
    }

    $contentType = $types[$extension] . (in_array($extension, $textTypes, true) ? '; charset=utf-8' : '');

    $size = filesize($filePath);
    $modified = filemtime($filePath);
    $etag = '"' . dechex($modified) . '-' . dechex($size) . '"';

    header('Content-Type: ' . $contentType);
    header('ETag: ' . $etag);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $modified) . ' GMT');

    // no-cache means "ask me first", not "do not store": the browser keeps the file and
    // revalidates, so an unchanged Leaflet or style.css comes back as an empty 304
    // instead of being downloaded again on every page.
    header('Cache-Control: no-cache');

    $noneMatch = trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
    $since = strtotime($_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '') ?: 0;

    if ($noneMatch === $etag || ($noneMatch === '' && $since >= $modified)) {
        http_response_code(304);

        return true;
    }

    if ($method === 'HEAD') {
        header('Content-Length: ' . $size);

        return true;
    }

    // Leaflet, style.css and the geojson are large and highly repetitive; gzip takes
    // the boundary file from 93 KB to a few KB. Binary assets are already compressed,
    // and tiny files cost more to compress than they save.
    $accepts = strtolower($_SERVER['HTTP_ACCEPT_ENCODING'] ?? '');
    if ($size >= 2048 && in_array($extension, $textTypes, true)
        && str_contains($accepts, 'gzip') && function_exists('gzencode')) {
        $body = @file_get_contents($filePath);
        $compressed = $body === false ? false : gzencode($body, 6);

        if ($compressed !== false && strlen($compressed) < $size) {
            header('Content-Encoding: gzip');
            header('Vary: Accept-Encoding');
            header('Content-Length: ' . strlen($compressed));
            echo $compressed;

            return true;
        }
    }

    header('Content-Length: ' . $size);
    readfile($filePath);

    return true;
})();
