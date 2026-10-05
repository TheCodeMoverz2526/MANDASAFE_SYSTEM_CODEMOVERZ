<?php

namespace App\Console\Commands;

use App\Models\Account;
use App\Models\Incident;
use App\Models\PredictionInput;
use App\Models\RimasSession;
use App\Models\Setting;
use App\Services\AccountService;
use App\Services\SpatialService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * Moves the old data/store.json into the database, once.
 *
 * Everything transfers as-is except passwords: the JSON store held Node scrypt hashes, which
 * PHP cannot verify, so every account gets a new password — --fallback-password if given,
 * otherwise a random one per account — listed at the end so each owner can be told or can
 * use "Forgot password?". No password is built into the code.
 */
class ImportLegacyStore extends Command
{
    protected $signature = 'mandasafe:import
                            {--path= : Path to store.json (defaults to config mandasafe.legacy_store)}
                            {--fresh : Delete existing rows before importing}
                            {--fallback-password= : Password given to every imported account (default: a random one each)}';

    protected $description = 'Import the legacy data/store.json into the MandaSafe database';


    public function handle(): int
    {
        $path = $this->option('path') ?: config('mandasafe.legacy_store');

        if (! is_string($path) || ! is_file($path)) {
            $this->error("No store file at {$path}");

            return self::FAILURE;
        }

        $store = json_decode((string) file_get_contents($path), true);
        if (! is_array($store)) {
            $this->error("Could not parse {$path} as JSON.");

            return self::FAILURE;
        }

        if ($this->option('fresh')) {
            RimasSession::query()->delete();
            Incident::query()->delete();
            PredictionInput::query()->delete();
            Account::query()->delete();
            $this->warn('Cleared existing MandaSafe rows.');
        }

        $incidents = $store['incidents'] ?? [];
        $inputs = $store['predictionInputs'] ?? [];
        $accounts = $store['accounts'] ?? [];
        $sessions = $store['sessions'] ?? [];

        $reset = [];
        $fallback = (string) $this->option('fallback-password');

        DB::transaction(function () use ($incidents, $inputs, $accounts, $sessions, $store, $fallback, &$reset) {
            foreach ($accounts as $account) {
                $email = Account::normaliseEmail($account['email'] ?? '');
                $password = $fallback !== '' ? $fallback : \Illuminate\Support\Str::password(16, symbols: false);
                $reset[$email] = $password;

                Account::updateOrCreate(['id' => $account['id']], [
                    'name' => $account['name'] ?? 'Unnamed',
                    'email' => $email,
                    'phone' => Account::normalisePhone($account['phone'] ?? ''),
                    'role' => $account['role'] ?? 'user',
                    'dept' => $account['dept'] ?? null,
                    'status' => $account['status'] ?? 'active',
                    'password' => Hash::make($password),
                    'created_at_iso' => $account['createdAt'] ?? AccountService::isoNow(),
                    'updated_at_iso' => $account['updatedAt'] ?? null,
                    'last_login_at_iso' => $account['lastLoginAt'] ?? null,
                ]);
            }

            // The JSON array was newest-first, so the first row gets the highest sort key and
            // the newest-first ordering survives the move to a table.
            $total = count($incidents);
            $rows = [];
            foreach (array_values($incidents) as $index => $incident) {
                // upsert() skips model events, so the spatial columns are set here directly.
                $rows[] = SpatialService::incidentColumns($incident['lat'] ?? null, $incident['lng'] ?? null, $incident['barangay'] ?? null) + [
                    'id' => $incident['id'],
                    'date' => $incident['date'] ?? null,
                    'time' => $incident['time'] ?? '',
                    'loc' => $incident['loc'] ?? 'Mandaluyong',
                    'barangay' => $incident['barangay'] ?? null,
                    'road' => $incident['road'] ?? null,
                    'sev' => $incident['sev'] ?? null,
                    'type' => $incident['type'] ?? null,
                    'lat' => isset($incident['lat']) && is_numeric($incident['lat']) ? (float) $incident['lat'] : null,
                    'lng' => isset($incident['lng']) && is_numeric($incident['lng']) ? (float) $incident['lng'] : null,
                    'status' => $incident['status'] ?? 'active',
                    'created_by' => $incident['createdBy'] ?? null,
                    'created_at_iso' => $incident['createdAt'] ?? null,
                    'updated_by' => $incident['updatedBy'] ?? null,
                    'updated_at_iso' => $incident['updatedAt'] ?? null,
                    'sort_key' => $total - $index,
                ];
            }
            foreach (array_chunk($rows, 500) as $chunk) {
                Incident::upsert($chunk, ['id']);
            }

            $totalInputs = count($inputs);
            foreach (array_values($inputs) as $index => $input) {
                PredictionInput::updateOrCreate(['id' => $input['id']], [
                    'barangay' => $input['barangay'],
                    'road' => $input['road'] ?? 'All Roads',
                    'month' => $input['month'],
                    'incident_count' => (int) ($input['incidentCount'] ?? 0),
                    'notes' => $input['notes'] ?? '',
                    'updated_by' => $input['updatedBy'] ?? null,
                    'updated_at_iso' => $input['updatedAt'] ?? null,
                    'sort_key' => $totalInputs - $index,
                ]);
            }

            // Carrying the sessions over means anyone signed in stays signed in.
            foreach ($sessions as $session) {
                RimasSession::updateOrCreate(['token' => $session['token']], [
                    'account_id' => $session['accountId'],
                    'created_at_iso' => $session['createdAt'] ?? null,
                    'expires_at_iso' => $session['expiresAt'] ?? null,
                ]);
            }

            Setting::put('nextIncidentSeq', $store['nextIncidentSeq'] ?? (count($incidents) + 1));
            Setting::put('nextInputSeq', $store['nextInputSeq'] ?? (count($inputs) + 1));
            Setting::put('nextAccountSeq', $store['nextAccountSeq'] ?? (count($accounts) + 1));
            Setting::touchDataVersion();
        });

        $this->info(sprintf(
            'Imported %d accidents, %d prediction inputs, %d accounts, %d sessions.',
            count($incidents),
            count($inputs),
            count($accounts),
            count($sessions)
        ));

        if ($reset !== []) {
            $this->newLine();
            $this->warn('Passwords cannot be carried over, so every account has a new one:');
            foreach ($reset as $email => $password) {
                $this->line('  - ' . $email . '  ' . $password);
            }
            $this->line('Each owner can change it from "Forgot password?" on the sign-in page.');
        }

        return self::SUCCESS;
    }
}
