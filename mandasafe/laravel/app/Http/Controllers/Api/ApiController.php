<?php

namespace App\Http\Controllers\Api;

use App\Exceptions\RimasException;
use App\Http\Controllers\Controller;
use App\Models\Account;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Shared plumbing for the MandaSafe API. Every endpoint answers with either the payload it
 * always answered with, or { "error": "..." } under the status code that endpoint has always
 * used — the browser code was written against those exact shapes and is unchanged.
 */
abstract class ApiController extends Controller
{
    /** The body, whether it arrived as JSON or as form fields. */
    protected function body(Request $request): array
    {
        return $request->all();
    }

    /** @throws RimasException listing every field that is missing, blank or null */
    protected function requireFields(array $body, array $fields): void
    {
        $missing = [];
        foreach ($fields as $field) {
            $value = $body[$field] ?? null;
            if ($value === null || $value === '') {
                $missing[] = $field;
            }
        }

        if ($missing !== []) {
            throw new RimasException('Missing required field(s): ' . implode(', ', $missing));
        }
    }

    /** The administrator the RimasAdmin middleware resolved for this request. */
    protected function actor(Request $request): Account
    {
        return $request->attributes->get('rimas_account');
    }

    /**
     * Runs the handler and turns a RimasException into the plain { error } body the pages
     * display, under the status code this endpoint uses for a rejected request.
     */
    protected function attempt(callable $handler, int $status = 400, int $successStatus = 200): JsonResponse
    {
        try {
            $result = $handler();

            // A handler may answer for itself when it needs a different status (a 404, say).
            return $result instanceof JsonResponse ? $result : response()->json($result, $successStatus);
        } catch (RimasException $exception) {
            return response()->json(['error' => $exception->getMessage()], $status);
        }
    }
}
