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

        return new BinaryFileResponse($filePath, 200, [
            'Content-Type' => $contentType,
            'Cache-Control' => 'no-cache',
        ]);
    }
}
