<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * gzips large API responses.
 *
 * GET /api/incidents hands the map every recorded incident — a little over 2 MB of very
 * repetitive JSON, where the same barangay names, severities and incident types occur
 * thousands of times. That compresses to about 145 KB, so the map page downloads a
 * fourteenth of what it used to. Neither `php artisan serve` nor the PHP built-in server
 * compresses anything on its own, so it is done here.
 *
 * Small responses are left alone: below a few KB the CPU spent compressing outweighs the
 * bytes saved.
 */
class CompressResponse
{
    /** Below this many bytes, compressing costs more than it saves. */
    private const MIN_BYTES = 2048;

    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        // A streamed or already-encoded response is not ours to rewrite.
        if ($response instanceof StreamedResponse || $response->headers->has('Content-Encoding')) {
            return $response;
        }
        if (! function_exists('gzencode') || ! str_contains(strtolower($request->headers->get('Accept-Encoding', '')), 'gzip')) {
            return $response;
        }

        $content = $response->getContent();
        if (! is_string($content) || strlen($content) < self::MIN_BYTES) {
            return $response;
        }

        $compressed = gzencode($content, 6);
        if ($compressed === false || strlen($compressed) >= strlen($content)) {
            return $response;
        }

        $response->setContent($compressed);
        $response->headers->set('Content-Encoding', 'gzip');
        $response->headers->set('Content-Length', (string) strlen($compressed));

        // Caches must not hand the gzipped body to a client that did not ask for it.
        $response->headers->set('Vary', 'Accept-Encoding');

        return $response;
    }
}
