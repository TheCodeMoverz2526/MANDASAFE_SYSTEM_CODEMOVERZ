<?php

namespace App\Services;

use App\Exceptions\RimasException;
use App\Models\Account;
use App\Models\RimasSession;
use App\Models\Setting;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Accounts and sessions — the Laravel counterpart of the old auth.js.
 *
 * Accounts live in the SAME database as incidents and prediction inputs, so an administrator
 * created on the server is the same administrator every browser sees. Passwords are never
 * stored; only a bcrypt hash, verified through Laravel's Hash facade.
 */
class AccountService
{
    public const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

    public const DEFAULT_ADMIN = [
        'name' => 'RIMAS Administrator',
        'email' => 'admin@rimas.gov.ph',
        'phone' => '+639171234567',
        'role' => 'admin',
        'dept' => 'Mandaluyong City TPMO',
        'password' => 'Admin@2026',
    ];

    public function __construct(private NotificationService $notifications)
    {
    }

    /** The timestamp format the browser already parses: 2026-09-02T06:53:36.941Z */
    public static function isoNow(): string
    {
        return now()->utc()->format('Y-m-d\TH:i:s.v\Z');
    }

    public function nextAccountId(): string
    {
        return 'USR-' . (1000 + Setting::nextSequence('nextAccountSeq'));
    }

    public function seedDefaultAdmin(): void
    {
        if (Account::where('email', self::DEFAULT_ADMIN['email'])->exists()) {
            return;
        }

        Account::create([
            'id' => $this->nextAccountId(),
            'name' => self::DEFAULT_ADMIN['name'],
            'email' => self::DEFAULT_ADMIN['email'],
            'phone' => self::DEFAULT_ADMIN['phone'],
            'role' => 'admin',
            'dept' => self::DEFAULT_ADMIN['dept'],
            'status' => 'active',
            'password' => Hash::make(self::DEFAULT_ADMIN['password']),
            'created_at_iso' => self::isoNow(),
            'last_login_at_iso' => null,
        ]);
    }

    /** Accepts either an email address or a contact number, the way the sign-in page does. */
    public function findAccount($identifier): ?Account
    {
        $email = Account::normaliseEmail($identifier);
        $phone = Account::normalisePhone($identifier);

        return Account::where('email', $email)
            ->when(strlen($phone) > 5, fn ($query) => $query->orWhere('phone', $phone))
            ->first();
    }

    /**
     * Everything that can be judged before the account exists: the shape of the details and
     * whether the email or number is already taken.
     *
     * Sign-ups are checked here first and created only once the verification code is
     * accepted (see VerificationService), so a wrong password or a duplicate address is
     * reported straight away rather than after an SMS has been sent and paid for.
     *
     * @return array  the normalised details, ready for createAccount()
     */
    public function validateRegistration(array $body): array
    {
        $name = trim((string) ($body['name'] ?? ''));
        $email = Account::normaliseEmail($body['email'] ?? '');
        $phone = Account::normalisePhone($body['phone'] ?? '');
        $password = (string) ($body['password'] ?? '');

        if (strlen($name) < 2) {
            throw new RimasException('Enter your full name.');
        }
        if (! preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $email)) {
            throw new RimasException('Enter a valid email address.');
        }
        if (strlen($phone) < 9) {
            throw new RimasException('Enter a valid contact number.');
        }
        if (strlen($password) < 8) {
            throw new RimasException('Password must be at least 8 characters.');
        }
        if (Account::where('email', $email)->exists()) {
            throw new RimasException('An account already uses this email address.');
        }
        if (Account::where('phone', $phone)->exists()) {
            throw new RimasException('An account already uses this contact number.');
        }

        // Only the very first account may claim the admin role by itself; every later admin
        // has to be promoted by an existing administrator.
        $role = (($body['role'] ?? null) === 'admin' && Account::count() === 0) ? 'admin' : 'user';

        return [
            'name' => $name,
            'email' => $email,
            'phone' => $phone,
            'password' => $password,
            'role' => $role,
            'dept' => $body['dept'] ?? 'Mandaluyong City Resident',
        ];
    }

    /** Writes an account from details validateRegistration() has already approved. */
    public function createAccount(array $details): array
    {
        $account = Account::create([
            'id' => $this->nextAccountId(),
            'name' => $details['name'],
            'email' => $details['email'],
            'phone' => $details['phone'],
            'role' => $details['role'] ?? 'user',
            'dept' => $details['dept'] ?? 'Mandaluyong City Resident',
            'status' => 'active',
            'password' => Hash::make($details['password']),
            'created_at_iso' => self::isoNow(),
            'last_login_at_iso' => null,
        ]);

        $api = $account->toApi();

        // The very first account bootstraps itself as admin, with nobody yet to notify;
        // every account after that is someone the administrators should know arrived.
        if ($account->role === 'user') {
            $this->notifications->notifyAccountCreated($api);
        }

        return $api;
    }

    /**
     * A signed-in account editing its own name, email or contact number — resident or admin,
     * from the profile page rather than User Management. Role, status and dept stay off
     * limits here; those remain an administrator's call via updateAccount().
     */
    public function updateOwnProfile(Account $account, array $body): array
    {
        $changed = [];

        if (array_key_exists('name', $body)) {
            $name = trim((string) $body['name']);
            if (strlen($name) < 2) {
                throw new RimasException('Enter your full name.');
            }
            if ($name !== $account->name) {
                $account->name = $name;
                $changed[] = 'name';
            }
        }

        if (array_key_exists('email', $body)) {
            $email = Account::normaliseEmail($body['email']);
            if (! preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $email)) {
                throw new RimasException('Enter a valid email address.');
            }
            if ($email !== $account->email) {
                if (Account::where('email', $email)->where('id', '!=', $account->id)->exists()) {
                    throw new RimasException('An account already uses this email address.');
                }
                $account->email = $email;
                $changed[] = 'email';
            }
        }

        if (array_key_exists('phone', $body)) {
            $phone = Account::normalisePhone($body['phone']);
            if (strlen($phone) < 9) {
                throw new RimasException('Enter a valid contact number.');
            }
            if ($phone !== $account->phone) {
                if (Account::where('phone', $phone)->where('id', '!=', $account->id)->exists()) {
                    throw new RimasException('An account already uses this contact number.');
                }
                $account->phone = $phone;
                $changed[] = 'phone';
            }
        }

        if ($changed === []) {
            return $account->toApi();
        }

        $account->updated_at_iso = self::isoNow();
        $account->save();

        $api = $account->toApi();
        $this->notifications->notifyProfileUpdated($api, $changed);

        return $api;
    }

    /** Validate and create in one step — what User Management in the console does. */
    public function registerAccount(array $body): array
    {
        return $this->createAccount($this->validateRegistration($body));
    }

    public function verifyCredentials($identifier, $password): Account
    {
        $account = $this->findAccount($identifier);

        if (! $account) {
            throw new RimasException('Incorrect email/phone number or password.');
        }
        if ($account->status === 'inactive') {
            throw new RimasException('This account has been deactivated. Contact an administrator.');
        }
        if (! Hash::check((string) $password, $account->password)) {
            throw new RimasException('Incorrect email/phone number or password.');
        }

        return $account;
    }

    /** Used by the login page to show the masked email / phone on the OTP channel screen. */
    public function contactDetails($identifier): array
    {
        $account = $this->findAccount($identifier);

        if (! $account) {
            throw new RimasException('We could not find an account with that email address or phone number.');
        }

        return ['email' => $account->email, 'phone' => $account->phone, 'name' => $account->name];
    }

    public function resetPassword($identifier, $password): array
    {
        if (strlen((string) $password) < 8) {
            throw new RimasException('Password must be at least 8 characters.');
        }

        $account = $this->findAccount($identifier);
        if (! $account) {
            throw new RimasException('Account not found.');
        }

        $account->password = Hash::make($password);
        $account->updated_at_iso = self::isoNow();
        $account->save();

        return $account->toApi();
    }

    public function listAccounts(): array
    {
        return Account::orderBy('id')->get()->map->toApi()->all();
    }

    private function activeAdminCount(): int
    {
        return Account::where('role', 'admin')->where('status', 'active')->count();
    }

    public function updateAccount(string $id, array $changes): array
    {
        $account = Account::find($id);
        if (! $account) {
            throw new RimasException('User not found.');
        }

        if (array_key_exists('role', $changes) && $changes['role'] !== null) {
            if (! in_array($changes['role'], ['admin', 'user'], true)) {
                throw new RimasException('Role must be "admin" or "user".');
            }
            // Never let the last remaining administrator demote themselves out of the system.
            if ($account->role === 'admin' && $changes['role'] !== 'admin' && $this->activeAdminCount() <= 1) {
                throw new RimasException('At least one active administrator must remain.');
            }
            $account->role = $changes['role'];
        }

        if (array_key_exists('status', $changes) && $changes['status'] !== null) {
            if (! in_array($changes['status'], ['active', 'inactive'], true)) {
                throw new RimasException('Status must be "active" or "inactive".');
            }
            if ($account->role === 'admin' && $changes['status'] === 'inactive' && $this->activeAdminCount() <= 1) {
                throw new RimasException('At least one active administrator must remain.');
            }
            $account->status = $changes['status'];
        }

        if (! empty($changes['name'])) {
            $account->name = trim((string) $changes['name']);
        }
        if (! empty($changes['dept'])) {
            $account->dept = trim((string) $changes['dept']);
        }
        $account->updated_at_iso = self::isoNow();
        $account->save();

        return $account->toApi();
    }

    public function deleteAccount(string $id, ?string $actorEmail = null): array
    {
        $account = Account::find($id);
        if (! $account) {
            throw new RimasException('User not found.');
        }
        if ($account->role === 'admin' && $this->activeAdminCount() <= 1) {
            throw new RimasException('At least one active administrator must remain.');
        }

        $api = $account->toApi();

        RimasSession::where('account_id', $id)->delete();
        $account->delete();

        $this->notifications->notifyAccountRemoved($api, $actorEmail);

        return ['deleted' => $id];
    }

    /* ---------- sessions ---------- */

    public function pruneSessions(): void
    {
        RimasSession::where('expires_at_iso', '<=', self::isoNow())->delete();
    }

    public function createSession(Account $account): array
    {
        $this->pruneSessions();

        $token = bin2hex(random_bytes(24));
        $expiresAt = now()->utc()->addSeconds(self::SESSION_TTL_SECONDS)->format('Y-m-d\TH:i:s.v\Z');

        RimasSession::create([
            'token' => $token,
            'account_id' => $account->id,
            'created_at_iso' => self::isoNow(),
            'expires_at_iso' => $expiresAt,
        ]);

        $account->last_login_at_iso = self::isoNow();
        $account->save();

        return ['token' => $token, 'expiresAt' => $expiresAt, 'account' => $account->toApi()];
    }

    public function destroySession(?string $token): void
    {
        if ($token) {
            RimasSession::where('token', $token)->delete();
        }
    }

    /** Returns the account behind a token, or null when it is missing, expired or disabled. */
    public function accountForToken(?string $token): ?Account
    {
        if (! $token) {
            return null;
        }

        $session = RimasSession::find($token);
        if (! $session || strcmp((string) $session->expires_at_iso, self::isoNow()) <= 0) {
            return null;
        }

        $account = Account::find($session->account_id);

        return ($account && $account->status !== 'inactive') ? $account : null;
    }

    /** Reads the token from an Authorization: Bearer header or an x-rimas-token header. */
    public function tokenFromRequest(Request $request): ?string
    {
        $header = (string) $request->header('authorization', '');
        if (Str::startsWith(strtolower($header), 'bearer ')) {
            return trim(substr($header, 7));
        }

        return $request->header('x-rimas-token');
    }
}
