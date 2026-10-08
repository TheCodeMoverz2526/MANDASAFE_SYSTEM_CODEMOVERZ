<?php

namespace Tests\Feature;

use App\Models\Account;
use App\Models\Incident;
use App\Models\Setting;
use App\Services\AccountService;
use App\Services\TotpService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Covers the contract the browser code depends on: what is readable without signing in, what
 * is not writable without an administrator, and the shapes the pages parse.
 */
class MandaSafeApiTest extends TestCase
{
    use RefreshDatabase;

    private Account $admin;
    private Account $resident;

    protected function setUp(): void
    {
        parent::setUp();

        // No provider is contacted in test mode; the code is generated locally and returned
        // by /api/auth/otp/send so a test can complete the sign-in.
        config(['mandasafe.otp.test_mode' => true]);

        Setting::put('nextIncidentSeq', 1);
        Setting::put('nextInputSeq', 1);
        // Two accounts are created below, so the next one handed out is USR-1003.
        Setting::put('nextAccountSeq', 3);

        $this->admin = Account::create([
            'id' => 'USR-1001', 'name' => 'RIMAS Administrator', 'email' => 'admin@rimas.gov.ph',
            'phone' => '+639171234567', 'role' => 'admin', 'dept' => 'TPMO', 'status' => 'active',
            'password' => Hash::make('Test-Admin#2026'), 'created_at_iso' => AccountService::isoNow(),
        ]);

        $this->resident = Account::create([
            'id' => 'USR-1002', 'name' => 'Juan Dela Cruz', 'email' => 'juan@example.com',
            'phone' => '+639170000002', 'role' => 'user', 'dept' => 'Resident', 'status' => 'active',
            'password' => Hash::make('Test-Resident#2026'), 'created_at_iso' => AccountService::isoNow(),
        ]);
    }

    /**
     * A resident's correct password returns the session token. An administrator's opens an
     * authenticator challenge instead; the first time it carries the secret to set up, so the
     * test computes the code the app would show.
     */
    private function tokenFor(string $identifier, string $password): string
    {
        // An administrator's code can only be used once, so their session is reused within a test.
        if (isset($this->adminTokens[$identifier])) {
            return $this->adminTokens[$identifier];
        }

        $response = $this->postJson('/api/auth/login', ['identifier' => $identifier, 'password' => $password])
            ->assertOk();

        if (! $response->json('totpRequired')) {
            return $response->json('token');
        }

        return $this->adminTokens[$identifier] = $this->postJson('/api/auth/totp/verify', [
            'challengeId' => $response->json('challengeId'),
            'code' => app(TotpService::class)->codeFor($response->json('secret')),
        ])->assertOk()->json('token');
    }

    /** @var array<string, string> */
    private array $adminTokens = [];

    private function adminHeaders(): array
    {
        return ['Authorization' => 'Bearer ' . $this->tokenFor('admin@rimas.gov.ph', 'Test-Admin#2026')];
    }

    public function test_reading_is_open_to_everyone(): void
    {
        foreach (['/api/incidents', '/api/prediction-inputs', '/api/predictions', '/api/stats', '/api/summary', '/api/hotspots'] as $endpoint) {
            $this->getJson($endpoint)->assertOk();
        }
    }

    public function test_writing_needs_an_administrator(): void
    {
        $this->postJson('/api/incidents', [])->assertStatus(401);
        $this->getJson('/api/accounts')->assertStatus(401);

        $residentHeaders = ['Authorization' => 'Bearer ' . $this->tokenFor('juan@example.com', 'Test-Resident#2026')];

        $this->postJson('/api/incidents', [], $residentHeaders)->assertStatus(403);
        $this->getJson('/api/accounts', $residentHeaders)->assertStatus(403);
        $this->deleteJson('/api/incidents/' . rawurlencode('#A10001'), [], $residentHeaders)->assertStatus(403);
        $this->postJson('/api/incidents/bulk-delete', ['ids' => ['#A10001']])->assertStatus(401);
        $this->postJson('/api/incidents/bulk-delete', ['ids' => ['#A10001']], $residentHeaders)->assertStatus(403);
    }

    public function test_an_administrator_sees_a_users_details_and_activity_but_never_the_password(): void
    {
        $this->postJson('/api/auth/login', ['identifier' => 'juan@example.com', 'password' => 'wrong'])->assertStatus(401);
        $token = $this->tokenFor('juan@example.com', 'Test-Resident#2026');
        $this->postJson('/api/auth/logout', [], ['Authorization' => 'Bearer ' . $token])->assertOk();
        $this->putJson('/api/accounts/USR-1002', ['status' => 'inactive'], $this->adminHeaders())->assertOk();

        $this->postJson('/api/auth/login', ['identifier' => 'juan@example.com', 'password' => 'Test-Resident#2026'])->assertStatus(401);

        $details = $this->getJson('/api/accounts/USR-1002', $this->adminHeaders())->assertOk();
        $details->assertJsonPath('account.email', 'juan@example.com')
            ->assertJsonPath('security.activeSessions', 0);
        $this->assertSame(
            ['login_failed', 'account_changed', 'logout', 'login', 'login_failed'],
            array_column($details->json('activity'), 'action')
        );
        $this->assertStringContainsString('Deactivated by admin@rimas.gov.ph', $details->json('activity.1.detail'));
        $this->assertStringNotContainsString('password":"', $details->getContent());
        $this->assertStringNotContainsString('$2y$', $details->getContent());

        $this->getJson('/api/accounts/USR-9999', $this->adminHeaders())->assertStatus(404);
        $this->getJson('/api/accounts/USR-1002')->assertStatus(401);
    }

    public function test_sign_in_rejects_a_wrong_password(): void
    {
        $this->postJson('/api/auth/login', ['identifier' => 'admin@rimas.gov.ph', 'password' => 'wrong'])
            ->assertStatus(401)
            ->assertJson(['error' => 'Incorrect email/phone number or password.']);
    }

    public function test_a_resident_signs_in_without_an_authenticator_code(): void
    {
        $this->postJson('/api/auth/login', ['identifier' => 'juan@example.com', 'password' => 'Test-Resident#2026'])
            ->assertOk()
            ->assertJsonMissing(['totpRequired' => true])
            ->assertJsonStructure(['token']);
    }

    public function test_an_administrator_must_pass_the_authenticator_step(): void
    {
        $totp = app(TotpService::class);

        // RFC 6238 test vector (SHA-1, T = 59s), trimmed to six digits: matches the apps.
        $this->assertSame('287082', $totp->codeFor('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59));

        // First sign-in: no token yet, only a secret to scan.
        $first = $this->postJson('/api/auth/login', ['identifier' => 'admin@rimas.gov.ph', 'password' => 'Test-Admin#2026'])
            ->assertOk()
            ->assertJson(['totpRequired' => true, 'enroll' => true])
            ->assertJsonMissingPath('token');
        $secret = $first->json('secret');
        $this->assertStringStartsWith('otpauth://totp/', $first->json('otpauthUri'));

        // The email/SMS endpoints cannot be used to get around it.
        $this->postJson('/api/auth/otp/send', ['challengeId' => $first->json('challengeId'), 'channel' => 'email'])
            ->assertStatus(400);

        $wrong = $totp->codeFor($secret) === '000000' ? '111111' : '000000';
        $this->postJson('/api/auth/totp/verify', ['challengeId' => $first->json('challengeId'), 'code' => $wrong])
            ->assertStatus(400)
            ->assertJson(['error' => 'The authenticator code is incorrect. 4 tries left.']);
        $this->assertNull(Account::find('USR-1001')->totp_enabled_at_iso);

        $code = $totp->codeFor($secret);
        $this->postJson('/api/auth/totp/verify', ['challengeId' => $first->json('challengeId'), 'code' => $code])
            ->assertOk()
            ->assertJson(['account' => ['role' => 'admin']])
            ->assertJsonStructure(['token']);

        // Next sign-in: already set up, so no secret is sent, and the used code is refused.
        $second = $this->postJson('/api/auth/login', ['identifier' => 'admin@rimas.gov.ph', 'password' => 'Test-Admin#2026'])
            ->assertOk()
            ->assertJson(['totpRequired' => true, 'enroll' => false])
            ->assertJsonMissingPath('secret');
        $this->postJson('/api/auth/totp/verify', ['challengeId' => $second->json('challengeId'), 'code' => $code])
            ->assertStatus(400);

        $this->postJson('/api/auth/totp/verify', [
            'challengeId' => $second->json('challengeId'),
            'code' => $totp->codeFor($secret, time() + TotpService::PERIOD),
        ])->assertOk()->assertJsonStructure(['token']);
    }

    public function test_an_administrator_can_record_edit_and_delete_an_incident(): void
    {
        $headers = $this->adminHeaders();

        $created = $this->postJson('/api/incidents', [
            'barangay' => 'Plainview', 'road' => 'Boni Ave', 'sev' => 'Fatal',
            'type' => 'Vehicular Collision', 'date' => '2026-09-01', 'time' => '08:15:00',
            'lat' => 14.577, 'lng' => 121.036,
        ], $headers)->assertStatus(201);

        $id = $created->json('id');
        $this->assertSame('#A10001', $id);
        $this->assertSame('admin@rimas.gov.ph', $created->json('createdBy'));

        // Ids carry a '#', so the console sends them percent-encoded.
        $encoded = rawurlencode($id);

        $this->putJson("/api/incidents/{$encoded}", ['sev' => 'Injury', 'status' => 'resolved'], $headers)
            ->assertOk()
            ->assertJson(['sev' => 'Injury', 'status' => 'resolved', 'updatedBy' => 'admin@rimas.gov.ph']);

        // Newest first, the order the console and the maps expect.
        $this->assertSame($id, $this->getJson('/api/incidents')->json('0.id'));

        $this->deleteJson("/api/incidents/{$encoded}", [], $headers)->assertOk()->assertJson(['deleted' => $id]);
        $this->deleteJson("/api/incidents/{$encoded}", [], $headers)->assertStatus(404);
    }

    public function test_missing_fields_are_named_in_the_error(): void
    {
        $this->postJson('/api/incidents', ['barangay' => 'Plainview'], $this->adminHeaders())
            ->assertStatus(400)
            ->assertJson(['error' => 'Missing required field(s): road, sev, type, date']);
    }

    public function test_bulk_import_skips_duplicates_and_reports_why(): void
    {
        $row = ['barangay' => 'Hulo', 'road' => 'J.P. Rizal', 'sev' => 'Minor', 'type' => 'Sideswipe', 'date' => '2026-08-15', 'time' => '07:00:00'];

        $response = $this->postJson('/api/incidents/bulk', [
            'records' => [$row, $row, ['barangay' => 'Hulo', 'sev' => 'Minor', 'type' => 'Sideswipe', 'date' => '2026-08-16']],
        ], $this->adminHeaders())->assertStatus(201);

        $this->assertSame(1, $response->json('createdCount'));
        $this->assertSame(2, $response->json('skippedCount'));
        $this->assertSame('Duplicate of an existing accident', $response->json('skipped.0.reason'));
        $this->assertSame('Missing required field(s): road', $response->json('skipped.1.reason'));
        $this->assertSame(1, Incident::count());
    }

    public function test_prediction_inputs_are_validated(): void
    {
        $headers = $this->adminHeaders();

        $this->postJson('/api/prediction-inputs', ['barangay' => 'Hulo', 'month' => '2026', 'incidentCount' => 4], $headers)
            ->assertStatus(400)
            ->assertJson(['error' => 'Month must be in YYYY-MM format.']);

        $this->postJson('/api/prediction-inputs', ['barangay' => 'Hulo', 'month' => '2026-01', 'incidentCount' => -1], $headers)
            ->assertStatus(400)
            ->assertJson(['error' => 'Accident count must be a non-negative number.']);

        $this->postJson('/api/prediction-inputs', ['barangay' => 'Hulo', 'month' => '2026-01', 'incidentCount' => 4], $headers)
            ->assertStatus(201)
            ->assertJson(['id' => 'RF-1001', 'road' => 'All Roads', 'incidentCount' => 4]);
    }

    public function test_the_last_administrator_cannot_be_removed(): void
    {
        $headers = $this->adminHeaders();

        $this->putJson('/api/accounts/USR-1001', ['role' => 'user'], $headers)
            ->assertStatus(400)
            ->assertJson(['error' => 'At least one active administrator must remain.']);

        $this->deleteJson('/api/accounts/USR-1001', [], $headers)
            ->assertStatus(400)
            ->assertJson(['error' => 'At least one active administrator must remain.']);
    }

    public function test_sign_up_creates_the_account_without_a_code_and_never_as_admin(): void
    {
        $this->postJson('/api/auth/register', [
            'name' => 'Sneaky User', 'email' => 'sneaky@example.com',
            'phone' => '+639171110004', 'password' => 'Testing2026', 'role' => 'admin',
        ])
            ->assertOk()
            ->assertJson(['registered' => true, 'account' => ['role' => 'user', 'email' => 'sneaky@example.com']])
            ->assertJsonMissingPath('challengeId');

        $this->postJson('/api/auth/login', ['identifier' => 'sneaky@example.com', 'password' => 'Testing2026'])
            ->assertOk()
            ->assertJsonStructure(['token']);

        // The same email cannot be registered twice.
        $this->postJson('/api/auth/register', [
            'name' => 'Again', 'email' => 'sneaky@example.com',
            'phone' => '+639171110005', 'password' => 'Testing2026',
        ])->assertStatus(400);
    }

    public function test_a_password_is_reset_through_the_registered_email_only(): void
    {
        // A phone number, or an address nobody registered, cannot start a reset.
        $this->postJson('/api/auth/contact', ['email' => '+639170000002'])->assertStatus(404);
        $this->postJson('/api/auth/contact', ['identifier' => '+639170000002'])->assertStatus(404);
        $this->postJson('/api/auth/contact', ['email' => 'nobody@example.com'])
            ->assertStatus(404)
            ->assertJson(['error' => 'We could not find an account with that email address.']);

        $started = $this->postJson('/api/auth/contact', ['email' => ' Juan@Example.com '])
            ->assertOk()
            ->assertJson(['purpose' => 'reset', 'phone' => '', 'channels' => ['email' => true, 'sms' => false]]);
        $challengeId = $started->json('challengeId');

        $this->postJson('/api/auth/otp/send', ['challengeId' => $challengeId, 'channel' => 'sms'])->assertStatus(400);

        $code = $this->postJson('/api/auth/otp/send', ['challengeId' => $challengeId, 'channel' => 'email'])
            ->assertOk()
            ->assertJson(['channel' => 'email'])
            ->json('testCode');
        // Without a mailer the code is shown on the page — a fresh random one, not a fixed value.
        $this->assertMatchesRegularExpression('/^\d{6}$/', (string) $code);

        // The new password is refused until the emailed code has been accepted.
        $this->postJson('/api/auth/reset-password', ['challengeId' => $challengeId, 'password' => 'NewPass2026'])->assertStatus(400);

        $this->postJson('/api/auth/otp/verify', ['challengeId' => $challengeId, 'code' => $code])
            ->assertOk()
            ->assertJson(['verified' => true, 'purpose' => 'reset']);

        $this->postJson('/api/auth/reset-password', ['challengeId' => $challengeId, 'password' => 'NewPass2026'])
            ->assertOk()
            ->assertJson(['email' => 'juan@example.com']);

        $this->postJson('/api/auth/login', ['identifier' => 'juan@example.com', 'password' => 'NewPass2026'])->assertOk();
        $this->postJson('/api/auth/login', ['identifier' => 'juan@example.com', 'password' => 'Test-Resident#2026'])->assertStatus(401);

        // Administrators are told about the change in the notification feed.
        $this->assertDatabaseHas('notifications', ['type' => 'password_changed', 'title' => 'Password changed']);
    }

    public function test_with_smtp_configured_the_code_is_emailed_and_never_shown(): void
    {
        // A configured mailer wins over OTP_TEST_MODE. The array transport keeps the message
        // in memory instead of contacting Gmail.
        config([
            'mail.default' => 'smtp',
            'mail.mailers.smtp.transport' => 'array',
            'mail.mailers.smtp.host' => 'smtp.gmail.com',
            'mail.mailers.smtp.username' => 'mandasafe@gmail.com',
            'mail.mailers.smtp.password' => 'app-password',
            'mail.from.address' => 'mandasafe@gmail.com',
        ]);

        $challengeId = $this->postJson('/api/auth/contact', ['email' => 'juan@example.com'])
            ->assertOk()
            ->assertJson(['testMode' => false, 'channels' => ['email' => true]])
            ->json('challengeId');

        $this->postJson('/api/auth/otp/send', ['challengeId' => $challengeId, 'channel' => 'email'])
            ->assertOk()
            ->assertJsonMissingPath('testCode');

        $messages = app('mail.manager')->mailer('smtp')->getSymfonyTransport()->messages();
        $this->assertCount(1, $messages);
        $email = $messages[0]->getOriginalMessage();
        $this->assertSame('juan@example.com', $email->getTo()[0]->getAddress());
        $this->assertMatchesRegularExpression('/code is <strong[^>]*>\d{6}<\/strong>/', $email->getHtmlBody());
    }

    public function test_a_code_expires_after_thirty_seconds_and_can_be_resent(): void
    {
        $challengeId = $this->postJson('/api/auth/contact', ['email' => 'juan@example.com'])->json('challengeId');
        $code = $this->postJson('/api/auth/otp/send', ['challengeId' => $challengeId, 'channel' => 'email'])
            ->assertOk()
            ->assertJson(['expiresIn' => 30])
            ->json('testCode');

        $this->travel(31)->seconds();

        // An expired code is refused without costing a try, and the reset is still open.
        $this->postJson('/api/auth/otp/verify', ['challengeId' => $challengeId, 'code' => $code])
            ->assertStatus(400)
            ->assertJson(['error' => 'This code has expired. Click "Resend code" to get a new one.']);

        $fresh = $this->postJson('/api/auth/otp/send', ['challengeId' => $challengeId, 'channel' => 'email'])
            ->assertOk()
            ->json('testCode');

        $this->postJson('/api/auth/otp/verify', ['challengeId' => $challengeId, 'code' => $fresh])
            ->assertOk()
            ->assertJson(['verified' => true]);
    }

    public function test_with_appwrite_configured_the_code_is_emailed_and_checked_by_appwrite(): void
    {
        config(['mandasafe.otp.appwrite_project' => 'mandasafe-test', 'mandasafe.otp.appwrite_key' => 'key']);

        Http::fake([
            '*/account/tokens/email' => Http::response(['$id' => 'token1', 'userId' => 'appwrite-user'], 201),
            '*/account/sessions/token' => function ($request) {
                return $request['secret'] === '482913'
                    ? Http::response(['$id' => 'session1'], 201)
                    : Http::response(['type' => 'user_invalid_token'], 401);
            },
            '*/users/*' => Http::response(null, 204),
        ]);

        $challengeId = $this->postJson('/api/auth/contact', ['email' => 'juan@example.com'])
            ->assertOk()
            ->assertJson(['testMode' => false, 'channels' => ['email' => true]])
            ->json('challengeId');

        $this->postJson('/api/auth/otp/send', ['challengeId' => $challengeId, 'channel' => 'email'])
            ->assertOk()
            ->assertJsonMissingPath('testCode');

        Http::assertSent(fn ($request) => str_ends_with($request->url(), '/account/tokens/email')
            && $request['email'] === 'juan@example.com'
            && $request->header('X-Appwrite-Project')[0] === 'mandasafe-test');

        $this->postJson('/api/auth/otp/verify', ['challengeId' => $challengeId, 'code' => '111111'])
            ->assertStatus(400);
        $this->postJson('/api/auth/otp/verify', ['challengeId' => $challengeId, 'code' => '482913'])
            ->assertOk();

        // The throwaway Appwrite session is removed again.
        Http::assertSent(fn ($request) => $request->method() === 'DELETE'
            && str_ends_with($request->url(), '/users/appwrite-user/sessions/session1'));
    }

    public function test_the_live_notification_check_returns_only_what_is_new(): void
    {
        $headers = $this->adminHeaders();
        $notifications = app(\App\Services\NotificationService::class);

        $notifications->create('account_created', 'First');
        $seen = $this->getJson('/api/notifications/poll?after=0', $headers)->assertOk()->json('latest');

        // Nothing new since the last check.
        $this->getJson('/api/notifications/poll?after=' . $seen, $headers)
            ->assertOk()
            ->assertJson(['latest' => $seen, 'unread' => 1, 'items' => []]);

        $notifications->create('password_changed', 'Password changed', 'Juan changed their password.');

        $this->getJson('/api/notifications/poll?after=' . $seen, $headers)
            ->assertOk()
            ->assertJsonCount(1, 'items')
            ->assertJsonPath('items.0.title', 'Password changed')
            ->assertJsonPath('unread', 2);

        // Administrators only, like the rest of the feed.
        $this->getJson('/api/notifications/poll?after=0')->assertStatus(401);
    }

    public function test_signing_out_invalidates_the_token(): void
    {
        $headers = ['Authorization' => 'Bearer ' . $this->tokenFor('juan@example.com', 'Test-Resident#2026')];

        $this->getJson('/api/auth/me', $headers)->assertOk()->assertJson(['email' => 'juan@example.com']);
        $this->postJson('/api/auth/logout', [], $headers)->assertOk()->assertJson(['signedOut' => true]);
        $this->getJson('/api/auth/me', $headers)->assertStatus(401);
    }

    public function test_the_pages_are_served_and_the_laravel_folder_is_not(): void
    {
        $this->get('/')->assertOk()->assertHeader('content-type', 'text/html; charset=utf-8');
        $this->get('/login.html')->assertOk();
        $this->get('/laravel/.env')->assertStatus(403);
        $this->get('/api/nope')->assertStatus(404)->assertJson(['error' => 'Unknown endpoint.']);

        // What the pages load is public…
        foreach (['/script.js', '/css/style.css', '/js/api.js', '/assets/logo-192.png', '/vendor/leaflet/leaflet.js', '/data/mandaluyong-barangays.geojson'] as $path) {
            $this->get($path)->assertOk();
        }
        // …and nothing else is: the old data files hold password hashes and session tokens.
        foreach (['/data/store.json', '/data/store.backup.json', '/server.js', '/ml/hotspots.py', '/README.md',
            '/MANDASAFE_SYSTEM_CODEMOVERZ/mandasafe/data/store.json', '/js/../data/store.json'] as $path) {
            $this->get($path)->assertNotFound();
        }
    }

    /*
     * public/index.php answers static files through bootstrap/static.php BEFORE Laravel
     * boots, so the test above (which goes through the router) never reaches it. Run it the
     * way the web server does, in its own PHP process, and check it applies the same
     * allowlist: it once served data/store.json and auth.js to anyone.
     */
    public function test_the_fast_static_path_serves_only_the_allowlist(): void
    {
        $run = function (string $uri): string {
            $code = '$_SERVER["REQUEST_METHOD"]="HEAD"; $_SERVER["REQUEST_URI"]=' . var_export($uri, true) . ';'
                . '$r = require ' . var_export(base_path('bootstrap/static.php'), true) . '; echo $r ? "SERVED" : "PASSED";';
            $process = new \Symfony\Component\Process\Process([PHP_BINARY, '-r', $code]);
            $process->run();

            return trim($process->getOutput());
        };

        foreach (['/data/store.json', '/data/store.backup.json', '/auth.js', '/server.js', '/db.js', '/prediction.js',
            '/js/../auth.js', '/css/..%2fauth.js', '/js/..%5cauth.js', '/MANDASAFE_SYSTEM_CODEMOVERZ/mandasafe/index.html',
            '/mandasafe/index.html', '/index.html', '/'] as $uri) {
            $this->assertSame('PASSED', $run($uri), "$uri must not be served by the fast path");
        }
        foreach (['/js/api.js', '/css/style.css', '/script.js', '/vendor/leaflet/leaflet.js', '/data/mandaluyong-barangays.geojson'] as $uri) {
            $this->assertSame('SERVED', $run($uri), "$uri should be served by the fast path");
        }
    }

    public function test_codes_are_never_shown_on_the_page_in_production(): void
    {
        // setUp() turned test mode on; online it must be ignored, or anyone could read a
        // password-reset code for someone else's account off the page.
        $this->app['env'] = 'production';
        $this->assertFalse(app(\App\Services\OtpService::class)->testMode());
        $this->getJson('/api/otp-status')->assertOk()->assertJson(['testMode' => false]);
    }

    public function test_a_new_administrator_gets_no_built_in_password(): void
    {
        Account::query()->delete();

        $first = app(AccountService::class)->seedDefaultAdmin();
        $this->assertIsString($first);
        $this->assertGreaterThanOrEqual(16, strlen($first));
        $this->assertTrue(Hash::check($first, Account::where('email', 'admin@rimas.gov.ph')->value('password')));

        // A second run leaves the existing account alone.
        $this->assertNull(app(AccountService::class)->seedDefaultAdmin());
    }

    public function test_who_entered_a_record_is_only_shown_to_administrators(): void
    {
        $this->postJson('/api/incidents', [
            'barangay' => 'Plainview', 'road' => 'Boni Ave', 'sev' => 'Minor',
            'type' => 'Sideswipe', 'date' => '2026-07-04', 'time' => '09:00:00',
        ], $this->adminHeaders())->assertStatus(201)->assertJsonStructure(['createdBy']);

        $public = $this->getJson('/api/incidents')->assertOk()->json();
        $this->assertArrayNotHasKey('createdBy', $public[0]);
        $this->assertStringNotContainsString('@', json_encode($this->getJson('/api/summary')->json('recent')));

        $admin = $this->getJson('/api/incidents', $this->adminHeaders())->assertOk()->json();
        $this->assertArrayHasKey('createdBy', $admin[0]);
    }

    public function test_the_summary_carries_everything_the_resident_pages_read(): void
    {
        $this->postJson('/api/incidents', [
            'barangay' => 'Plainview', 'road' => 'Boni Ave', 'sev' => 'Minor',
            'type' => 'Sideswipe', 'date' => '2026-07-04', 'time' => '09:00:00',
        ], $this->adminHeaders())->assertStatus(201);

        $this->getJson('/api/summary')->assertOk()->assertJsonStructure([
            'totalIncidents', 'activeIncidents', 'resolvedIncidents', 'avgRiskScore',
            'range' => ['from', 'to'],
            'barangayCount',
            'byBarangay' => [['barangay', 'count', 'lat', 'lng']],
            'byMonth' => [['month', 'count']],
            'byType' => [['type', 'count']],
            'byRoad' => [['road', 'count']],
            'bySeverity' => [['sev', 'count']],
            'topPredictions', 'recent',
            'byHour', 'byWeekday', 'latestMonth', 'previousMonth', 'severityTracked', 'statusTracked',
            'safety' => ['overall', 'level', 'categories', 'excluded', 'trend', 'byBarangay', 'rising', 'window'],
        ]);
    }

    public function test_the_summary_is_computed_from_the_records_only(): void
    {
        // Ten months with a gap (none in 2025-03), one busy barangay, all the same severity.
        $rows = [];
        foreach (['2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-04', '2025-05', '2025-06', '2025-07'] as $i => $month) {
            foreach (range(1, 10) as $n) {
                $rows[] = ['barangay' => $n <= 6 ? 'Plainview' : 'Hulo', 'road' => 'Unknown', 'sev' => 'Minor',
                    'type' => 'Vehicular Collision', 'date' => "{$month}-" . str_pad((string) $n, 2, '0', STR_PAD_LEFT), 'time' => '14:30:00'];
            }
        }
        $this->postJson('/api/incidents/bulk', ['records' => $rows], $this->adminHeaders())->assertStatus(201);

        $summary = $this->getJson('/api/summary')->assertOk()->json();

        // Every month in range, the empty one included as 0.
        $this->assertSame(['2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07'],
            array_column($summary['byMonth'], 'month'));
        $this->assertSame(0, $summary['byMonth'][5]['count']);
        $this->assertSame(['month' => '2025-07', 'count' => 10], $summary['latestMonth']);
        $this->assertSame(90, $summary['byHour'][14]);

        // Severity and status carry no information here, so they are excluded, not scored.
        $this->assertFalse($summary['severityTracked']);
        $this->assertFalse($summary['statusTracked']);
        $safety = $summary['safety'];
        $this->assertEqualsCanonicalizing(['Accident Severity', 'Case Resolution'], array_column($safety['excluded'], 'name'));
        $this->assertEqualsCanonicalizing(['frequency', 'spread'], array_column($safety['categories'], 'key'));

        // Frequency: last 3 months average 10 vs 8.33 for the 6 before (the gap month counts as 0),
        // a 20% rise, which scores 50 - 20 = 30. Spread: Plainview has 60% of the last 3 months,
        // which scores 100 - 120 -> 0. Overall is their average.
        $scores = array_column($safety['categories'], 'score', 'key');
        $this->assertSame(30, $scores['frequency']);
        $this->assertSame(0, $scores['spread']);
        $this->assertSame(15, $safety['overall']);
        $this->assertSame('Needs attention', $safety['level']);
        $this->assertSame(15, end($safety['trend'])['score']);
    }

    public function test_the_severity_classifier_trains_on_mixed_severities_with_kde_density(): void
    {
        // Accidents at a busy Plainview spot are mostly Injury; the quiet Hulo spot is Minor.
        $rows = [];
        foreach (range(1, 40) as $n) {
            $busy = $n <= 30;
            $rows[] = ['barangay' => $busy ? 'Plainview' : 'Hulo', 'road' => 'Unknown',
                'sev' => $busy ? ($n % 5 === 0 ? 'Minor' : 'Injury') : 'Minor', 'type' => 'Vehicular Collision',
                'date' => '2025-0' . (1 + $n % 6) . '-1' . ($n % 9), 'time' => sprintf('%02d:%02d:00', $n % 24, $n),
                'lat' => $busy ? 14.576024 : 14.570376, 'lng' => $busy ? 121.035561 : 121.031403];
        }
        $this->postJson('/api/incidents/bulk', ['records' => $rows], $this->adminHeaders())->assertStatus(201);

        $severity = $this->getJson('/api/severity')->assertOk()->json();

        $this->assertSame(40, $severity['total']);
        $this->assertEquals(['sev' => 'Injury', 'count' => 24, 'percent' => 60], $severity['distribution'][0]);
        $this->assertEquals(['sev' => 'Minor', 'count' => 16, 'percent' => 40], $severity['distribution'][1]);
        $this->assertSame('Plainview', $severity['byBarangay'][0]['barangay']);
        $this->assertEquals(80.0, $severity['byBarangay'][0]['severePercent']);

        $model = $severity['model'];
        $this->assertTrue($model['trained']);
        $this->assertSame(['Injury' => 24, 'Minor' => 16], $model['classCounts']);
        $this->assertContains('KDE density at the location', array_column($model['featureImportances'], 'feature'));
    }

    public function test_an_administrator_deletes_every_filtered_accident_in_one_request(): void
    {
        $rows = [];
        foreach (['2023-05-01', '2023-11-20', '2024-02-14', '2024-02-15'] as $n => $date) {
            $rows[] = ['barangay' => 'Plainview', 'road' => 'Unknown', 'sev' => 'Minor', 'type' => 'Vehicular Collision',
                'date' => $date, 'time' => "0{$n}:00:00"];
        }
        $created = $this->postJson('/api/incidents/bulk', ['records' => $rows], $this->adminHeaders())
            ->assertStatus(201)->json('created');
        $byDate = array_column($created, 'id', 'date');

        // "Year 2023" in the console sends exactly the ids it lists; one unknown id is ignored.
        $result = $this->postJson('/api/incidents/bulk-delete',
            ['ids' => [$byDate['2023-05-01'], $byDate['2023-11-20'], '#A99999']], $this->adminHeaders())
            ->assertOk()->json();

        $this->assertSame(['deletedCount' => 2, 'notFoundCount' => 1], $result);
        $this->assertEqualsCanonicalizing(['2024-02-14', '2024-02-15'], array_column($this->getJson('/api/incidents')->json(), 'date'));

        // One notification for the whole batch, saying what went and who removed it.
        $latest = $this->getJson('/api/notifications', $this->adminHeaders())->assertOk()->json()[0];
        $this->assertSame('incident_deleted', $latest['type']);
        $this->assertSame('Accident reports deleted', $latest['title']);
        $this->assertStringContainsString('2 accident reports dated 2023-05-01 to 2023-11-20 were deleted by', $latest['desc']);
        $this->assertStringContainsString($byDate['2023-05-01'], $latest['desc']);

        // Deleting a single row notifies too.
        $this->deleteJson('/api/incidents/' . rawurlencode($byDate['2024-02-14']), [], $this->adminHeaders())->assertOk();
        $latest = $this->getJson('/api/notifications', $this->adminHeaders())->json()[0];
        $this->assertSame('Accident report deleted', $latest['title']);
        $this->assertStringStartsWith("{$byDate['2024-02-14']} (2024-02-14, Plainview) was deleted by", $latest['desc']);

        $this->postJson('/api/incidents/bulk-delete', ['ids' => []], $this->adminHeaders())->assertStatus(400);
    }

    public function test_the_spatial_schema_holds_the_27_barangay_polygons(): void
    {
        $barangays = \Illuminate\Support\Facades\DB::table('barangays')->get();

        $this->assertCount(27, $barangays);
        foreach ($barangays as $row) {
            $this->assertSame(4326, (int) $row->srid);
            $this->assertStringStartsWith('MULTIPOLYGON(((', $row->geom_wkt);
            $this->assertGreaterThan(0, $row->area_km2);
            $this->assertTrue($row->min_lat < $row->centroid_lat && $row->centroid_lat < $row->max_lat, $row->name);
        }
        // Mandaluyong is about 11 km² in all.
        $this->assertEqualsWithDelta(11.0, $barangays->sum('area_km2'), 1.5);

        // The geohash encoder matches the published reference value.
        $this->assertSame('u4pruydqqvj', \App\Services\SpatialService::geohash(57.64911, 10.40744, 11));
    }

    public function test_every_accident_is_located_by_its_coordinates(): void
    {
        $base = ['road' => 'Unknown', 'sev' => 'Minor', 'type' => 'Vehicular Collision', 'date' => '2025-03-01'];
        $rows = [
            $base + ['barangay' => 'Plainview', 'time' => '01:00:00', 'lat' => 14.576024, 'lng' => 121.035561], // inside
            $base + ['barangay' => 'Hulo', 'time' => '02:00:00', 'lat' => 14.576024, 'lng' => 121.035561],      // point is in Plainview
            $base + ['barangay' => 'Plainview', 'time' => '03:00:00', 'lat' => 14.64218, 'lng' => 121.047081],  // north of the city
            $base + ['barangay' => 'Plainview', 'time' => '04:00:00'],                                           // no coordinates
        ];
        $ids = array_column($this->postJson('/api/incidents/bulk', ['records' => $rows], $this->adminHeaders())
            ->assertStatus(201)->json('created'), 'id');

        $stored = \Illuminate\Support\Facades\DB::table('incidents')->whereIn('id', $ids)->orderBy('time')->get();
        $plainviewId = \Illuminate\Support\Facades\DB::table('barangays')->where('name', 'Plainview')->value('id');

        $this->assertSame(['inside', 'other_barangay', 'outside_city', 'no_location'], $stored->pluck('location_status')->all());
        $this->assertSame('POINT(121.035561 14.576024)', $stored[0]->geom_wkt);
        $this->assertSame(7, strlen($stored[0]->geohash));
        $this->assertEquals($plainviewId, $stored[0]->barangay_id);
        $this->assertEquals($plainviewId, $stored[1]->barangay_id); // located by the point, not the typed name
        $this->assertNull($stored[2]->barangay_id);
        $this->assertNull($stored[3]->geom_wkt);

        $summary = $this->getJson('/api/spatial/summary')->assertOk()->json();
        $this->assertSame(['inside' => 1, 'other_barangay' => 1, 'outside_city' => 1, 'no_location' => 1], $summary['locationStatus']);
        $plainview = collect($summary['barangays'])->firstWhere('barangay', 'Plainview');
        $this->assertSame(2, $plainview['accidentsInside']);
        $this->assertSame(1, $plainview['recordsNamingAnotherBarangay']);

        // Moving the point into Hulo re-locates the record on save.
        $this->putJson('/api/incidents/' . rawurlencode($ids[1]), ['lat' => 14.570376, 'lng' => 121.031403], $this->adminHeaders())->assertOk();
        $moved = \Illuminate\Support\Facades\DB::table('incidents')->where('id', $ids[1])->first();
        $this->assertSame('inside', $moved->location_status);
        $this->assertSame('Hulo', \Illuminate\Support\Facades\DB::table('barangays')->where('id', $moved->barangay_id)->value('name'));
    }

    public function test_nearby_accidents_are_found_through_the_geohash_index(): void
    {
        $base = ['road' => 'Unknown', 'sev' => 'Minor', 'type' => 'Vehicular Collision', 'date' => '2025-03-01'];
        $rows = [
            $base + ['barangay' => 'Plainview', 'time' => '01:00:00', 'lat' => 14.576024, 'lng' => 121.035561],
            $base + ['barangay' => 'Plainview', 'time' => '02:00:00', 'lat' => 14.576924, 'lng' => 121.035561], // ~100 m north
            $base + ['barangay' => 'Hulo', 'time' => '03:00:00', 'lat' => 14.570376, 'lng' => 121.031403],      // ~770 m away
        ];
        $this->postJson('/api/incidents/bulk', ['records' => $rows], $this->adminHeaders())->assertStatus(201);

        $near = $this->getJson('/api/spatial/nearby?lat=14.576024&lng=121.035561&radius=150')->assertOk()->json();
        $this->assertSame('Plainview', $near['barangay']);
        $this->assertSame(2, $near['count']);
        $this->assertEquals(0, $near['incidents'][0]['distanceMeters']);
        $this->assertEqualsWithDelta(100, $near['incidents'][1]['distanceMeters'], 2);

        $wide = $this->getJson('/api/spatial/nearby?lat=14.576024&lng=121.035561&radius=1000')->assertOk()->json();
        $this->assertSame(3, $wide['count']);
        $this->assertEqualsWithDelta(770, $wide['incidents'][2]['distanceMeters'], 30);

        $this->getJson('/api/spatial/nearby?lat=14.57&lng=abc')->assertStatus(400);
    }

    public function test_the_prone_area_model_says_why_it_cannot_train_on_a_short_history(): void
    {
        $rows = [];
        foreach (['2025-01', '2025-02', '2025-03'] as $month) {
            $rows[] = ['barangay' => 'Plainview', 'road' => 'Unknown', 'sev' => 'Minor', 'type' => 'Vehicular Collision',
                'date' => "{$month}-10", 'time' => '08:00:00', 'lat' => 14.576024, 'lng' => 121.035561];
        }
        $this->postJson('/api/incidents/bulk', ['records' => $rows], $this->adminHeaders())->assertStatus(201);

        $prone = $this->getJson('/api/prone-areas')->assertOk()->json();

        $this->assertFalse($prone['trained']);
        $this->assertSame('Needs at least 18 months of records; there are 3.', $prone['reason']);
        $this->assertSame([], $prone['cells']);
    }

    public function test_the_prone_area_model_learns_from_kde_features_and_is_tested_on_unseen_months(): void
    {
        // Two years: a busy Plainview spot every month, a quiet Hulo spot now and then.
        $rows = [];
        foreach (range(0, 23) as $i) {
            $month = sprintf('%04d-%02d', 2024 + intdiv($i, 12), $i % 12 + 1);
            foreach (range(1, 5) as $n) {
                $rows[] = ['barangay' => 'Plainview', 'road' => 'Unknown', 'sev' => 'Minor', 'type' => 'Vehicular Collision',
                    'date' => "{$month}-0{$n}", 'time' => '08:00:00', 'lat' => 14.576024, 'lng' => 121.035561];
            }
            if ($i % 4 === 0) {
                $rows[] = ['barangay' => 'Hulo', 'road' => 'Unknown', 'sev' => 'Minor', 'type' => 'Vehicular Collision',
                    'date' => "{$month}-15", 'time' => '08:00:00', 'lat' => 14.570376, 'lng' => 121.031403];
            }
        }
        $this->postJson('/api/incidents/bulk', ['records' => $rows], $this->adminHeaders())->assertStatus(201);

        $prone = $this->getJson('/api/prone-areas')->assertOk()->json();

        $this->assertTrue($prone['trained'], (string) $prone['reason']);
        $model = $prone['model'];
        // Tested on the last 3 months, which training never saw; predicting the 3 after.
        $this->assertSame(['from' => '2025-10', 'to' => '2025-12'], $model['testPeriod']);
        $this->assertSame(['from' => '2026-01', 'to' => '2026-03'], $model['predictionPeriod']);
        $this->assertGreaterThan(0, $model['kdeImportanceShare']);
        $this->assertEqualsCanonicalizing(['accuracy', 'precision', 'recall', 'f1', 'rocAuc'], array_keys($model['metrics']));

        // The busy spot's cell is predicted high; the barangay leads the ranking.
        $this->assertSame('Plainview', $prone['barangays'][0]['barangay']);
        $this->assertSame('high', $prone['barangays'][0]['level']);
    }

    private function residentHeaders(): array
    {
        return ['Authorization' => 'Bearer ' . $this->tokenFor('juan@example.com', 'Test-Resident#2026')];
    }

    public function test_residents_are_notified_of_new_accidents_without_seeing_who_entered_them(): void
    {
        // The hotspot check that rides along with the poll is covered on its own below.
        $this->mock(\App\Services\AnalyticsService::class, fn ($m) => $m->shouldReceive('hotspots')->andReturn([]));
        $resident = $this->residentHeaders();

        // A new account starts with nothing unread, whatever was posted before it signed up.
        $this->getJson('/api/alerts', $resident)->assertOk()->assertJson(['unread' => 0]);

        $this->postJson('/api/incidents', [
            'barangay' => 'Plainview', 'road' => 'Boni Ave', 'sev' => 'Injury',
            'type' => 'Vehicular Collision', 'date' => '2026-09-01',
        ], $this->adminHeaders())->assertStatus(201);

        $this->postJson('/api/incidents/bulk', ['records' => [
            ['barangay' => 'Hulo', 'road' => 'J.P. Rizal', 'sev' => 'Minor', 'type' => 'Sideswipe', 'date' => '2026-08-15'],
            ['barangay' => 'Hulo', 'road' => 'Coronado St', 'sev' => 'Minor', 'type' => 'Sideswipe', 'date' => '2026-08-16'],
        ]], $this->adminHeaders())->assertStatus(201);

        $feed = $this->getJson('/api/alerts', $resident)->assertOk()
            ->assertJsonPath('unread', 2)
            ->assertJsonPath('items.0.title', '2 new accident reports')
            ->assertJsonPath('items.1.title', 'New accident reported')
            ->assertJsonPath('items.1.desc', 'Injury Vehicular Collision on Boni Ave, Plainview (2026-09-01).')
            ->assertJsonPath('items.1.unread', true);
        $this->assertStringNotContainsString('admin@rimas.gov.ph', $feed->getContent());

        $this->postJson('/api/alerts/read-all', [], $resident)->assertOk();
        $this->getJson('/api/alerts', $resident)->assertOk()
            ->assertJsonPath('unread', 0)
            ->assertJsonPath('items.0.unread', false);

        $this->getJson('/api/alerts')->assertStatus(401);
        $this->postJson('/api/alerts/read-all')->assertStatus(401);
    }

    public function test_residents_are_notified_when_a_new_hotspot_appears(): void
    {
        $peak = fn (string $road, string $barangay) => ['road' => $road, 'barangay' => $barangay, 'incidentCount' => 7];
        $runs = [
            [$peak('Boni Ave', 'Plainview')],
            [$peak('Boni Ave', 'Plainview'), $peak('Shaw Blvd', 'Wack-Wack')],
            [$peak('Shaw Blvd', 'Wack-Wack')],
        ];
        $analytics = \Mockery::mock(\App\Services\AnalyticsService::class);
        $analytics->shouldReceive('hotspots')->andReturnUsing(function () use (&$runs) {
            return array_shift($runs);
        });
        $alerts = app(\App\Services\ResidentNotificationService::class);

        // The first run only learns what the hotspots are.
        $this->assertNull($alerts->checkForNewHotspots($analytics));
        // Nothing changed since: not even computed again.
        $this->assertNull($alerts->checkForNewHotspots($analytics));

        Setting::touchDataVersion();
        $notification = $alerts->checkForNewHotspots($analytics);
        $this->assertSame('New accident hotspot', $notification->title);
        $this->assertStringStartsWith('Shaw Blvd, Wack-Wack is now a hotspot, with 7 accidents', $notification->desc);
        $this->assertSame('hotspots.html', $notification->link);

        // A hotspot that went away is not news.
        Setting::touchDataVersion();
        $this->assertNull($alerts->checkForNewHotspots($analytics));
    }
}
