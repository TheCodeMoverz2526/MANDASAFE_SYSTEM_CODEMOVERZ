<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * Serves the MandaSafe pages themselves — index.html, the resident pages, Mandasafe.html,
 * script.js, styles.css, assets/ and vendor/leaflet/ — from the folder above this Laravel
 * app, which is where they have always lived.
 *
 * Keeping the pages and the API on one origin is what lets the browser code go on calling
 * plain "/api/..." paths with no CORS setup and no rewritten URLs.
 */
class StaticSiteController extends Controller
{
    private const MIME_TYPES = [
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

    private const TEXT_TYPES = ['css', 'html', 'js', 'json', 'geojson', 'svg', 'csv', 'txt'];

    /*
     * Only what the pages actually load is public. The folder above this app also holds the old
     * Node server, its data files (data/store.json has account password hashes and session
     * tokens), the ML scripts and older copies of the project — none of which may be served.
     * Anything not matched here is a 404, so a new file is private until it is listed.
     */
    private const PUBLIC_DIRECTORIES = ['assets', 'css', 'js', 'vendor'];
    private const PUBLIC_ROOT_FILES = ['script.js', 'login.js', 'styles.css'];
    private const PUBLIC_DATA_FILES = ['data/mandaluyong-barangays.geojson'];

    private static function isPublic(string $path): bool
    {
        if (in_array($path, self::PUBLIC_ROOT_FILES, true) || in_array($path, self::PUBLIC_DATA_FILES, true)) {
            return true;
        }
        // The pages themselves: .html files directly in the site root.
        if (! str_contains($path, '/') && str_ends_with(strtolower($path), '.html')) {
            return true;
        }
        $first = strtok($path, '/');

        return str_contains($path, '/') && in_array($first, self::PUBLIC_DIRECTORIES, true);
    }

    public function __invoke(Request $request)
    {
        // An unmatched /api/... path is a client mistake, not a missing page.
        if ($request->is('api') || $request->is('api/*')) {
            return response()->json(['error' => 'Unknown endpoint.'], 404);
        }

        $root = realpath(config('mandasafe.frontend_root'));
        if ($root === false) {
            return response('Server error', 500);
        }

        $requested = trim(rawurldecode($request->path()), '/');
        if ($requested === '' || $requested === 'index.html') {
            $requested = 'index.html';
        }

        // The Laravel app lives under the site root; nothing inside it (.env, the database,
        // vendor/) is web content, and neither are dotfiles.
        $firstSegment = strtolower(strtok($requested, '/'));
        if ($firstSegment === basename(base_path()) || str_starts_with($firstSegment, '.')) {
            return response('Forbidden', 403);
        }

        if (! self::isPublic($requested) || str_contains($requested, '..')) {
            return response('Not found', 404);
        }

        $filePath = realpath($root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $requested));

        if ($filePath === false || ! is_file($filePath)) {
            return response('Not found', 404);
        }
        if (! str_starts_with($filePath, $root . DIRECTORY_SEPARATOR)) {
            return response('Forbidden', 403);
        }

        $extension = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
        $contentType = self::MIME_TYPES[$extension] ?? 'application/octet-stream';
        if (in_array($extension, self::TEXT_TYPES, true)) {
            $contentType .= '; charset=utf-8';
        }

        // Online as a demo: every page carries a notice bar so it is never taken for an
        // official City website.
        // Pages are returned as text, not a file stream, so CompressResponse can gzip them.
        $notice = trim((string) config('mandasafe.demo_notice'));
        if ($extension === 'html') {
            $html = (string) file_get_contents($filePath);
            if ($notice !== '') {
                $bar = '<div role="note" style="position:sticky;top:0;z-index:100000;background:#fef3c7;color:#92400e;'
                    . 'border-bottom:1px solid #fcd34d;font:600 12.5px/1.4 system-ui,sans-serif;text-align:center;padding:7px 12px">'
                    . e($notice) . '</div>';
                $html = preg_replace('/<body\b[^>]*>/i', '$0' . $bar, $html, 1) ?? $html;
            }

            // Pages are never kept by the browser, so Back after signing out can't show a
            // signed-in page from memory; it reloads, and the page's sign-in check runs.
            // They are the same for every visitor (sign-in happens in the browser), so
            // Vercel's CDN may keep them until the next deployment — see bootstrap/static.php.
            return response($html, 200, [
                'Content-Type' => $contentType,
                'Cache-Control' => 'no-store',
                'Vercel-CDN-Cache-Control' => 'max-age=31536000',
            ]);
        }

        // The same caching as bootstrap/static.php.
        return new BinaryFileResponse($filePath, 200, [
            'Content-Type' => $contentType,
            'Cache-Control' => in_array($firstSegment, ['vendor', 'assets'], true) ? 'public, max-age=86400' : 'no-cache',
            'Vercel-CDN-Cache-Control' => 'max-age=31536000',
        ]);
    }
}
