<?php

namespace Tests\Feature;

use App\Models\Account;
use App\Models\Incident;
use App\Models\Setting;
use App\Services\AccountService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
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
            'password' => Hash::make('Admin@2026'), 'created_at_iso' => AccountService::isoNow(),
        ]);

        $this->resident = Account::create([
            'id' => 'USR-1002', 'name' => 'Juan Dela Cruz', 'email' => 'juan@example.com',
            'phone' => '+639170000002', 'role' => 'user', 'dept' => 'Resident', 'status' => 'active',
            'password' => Hash::make('Resident2026'), 'created_at_iso' => AccountService::isoNow(),
        ]);
    }

    /**
     * Signing in is two calls now: the password opens a challenge, the code closes it. The
     * tests run in OTP test mode (see setUp), where the code comes back in the send reply.
     */
    private function tokenFor(string $identifier, string $password): string
    {
        $challengeId = $this->postJson('/api/auth/login', ['identifier' => $identifier, 'password' => $password])
            ->assertOk()
            ->json('challengeId');

        $code = $this->postJson('/api/auth/otp/send', ['challengeId' => $challengeId, 'channel' => 'sms'])
            ->assertOk()
            ->json('testCode');

        return $this->postJson('/api/auth/otp/verify', ['challengeId' => $challengeId, 'code' => $code])
            ->assertOk()
            ->json('token');
    }

    private function adminHeaders(): array
    {
        return ['Authorization' => 'Bearer ' . $this->tokenFor('admin@rimas.gov.ph', 'Admin@2026')];
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

        $residentHeaders = ['Authorization' => 'Bearer ' . $this->tokenFor('juan@example.com', 'Resident2026')];

        $this->postJson('/api/incidents', [], $residentHeaders)->assertStatus(403);
        $this->getJson('/api/accounts', $residentHeaders)->assertStatus(403);
        $this->deleteJson('/api/incidents/' . rawurlencode('#A10001'), [], $residentHeaders)->assertStatus(403);
    }

    public function test_sign_in_rejects_a_wrong_password(): void
    {
        $this->postJson('/api/auth/login', ['identifier' => 'admin@rimas.gov.ph', 'password' => 'wrong'])
            ->assertStatus(401)
            ->assertJson(['error' => 'Incorrect email/phone number or password.']);
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
        $this->assertSame('Duplicate of an existing incident', $response->json('skipped.0.reason'));
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
            ->assertJson(['error' => 'Incident count must be a non-negative number.']);

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

    public function test_sign_up_never_grants_the_admin_role(): void
    {
        $challengeId = $this->postJson('/api/auth/register', [
            'name' => 'Sneaky User', 'email' => 'sneaky@example.com',
            'phone' => '+639171110004', 'password' => 'Testing2026', 'role' => 'admin',
        ])->assertOk()->json('challengeId');

        $code = $this->postJson('/api/auth/otp/send', ['challengeId' => $challengeId, 'channel' => 'email'])
            ->assertOk()->json('testCode');

        $this->postJson('/api/auth/otp/verify', ['challengeId' => $challengeId, 'code' => $code])
            ->assertOk()
            ->assertJson(['registered' => true, 'account' => ['role' => 'user']]);
    }

    public function test_signing_out_invalidates_the_token(): void
    {
        $headers = ['Authorization' => 'Bearer ' . $this->tokenFor('juan@example.com', 'Resident2026')];

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
            'bySeverity' => [['sev', 'count']],
            'topPredictions', 'recent',
        ]);
    }
}
