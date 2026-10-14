<?php

namespace App\Services;

use App\Exceptions\RimasException;
use App\Models\Account;
use App\Models\AccountActivity;
use App\Models\OtpChallenge;
use App\Models\RimasSession;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\RateLimiter;

/**
 * The verification step behind signing in and resetting a password, and signing up (which
 * needs no code).
 *
 * Everything that decides the outcome happens here, on the server:
 *
 *   - the code is generated here (or by the SMS provider) and is never sent to the browser,
 *   - how many codes may be requested, and how many guesses each one allows, is counted in
 *     the database, not in a variable a person can edit in the developer console,
 *   - a sign-in issues its session token only after the code is accepted, and a password
 *     reset is refused unless the challenge it quotes was verified moments earlier.
 *
 * The browser only ever holds a challenge id — a random 32-byte handle that means nothing on
 * its own and is useless once the challenge is consumed.
 */
class VerificationService
{
    /** How long a challenge (the whole reset attempt, resends included) stays open. */
    public const CHALLENGE_TTL_SECONDS = 600;

    /**
     * How long each code stays usable after it is sent. Matches the resend cooldown, so the
     * moment a code expires the person can ask for a new one without starting over.
     */
    public const CODE_TTL_SECONDS = 30;

    /** Guesses allowed per challenge, counted across every code it sent. */
    public const MAX_ATTEMPTS = 5;

    /** Codes that may be sent for one challenge, first one included. */
    public const MAX_SENDS = 5;

    /** Enforced server-side as well as by the countdown on the page. */
    public const RESEND_COOLDOWN_SECONDS = 30;

    /** How long a verified reset challenge may still be used to set the new password. */
    public const VERIFIED_TTL_SECONDS = 600;

    /** How long an administrator has to type the authenticator code after the password. */
    public const TOTP_TTL_SECONDS = 300;

    public function __construct(private AccountService $accounts, private OtpService $otp, private TotpService $totp)
    {
    }

    /* ------------------------------------------------------------------ starting points */

    /**
     * Signing in: a correct password creates a resident's session straight away. An
     * administrator gets no session yet — only a challenge that the code from their
     * authenticator app (TOTP) has to close, see verifyTotp().
     */
    public function startLogin(array $body, string $ip): array
    {
        $identifier = trim((string) ($body['identifier'] ?? ''));

        $this->throttle('login-ip:' . $ip, 20, 300, 'Too many sign-in attempts. Please wait a few minutes and try again.');
        $this->throttle('login-id:' . strtolower($identifier), 8, 900, 'Too many sign-in attempts for this account. Please wait a few minutes and try again.');

        $account = $this->accounts->verifyCredentials($identifier, $body['password'] ?? '');

        // The password was right, so this attempt should not count against the account.
        RateLimiter::clear('login-id:' . strtolower($identifier));

        if ($account->isAdmin()) {
            return $this->startTotp($account, $ip);
        }

        return $this->accounts->createSession($account);
    }

    /**
     * Opens the authenticator step for an administrator. One who has not set up an app yet
     * gets a new secret to scan; it is held encrypted on the challenge and only copied to the
     * account once a code from it has been accepted, so a half-finished setup changes nothing.
     */
    private function startTotp(Account $account, string $ip): array
    {
        $this->prune();

        $enroll = ! $account->totp_enabled_at_iso || ! $account->totp_secret;
        $secret = $enroll ? $this->totp->generateSecret() : null;

        $challenge = OtpChallenge::create([
            'id' => bin2hex(random_bytes(32)),
            'purpose' => 'totp',
            'channel' => 'totp',
            'account_id' => $account->id,
            'identifier' => $account->email,
            'name' => $account->name,
            'payload' => $enroll ? ['secret' => $secret] : null,
            'attempts' => 0,
            'sends' => 0,
            'ip' => $ip,
            'created_at_iso' => AccountService::isoNow(),
            'expires_at_iso' => $this->isoIn(self::TOTP_TTL_SECONDS),
        ]);

        return array_filter([
            'totpRequired' => true,
            'challengeId' => $challenge->id,
            'name' => $account->name,
            'enroll' => $enroll,
            'secret' => $secret,
            'otpauthUri' => $enroll ? $this->totp->provisioningUri($secret, $account->email) : null,
            'expiresIn' => self::TOTP_TTL_SECONDS,
        ], fn ($value) => $value !== null);
    }

    /** Checks the authenticator code for an administrator's sign-in and issues the session. */
    public function verifyTotp(array $body, string $ip): array
    {
        $challenge = $this->activeChallenge($body['challengeId'] ?? null);
        $code = preg_replace('/\D/', '', (string) ($body['code'] ?? ''));

        if ($challenge->purpose !== 'totp') {
            throw new RimasException('This verification is no longer valid. Please start again.');
        }
        if (! preg_match('/^\d{6}$/', (string) $code)) {
            throw new RimasException('Enter the six-digit code from your authenticator app.');
        }
        if ($challenge->attempts >= self::MAX_ATTEMPTS) {
            $this->discard($challenge);

            throw new RimasException('Too many incorrect codes. Please sign in again.');
        }

        $this->throttle('otp-verify-ip:' . $ip, 30, 900, 'Too many verification attempts. Please wait a few minutes and try again.');

        $challenge->attempts = $challenge->attempts + 1;
        $challenge->save();

        $account = Account::find((string) $challenge->account_id);

        if (! $account || $account->status === 'inactive' || ! $account->isAdmin()) {
            $this->discard($challenge);

            throw new RimasException('This account can no longer sign in here. Contact an administrator.');
        }

        $enrolling = ! $account->totp_enabled_at_iso || ! $account->totp_secret;
        $secret = $enrolling ? (string) (($challenge->payload ?? [])['secret'] ?? '') : (string) $account->totp_secret;

        // A code already used for an earlier sign-in is refused, even inside its 30 seconds.
        $step = $secret === '' ? null : $this->totp->verify($secret, $code, $enrolling ? null : $account->totp_last_step);

        if ($step === null) {
            $left = max(0, self::MAX_ATTEMPTS - $challenge->attempts);
            AccountActivity::record($account->id, 'login_failed', 'Wrong authenticator code.');

            if ($left === 0) {
                $this->discard($challenge);

                throw new RimasException('Too many incorrect codes. Please sign in again.');
            }

            throw new RimasException('The authenticator code is incorrect. ' . $left . ' ' . ($left === 1 ? 'try' : 'tries') . ' left.');
        }

        if ($enrolling) {
            $account->totp_secret = $secret;
            $account->totp_enabled_at_iso = AccountService::isoNow();
        }
        $account->totp_last_step = $step;
        $account->save();

        $this->consume($challenge);

        return $this->accounts->createSession($account);
    }

    /**
     * Signing up. No verification code: the details are validated in full and the account is
     * created straight away as a resident. The per-connection limit still applies.
     */
    public function register(array $body, string $ip): array
    {
        $this->throttle('register-ip:' . $ip, 10, 3600, 'Too many sign-up attempts from this connection. Please try again later.');

        $account = $this->accounts->createAccount($this->accounts->validateRegistration($body));

        return ['registered' => true, 'account' => $account];
    }

    /**
     * Step one of "Forgot password?" — nothing about the account changes until the code is
     * accepted. Recovery is by registered email only: the challenge carries no phone number,
     * so the code can only ever go to the address on the account.
     */
    public function startReset(array $body, string $ip): array
    {
        $this->throttle('reset-ip:' . $ip, 10, 3600, 'Too many password reset requests from this connection. Please try again later.');

        $email = Account::normaliseEmail($body['email'] ?? '');

        if (! filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new RimasException('Enter a valid email address.');
        }

        $account = Account::where('email', $email)->first();

        if (! $account) {
            throw new RimasException('We could not find an account with that email address.');
        }
        if ($account->status === 'inactive') {
            throw new RimasException('This account has been deactivated. Contact an administrator.');
        }

        return $this->begin('reset', [
            'account_id' => $account->id,
            'identifier' => $account->email,
            'name' => $account->name,
            'email' => $account->email,
        ], $ip);
    }

    /* -------------------------------------------------------------------- send / verify */

    /** Sends (or resends) the code for a challenge on the channel the person picked. */
    public function send(array $body, string $ip): array
    {
        $challenge = $this->activeChallenge($body['challengeId'] ?? null);
        $channel = (string) ($body['channel'] ?? '');

        if ($challenge->purpose === 'totp') {
            throw new RimasException('Administrators verify with their authenticator app, not by email or SMS.');
        }

        if (! in_array($channel, ['email', 'sms'], true)) {
            throw new RimasException('Choose email or SMS.');
        }
        if ($challenge->purpose === 'reset' && $channel !== 'email') {
            throw new RimasException('Password reset codes are sent by email only.');
        }

        $destination = $channel === 'email' ? (string) $challenge->email : (string) $challenge->phone;

        if (trim($destination) === '') {
            throw new RimasException('This account has no ' . ($channel === 'email' ? 'email address' : 'contact number') . ' on file.');
        }

        if ($challenge->sends >= self::MAX_SENDS) {
            throw new RimasException('Too many codes have been requested. Start again in a few minutes.');
        }

        $waited = $this->secondsSince($challenge->last_sent_at_iso);
        if ($waited !== null && $waited < self::RESEND_COOLDOWN_SECONDS) {
            throw new RimasException('Please wait ' . (self::RESEND_COOLDOWN_SECONDS - $waited) . ' more seconds before asking for another code.');
        }

        // A second ceiling that follows the destination rather than the challenge, so
        // restarting the flow cannot be used to keep messaging the same number.
        $this->throttle('otp-dest:' . strtolower($destination), 8, 3600, 'Too many codes have been sent to that destination in the last hour. Please try again later.');
        $this->throttle('otp-ip:' . $ip, 15, 3600, 'Too many codes have been requested from this connection. Please try again later.');

        $driver = $this->otp->driverFor($channel);
        $managed = $this->otp->providerManagesCode($driver);

        // With a provider-managed channel the digits are the provider's; we never see them.
        $code = $managed ? null : $this->generateCode();

        $result = $this->otp->send($driver, $destination, $code);

        $challenge->channel = $channel;
        $challenge->provider = $driver;
        $challenge->code_hash = $code === null ? null : Hash::make($code);
        $challenge->provider_uuid = $result['uuid'] ?? null;
        $challenge->provider_ref = $result['ref'] ?? null;
        $challenge->sends = $challenge->sends + 1;
        $challenge->last_sent_at_iso = AccountService::isoNow();
        $challenge->expires_at_iso = $this->isoIn(self::CHALLENGE_TTL_SECONDS);
        $challenge->save();

        return array_filter([
            'sent' => true,
            'channel' => $channel,
            'destination' => $channel === 'email' ? $this->maskEmail($destination) : $this->maskPhone($destination),
            'expiresIn' => self::CODE_TTL_SECONDS,
            'resendIn' => self::RESEND_COOLDOWN_SECONDS,
            'sendsLeft' => self::MAX_SENDS - $challenge->sends,
            // Only ever populated with OTP_TEST_MODE=true, where no provider is contacted.
            'testCode' => $this->otp->testMode() ? $code : null,
        ], fn ($value) => $value !== null);
    }

    /**
     * Checks the digits and, when they are right, does the thing the challenge was for:
     * issues the session or unlocks the new-password step.
     */
    public function verify(array $body, string $ip): array
    {
        $challenge = $this->activeChallenge($body['challengeId'] ?? null);
        $code = preg_replace('/\D/', '', (string) ($body['code'] ?? ''));

        if ($challenge->purpose === 'totp') {
            return $this->verifyTotp($body, $ip);
        }
        if (! $challenge->channel) {
            throw new RimasException('Request a verification code first.');
        }
        if (! preg_match('/^\d{6}$/', (string) $code)) {
            throw new RimasException('Enter the six-digit code from your ' . ($challenge->channel === 'email' ? 'email' : 'phone') . '.');
        }

        // Checked before a guess is counted: an expired code is not a wrong code.
        $age = $this->secondsSince($challenge->last_sent_at_iso);
        if ($age === null || $age > self::CODE_TTL_SECONDS) {
            throw new RimasException('This code has expired. Click "Resend code" to get a new one.');
        }

        if ($challenge->attempts >= self::MAX_ATTEMPTS) {
            $this->discard($challenge);

            throw new RimasException('Too many incorrect codes. Please start again.');
        }

        $this->throttle('otp-verify-ip:' . $ip, 30, 900, 'Too many verification attempts. Please wait a few minutes and try again.');

        // Counted before the check, so a provider timeout can never hand out a free guess.
        $challenge->attempts = $challenge->attempts + 1;
        $challenge->save();

        $accepted = $this->otp->providerManagesCode((string) $challenge->provider)
            ? $this->otp->verifyWithProvider((string) $challenge->provider, (string) ($challenge->channel === 'email' ? $challenge->email : $challenge->phone), $code, $challenge->provider_uuid, $challenge->provider_ref)
            : ($challenge->code_hash !== null && Hash::check($code, $challenge->code_hash));

        if (! $accepted) {
            $left = max(0, self::MAX_ATTEMPTS - $challenge->attempts);

            if ($left === 0) {
                $this->discard($challenge);

                throw new RimasException('Too many incorrect codes. Please start again.');
            }

            throw new RimasException('The verification code is incorrect. ' . $left . ' ' . ($left === 1 ? 'try' : 'tries') . ' left.');
        }

        $challenge->verified_at_iso = AccountService::isoNow();
        // The code cannot be replayed: one accepted code, one outcome.
        $challenge->code_hash = null;
        $challenge->provider_uuid = null;
        $challenge->provider_ref = null;
        $challenge->save();

        return match ($challenge->purpose) {
            'login' => $this->completeLogin($challenge),
            'reset' => ['verified' => true, 'purpose' => 'reset', 'challengeId' => $challenge->id],
            default => throw new RimasException('This verification is no longer valid. Please start again.'),
        };
    }

    /** The last step of "Forgot password?", refused unless this challenge was just verified. */
    public function completeReset(array $body): array
    {
        $challenge = OtpChallenge::find((string) ($body['challengeId'] ?? ''));

        if (! $challenge || $challenge->purpose !== 'reset' || ! $challenge->verified_at_iso || $challenge->consumed_at_iso) {
            throw new RimasException('This password reset is no longer valid. Please start again.');
        }

        $age = $this->secondsSince($challenge->verified_at_iso);
        if ($age === null || $age > self::VERIFIED_TTL_SECONDS) {
            $this->discard($challenge);

            throw new RimasException('This password reset has expired. Please start again.');
        }

        $account = $this->accounts->resetPassword($challenge->identifier, (string) ($body['password'] ?? ''));

        $this->consume($challenge);

        // A password change ends every session opened with the old one.
        RimasSession::where('account_id', $account['id'])->delete();
        RateLimiter::clear('login-id:' . strtolower($challenge->identifier));

        return $account;
    }

    /** Abandoning the flow on the page should not leave a usable challenge behind. */
    public function cancel(array $body): array
    {
        $challenge = OtpChallenge::find((string) ($body['challengeId'] ?? ''));

        if ($challenge) {
            $this->discard($challenge);
        }

        return ['cancelled' => true];
    }

    /* -------------------------------------------------------------------------- outcomes */

    private function completeLogin(OtpChallenge $challenge): array
    {
        $account = Account::find((string) $challenge->account_id);

        if (! $account) {
            $this->discard($challenge);

            throw new RimasException('This account no longer exists.');
        }
        if ($account->status === 'inactive') {
            $this->discard($challenge);

            throw new RimasException('This account has been deactivated. Contact an administrator.');
        }

        $this->consume($challenge);

        return $this->accounts->createSession($account);
    }

    /* --------------------------------------------------------------------------- helpers */

    /**
     * Opens a challenge and returns what the page needs to draw the channel screen: the
     * contacts masked, never in full, so a stolen challenge id reveals nothing.
     */
    private function begin(string $purpose, array $fields, string $ip): array
    {
        $this->prune();

        $challenge = OtpChallenge::create(array_merge([
            'id' => bin2hex(random_bytes(32)),
            'purpose' => $purpose,
            'attempts' => 0,
            'sends' => 0,
            'ip' => $ip,
            'created_at_iso' => AccountService::isoNow(),
            'expires_at_iso' => $this->isoIn(self::CHALLENGE_TTL_SECONDS),
        ], $fields));

        $status = $this->otp->status();

        return [
            'challengeId' => $challenge->id,
            'purpose' => $purpose,
            'name' => $challenge->name,
            'email' => $this->maskEmail((string) $challenge->email),
            'phone' => $this->maskPhone((string) $challenge->phone),
            'channels' => [
                'email' => $status['email'] && trim((string) $challenge->email) !== '',
                'sms' => $status['sms'] && trim((string) $challenge->phone) !== '',
            ],
            'testMode' => $status['testMode'],
        ];
    }

    private function activeChallenge($id): OtpChallenge
    {
        $challenge = is_string($id) && preg_match('/^[a-f0-9]{64}$/', $id) ? OtpChallenge::find($id) : null;

        if (! $challenge || $challenge->consumed_at_iso) {
            throw new RimasException('This verification is no longer valid. Please start again.');
        }
        if (strcmp((string) $challenge->expires_at_iso, AccountService::isoNow()) <= 0) {
            $this->discard($challenge);

            throw new RimasException('This code has expired. Please start again.');
        }

        return $challenge;
    }

    /** A fresh random code every time — in test mode too, where it is shown on the page. */
    private function generateCode(): string
    {
        return str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    }

    private function consume(OtpChallenge $challenge): void
    {
        $challenge->consumed_at_iso = AccountService::isoNow();
        $challenge->payload = null;
        $challenge->code_hash = null;
        $challenge->provider_uuid = null;
        $challenge->provider_ref = null;
        $challenge->save();
    }

    private function discard(OtpChallenge $challenge): void
    {
        $challenge->delete();
    }

    /** Nothing here is worth keeping once it is spent, and stale rows are a liability. */
    private function prune(): void
    {
        OtpChallenge::where('expires_at_iso', '<=', $this->isoIn(-3600))->delete();
        OtpChallenge::whereNotNull('consumed_at_iso')
            ->where('consumed_at_iso', '<=', $this->isoIn(-3600))
            ->delete();
    }

    private function throttle(string $key, int $limit, int $decaySeconds, string $message): void
    {
        if (RateLimiter::tooManyAttempts($key, $limit)) {
            throw new RimasException($message);
        }

        RateLimiter::hit($key, $decaySeconds);
    }

    private function isoIn(int $seconds): string
    {
        return now()->utc()->addSeconds($seconds)->format('Y-m-d\TH:i:s.v\Z');
    }

    private function secondsSince(?string $iso): ?int
    {
        if (! $iso) {
            return null;
        }

        try {
            return max(0, now()->utc()->getTimestamp() - (new \DateTimeImmutable($iso))->getTimestamp());
        } catch (\Throwable) {
            return null;
        }
    }

    public function maskEmail(string $email): string
    {
        if (! str_contains($email, '@')) {
            return $email === '' ? '' : str_repeat('•', 6);
        }

        [$name, $domain] = explode('@', $email, 2);

        return mb_substr($name, 0, 2) . str_repeat('•', max(2, mb_strlen($name) - 2)) . '@' . $domain;
    }

    public function maskPhone(string $phone): string
    {
        if (strlen($phone) < 6) {
            return $phone === '' ? '' : str_repeat('•', 6);
        }

        return substr($phone, 0, 4) . ' ' . str_repeat('•', max(4, strlen($phone) - 7)) . substr($phone, -3);
    }
}
