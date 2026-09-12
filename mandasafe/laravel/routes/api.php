<?php

use App\Http\Controllers\Api\AccountController;
use App\Http\Controllers\Api\AnalyticsController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\IncidentController;
use App\Http\Controllers\Api\PredictionInputController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| MandaSafe API
|--------------------------------------------------------------------------
|
| The same endpoints, methods and payloads the browser code already calls, so login.js,
| js/api.js and script.js needed no changes at all.
|
| Reading is open, writing is not:
|
|   GET  /api/summary, /api/incidents, /api/predictions, /api/hotspots, /api/stats  everyone
|   POST/PUT/DELETE incidents, prediction inputs, accounts                          admins
|
| A resident who types the admin URL is sent back to their dashboard, and the server rejects
| the write anyway — the role is read from the database on every request, not from the browser.
|
*/

/* ---------- open, read-only ---------- */
Route::get('/predictions', [AnalyticsController::class, 'predictions']);
Route::get('/stats', [AnalyticsController::class, 'stats']);
Route::get('/summary', [AnalyticsController::class, 'summary']);
Route::get('/hotspots', [AnalyticsController::class, 'hotspots']);
Route::get('/barangays', [AnalyticsController::class, 'barangays']);
Route::get('/otp-status', [AnalyticsController::class, 'otpStatus']);

/* Retired: this endpoint used to deliver a code the BROWSER had generated, which meant the
   browser also decided whether it matched. Verification now lives under /api/auth/otp/. */
Route::post('/send-otp', [AnalyticsController::class, 'sendOtp']);

Route::get('/incidents', [IncidentController::class, 'index']);
Route::get('/prediction-inputs', [PredictionInputController::class, 'index']);

/* ---------- sign-in ---------- */
Route::prefix('auth')->group(function () {
    Route::get('/me', [AuthController::class, 'me']);

    // Step one — each of these starts a verification and answers with a challenge id.
    Route::post('/register', [AuthController::class, 'register']);
    Route::post('/login', [AuthController::class, 'login']);
    Route::post('/contact', [AuthController::class, 'contact']);

    // Steps two and three — send the code, then check it. The code never leaves the server.
    Route::post('/otp/send', [AuthController::class, 'sendOtp']);
    Route::post('/otp/verify', [AuthController::class, 'verifyOtp']);
    Route::post('/otp/cancel', [AuthController::class, 'cancelOtp']);

    // Only reachable with a challenge that was verified moments ago.
    Route::post('/reset-password', [AuthController::class, 'resetPassword']);
    Route::post('/logout', [AuthController::class, 'logout']);
    Route::any('/{any}', [AuthController::class, 'missing'])->where('any', '.*');
});

/* ---------- administrator only ---------- */
Route::middleware('rimas.admin')->group(function () {
    Route::post('/incidents/bulk', [IncidentController::class, 'bulk']);
    Route::post('/incidents', [IncidentController::class, 'store']);
    Route::put('/incidents/{id}', [IncidentController::class, 'update']);
    Route::delete('/incidents/{id}', [IncidentController::class, 'destroy']);

    Route::post('/prediction-inputs', [PredictionInputController::class, 'store']);
    Route::put('/prediction-inputs/{id}', [PredictionInputController::class, 'update']);
    Route::delete('/prediction-inputs/{id}', [PredictionInputController::class, 'destroy']);

    Route::get('/accounts', [AccountController::class, 'index']);
    Route::post('/accounts', [AccountController::class, 'store']);
    Route::put('/accounts/{id}', [AccountController::class, 'update']);
    Route::delete('/accounts/{id}', [AccountController::class, 'destroy']);
});
