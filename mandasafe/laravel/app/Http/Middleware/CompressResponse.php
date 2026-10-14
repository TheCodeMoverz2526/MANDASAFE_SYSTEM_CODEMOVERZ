<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Gzips API responses. The incident list alone is about 2 MB of JSON and shrinks to a small
 * fraction of that, which is most of the wait on a phone or across the office network.
 * PHP's built-in server — what start-mandasafe.bat runs — never compresses on its own.
 */
class CompressResponse
{
    private const MIN_BYTES = 1024;

    public function handle(Request $request, Closure $next)
    {
        $response = $next($request);

        if ($response instanceof BinaryFileResponse || $response instanceof StreamedResponse) {
            return $response;
        }
        if ($response->headers->has('Content-Encoding') || ! str_contains((string) $request->header('Accept-Encoding'), 'gzip')) {
            return $response;
        }

        $content = $response->getContent();
        if (! is_string($content) || strlen($content) < self::MIN_BYTES) {
            return $response;
        }

        $response->setContent(gzencode($content, 6));
        $response->headers->set('Content-Encoding', 'gzip');
        $response->headers->set('Content-Length', (string) strlen($response->getContent()));
        $response->setVary('Accept-Encoding', false);

        return $response;
    }
}
