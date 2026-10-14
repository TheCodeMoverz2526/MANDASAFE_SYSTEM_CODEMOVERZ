<?php

/*
 * Password hashing. Only the bcrypt cost differs from Laravel's own defaults: 10 rounds
 * rather than 12. Each extra round doubles the work of every sign-in, and at 12 a single
 * password check took ~0.8 s on the development PC (longer on Vercel's shared CPU), which
 * people felt as a slow login. 10 is OWASP's recommended minimum for bcrypt.
 *
 * Existing hashes made at 12 keep working; AccountService::verifyCredentials() re-hashes each
 * one at the new cost the next time its owner signs in.
 */

return [
    'driver' => env('HASH_DRIVER', 'bcrypt'),

    'bcrypt' => [
        'rounds' => env('BCRYPT_ROUNDS', 10),
        'verify' => env('HASH_VERIFY', true),
        'limit' => env('BCRYPT_LIMIT', null),
    ],
];
