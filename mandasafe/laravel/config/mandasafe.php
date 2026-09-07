<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Front-end root
    |--------------------------------------------------------------------------
    |
    | The MandaSafe pages (index.html, Mandasafe.html, script.js, styles.css, the
    | resident pages, assets/ and vendor/) live one level above this Laravel app, so
    | they stay exactly where they always were. Laravel serves them from there, which
    | keeps the pages and the API on one origin — the same arrangement server.js had.
    |
    */

    'frontend_root' => env('MANDASAFE_FRONTEND_ROOT', dirname(base_path())),

    /*
    | Official barangay boundaries. Also served verbatim at GET /api/barangays.
    */
    'geojson' => env(
        'MANDASAFE_GEOJSON',
        dirname(base_path()) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'mandaluyong-barangays.geojson'
    ),

    /*
    | The legacy JSON store, read once by `php artisan mandasafe:import`.
    */
    'legacy_store' => env(
        'MANDASAFE_LEGACY_STORE',
        dirname(base_path()) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'store.json'
    ),

    /*
    |--------------------------------------------------------------------------
    | One-time passcode delivery
    |--------------------------------------------------------------------------
    |
    | Leave OTP_TEST_MODE=true to have the sign-in page accept OTP_TEST_CODE without
    | contacting a provider. Set the Resend / Twilio credentials to deliver for real.
    |
    */

    'otp' => [
        'test_mode' => env('OTP_TEST_MODE', false),
        'test_code' => env('OTP_TEST_CODE', '123456'),
        'resend_key' => env('RESEND_API_KEY'),
        'from_email' => env('OTP_FROM_EMAIL'),
        'twilio_sid' => env('TWILIO_ACCOUNT_SID'),
        'twilio_token' => env('TWILIO_AUTH_TOKEN'),
        'twilio_from' => env('TWILIO_FROM_NUMBER'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Analytics cache
    |--------------------------------------------------------------------------
    |
    | The Random Forest, the KDE surface and the summary are pure functions of the
    | stored data, so they are computed once and cached until the next write bumps the
    | data version. Set to 0 to recompute on every request.
    |
    */

    'analytics_cache_seconds' => (int) env('MANDASAFE_ANALYTICS_CACHE', 86400),

];
