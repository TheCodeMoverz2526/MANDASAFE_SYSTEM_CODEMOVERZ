<?php

use App\Http\Controllers\Api\AccountController;
use App\Http\Controllers\Api\AlertController;
use App\Http\Controllers\Api\AnalyticsController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\IncidentController;
use App\Http\Controllers\Api\NotificationController;
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
Route::get('/hotspots/barangays', [AnalyticsController::class, 'barangayHotspots']);
Route::get('/prone-areas', [AnalyticsController::class, 'proneAreas']);
Route::get('/severity', [AnalyticsController::class, 'severity']);
Route::get('/spatial/summary', [AnalyticsController::class, 'spatialSummary']);
Route::get('/spatial/nearby', [AnalyticsController::class, 'spatialNearby']);
Route::get('/barangays', [AnalyticsController::class, 'barangays']);
Route::get('/otp-status', [AnalyticsController::class, 'otpStatus']);

/* Retired: this endpoint used to deliver a code the BROWSER had generated, which meant the
   browser also decided whether it matched. Verification now lives under /api/auth/otp/. */
Route::post('/send-otp', [AnalyticsController::class, 'sendOtp']);

Route::get('/incidents', [IncidentController::class, 'index']);
Route::get('/prediction-inputs', [PredictionInputController::class, 'index']);

/* ---------- the resident bell: any signed-in account (checked in the controller) ---------- */
Route::get('/alerts', [AlertController::class, 'index']);
Route::post('/alerts/read-all', [AlertController::class, 'markAllRead']);

/* ---------- sign-in ---------- */
Route::prefix('auth')->group(function () {
    Route::get('/me', [AuthController::class, 'me']);
    Route::post('/register', [AuthController::class, 'register']);
    Route::post('/login', [AuthController::class, 'login']);
    Route::post('/contact', [AuthController::class, 'contact']);

    // The signed-in account editing its own details; the bearer token is the proof.
    Route::put('/profile', [AuthController::class, 'updateProfile']);

    // Steps two and three — send the code, then check it. The code never leaves the server.
    Route::post('/otp/send', [AuthController::class, 'sendOtp']);
    Route::post('/otp/verify', [AuthController::class, 'verifyOtp']);
    Route::post('/otp/cancel', [AuthController::class, 'cancelOtp']);

    // Administrators only: the code from their authenticator app, after the password.
    Route::post('/totp/verify', [AuthController::class, 'verifyTotp']);

    // Only reachable with a challenge that was verified moments ago.
    Route::post('/reset-password', [AuthController::class, 'resetPassword']);
    Route::post('/logout', [AuthController::class, 'logout']);
    Route::any('/{any}', [AuthController::class, 'missing'])->where('any', '.*');
});

/* ---------- administrator only ---------- */
Route::middleware('rimas.admin')->group(function () {
    Route::post('/incidents/bulk', [IncidentController::class, 'bulk']);
    Route::post('/incidents/bulk-delete', [IncidentController::class, 'bulkDestroy']);
    Route::post('/incidents', [IncidentController::class, 'store']);
    Route::put('/incidents/{id}', [IncidentController::class, 'update']);
    Route::delete('/incidents/{id}', [IncidentController::class, 'destroy']);

    Route::post('/prediction-inputs', [PredictionInputController::class, 'store']);
    Route::put('/prediction-inputs/{id}', [PredictionInputController::class, 'update']);
    Route::delete('/prediction-inputs/{id}', [PredictionInputController::class, 'destroy']);

    Route::get('/accounts', [AccountController::class, 'index']);
    Route::post('/accounts', [AccountController::class, 'store']);
    Route::get('/accounts/{id}', [AccountController::class, 'show']);
    Route::put('/accounts/{id}', [AccountController::class, 'update']);
    Route::delete('/accounts/{id}', [AccountController::class, 'destroy']);

    Route::get('/notifications', [NotificationController::class, 'index']);
    Route::get('/notifications/poll', [NotificationController::class, 'poll']);
    Route::put('/notifications/{id}/read', [NotificationController::class, 'markRead']);
    Route::post('/notifications/read-all', [NotificationController::class, 'markAllRead']);
});
