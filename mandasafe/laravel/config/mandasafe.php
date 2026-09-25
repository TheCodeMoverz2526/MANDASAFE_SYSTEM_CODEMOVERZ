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
    | Leave OTP_TEST_MODE=true and no provider is contacted: the code is generated locally
    | and shown on the sign-in page, which is how the system runs out of the box. Fill in the
    | Vocotext credentials (SMS) and/or the Resend or SMTP (MAIL_*) credentials (email) to deliver for real —
    | test mode must be off for either to be used.
    |
    | Vocotext iSMS 2FA generates the code on its side, substitutes it for %OTP% in the
    | message and verifies it on its side too, so MandaSafe never stores those digits.
    |
    */

    'otp' => [
        'test_mode' => env('OTP_TEST_MODE', false),

        // Email — Appwrite Email OTP (preferred). Appwrite generates, mails and checks the code.
        'appwrite_endpoint' => env('APPWRITE_ENDPOINT', 'https://cloud.appwrite.io/v1'),
        'appwrite_project' => env('APPWRITE_PROJECT_ID'),
        // Optional: lets MandaSafe delete the throwaway Appwrite session once a code is accepted.
        'appwrite_key' => env('APPWRITE_API_KEY'),

        // Email — Resend
        'resend_key' => env('RESEND_API_KEY'),
        'from_email' => env('OTP_FROM_EMAIL'),

        // SMS — Vocotext iSMS 2FA (preferred)
        'vocotext_endpoint' => env('VOCOTEXT_ENDPOINT', 'https://smtpapi.vocotext.com/isms_2fa_request.php'),
        'vocotext_user' => env('VOCOTEXT_USERNAME'),
        'vocotext_pass' => env('VOCOTEXT_PASSWORD'),
        'vocotext_sender' => env('VOCOTEXT_SENDER_ID', 'MandaSafe'),
        'vocotext_type' => env('VOCOTEXT_TYPE', '1'),
        // %OTP% is replaced by the provider with the code it generated.
        'vocotext_message' => env('VOCOTEXT_MESSAGE', 'Your MandaSafe verification code is %OTP%. Do not share it with anyone.'),
        // Minutes the provider keeps the code valid — keep it equal to
        // VerificationService::CHALLENGE_TTL_SECONDS so both sides expire together.
        'vocotext_interval' => (int) env('VOCOTEXT_INTERVAL', 10),

        // SMS — Twilio, used only when Vocotext is not configured.
        'twilio_sid' => env('TWILIO_ACCOUNT_SID'),
        'twilio_token' => env('TWILIO_AUTH_TOKEN'),
        'twilio_from' => env('TWILIO_FROM_NUMBER'),

        // Numbers are stored as +639171234567; Vocotext wants the country code separately.
        'sms_country_code' => (string) env('OTP_SMS_COUNTRY_CODE', '63'),
        'sms_country_codes' => array_values(array_filter(array_map(
            'trim',
            explode(',', (string) env('OTP_SMS_COUNTRY_CODES', '63,1,44,65,61,971'))
        ))),

        'http_timeout' => (int) env('OTP_HTTP_TIMEOUT', 20),
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

    /*
    |--------------------------------------------------------------------------
    | Machine learning
    |--------------------------------------------------------------------------
    |
    | The severity Random Forest and the KDE hotspot surface are computed by the Python
    | (scikit-learn) scripts in ml/, one level above this Laravel app. MlBridge shells out
    | to the interpreter below, feeding it JSON on stdin and reading JSON back from stdout.
    |
    */

    'ml_root' => dirname(base_path()) . DIRECTORY_SEPARATOR . 'ml',

    'python_bin' => env('MANDASAFE_PYTHON_BIN', 'python'),

    /*
    |--------------------------------------------------------------------------
    | Demo notice
    |--------------------------------------------------------------------------
    |
    | When set, this text is shown in a bar at the top of every page. Use it whenever the
    | system is online as a demo, so no visitor mistakes it for an official City website:
    |   MANDASAFE_DEMO_NOTICE="Capstone demo — not an official Mandaluyong City website."
    |
    */

    'demo_notice' => env('MANDASAFE_DEMO_NOTICE'),

];
