<?php

use App\Http\Controllers\StaticSiteController;
use App\Http\Middleware\CompressResponse;
use App\Http\Middleware\RimasAdmin;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
        then: function () {
            // Anything that is not an API call is one of the MandaSafe pages (or an asset)
            // sitting in the folder above this app. No session or CSRF middleware applies —
            // these are static files, exactly as the old Node server served them.
            Route::fallback(StaticSiteController::class);
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->alias([
            'rimas.admin' => RimasAdmin::class,
        ]);

        // /api/incidents alone is over 2 MB of JSON; gzip takes it to about 145 KB.
        $middleware->api(append: [
            CompressResponse::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // The pages read { error } out of every failed request, so keep that shape for the
        // errors Laravel raises itself (a bad route, a malformed body) as well.
        $exceptions->shouldRenderJsonWhen(fn ($request) => $request->is('api/*') || $request->expectsJson());
    })->create();
