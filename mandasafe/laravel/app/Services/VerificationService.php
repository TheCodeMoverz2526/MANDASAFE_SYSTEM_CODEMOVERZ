<?php

namespace App\Services;

use App\Exceptions\RimasException;
use App\Models\Account;
use App\Models\OtpChallenge;
use App\Models\RimasSession;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\RateLimiter;

/**
 * The verification step behind signing in, signing up and resetting a password.
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
    /** How long a code stays usable. Keep OTP_SMS_INTERVAL in step with this. */
    public const CHALLENGE_TTL_SECONDS = 600;

    /** Guesses allowed per challenge, counted across every code it sent. */
    public const MAX_ATTEMPTS = 5;

    /** Codes that may be sent for one challenge, first one included. */
    public const MAX_SENDS = 5;

    /** Enforced server-side as well as by the countdown on the page. */
    public const RESEND_COOLDOWN_SECONDS = 30;

    /** How long a verified reset challenge may still be used to set the new password. */
    public const VERIFIED_TTL_SECONDS = 600;

    public function __construct(private AccountService $accounts, private OtpService $otp)
    {
    }

    /* ------------------------------------------------------------------ starting points */

    /**
     * Step one of signing in: the password is checked now, but no session is created. Until
     * the code is accepted the caller holds nothing more useful than a challenge id.
     */
    public function startLogin(array $body, string $ip): array
    {
        $identifier = trim((string) ($body['identifier'] ?? ''));

        $this->throttle('login-ip:' . $ip, 20, 300, 'Too many sign-in attempts. Please wait a few minutes and try again.');
        $this->throttle('login-id:' . strtolower($identifier), 8, 900, 'Too many sign-in attempts for this account. Please wait a few minutes and try again.');

        $account = $this->accounts->verifyCredentials($identifier, $body['password'] ?? '');

        // The password was right, so this attempt should not count against the account.
        RateLimiter::clear('login-id:' . strtolower($identifier));

        return $this->begin('login', [
            'account_id' => $account->id,
            'identifier' => $account->email,
            'name' => $account->name,
            'email' => $account->email,
            'phone' => $account->phone,
        ], $ip);
    }

    /**
     * Step one of signing up. The details are validated in full now — a duplicate email or a
     * short password should be reported before an SMS is paid for — but the account is only
     * created once the code is accepted, so an unverified number never becomes an account.
     */
    public function startRegistration(array $body, string $ip): array
    {
        $this->throttle('register-ip:' . $ip, 10, 3600, 'Too many sign-up attempts from this connection. Please try again later.');

        $details = $this->accounts->validateRegistration($body);

        return $this->begin('register', [
            'identifier' => $details['email'],
            'name' => $details['name'],
            'email' => $details['email'],
            'phone' => $details['phone'],
            'payload' => $details,
        ], $ip);
    }

    /** Step one of "Forgot password?" — nothing about the account changes until the code is accepted. */
    public function startReset(array $body, string $ip): array
    {
        $this->throttle('reset-ip:' . $ip, 10, 3600, 'Too many password reset requests from this connection. Please try again later.');

        $identifier = trim((string) ($body['identifier'] ?? ''));
        $account = $this->accounts->findAccount($identifier);

        if (! $account) {
            throw new RimasException('We could not find an account with that email address or phone number.');
        }
        if ($account->status === 'inactive') {
            throw new RimasException('This account has been deactivated. Contact an administrator.');
        }

        return $this->begin('reset', [
            'account_id' => $account->id,
            'identifier' => $account->email,
            'name' => $account->name,
            'email' => $account->email,
            'phone' => $account->phone,
        ], $ip);
    }

    /* -------------------------------------------------------------------- send / verify */

    /** Sends (or resends) the code for a challenge on the channel the person picked. */
    public function send(array $body, string $ip): array
    {
        $challenge = $this->activeChallenge($body['challengeId'] ?? null);
        $channel = (string) ($body['channel'] ?? '');

        if (! in_array($channel, ['email', 'sms'], true)) {
            throw new RimasException('Choose email or SMS.');
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
            'expiresIn' => self::CHALLENGE_TTL_SECONDS,
            'resendIn' => self::RESEND_COOLDOWN_SECONDS,
            'sendsLeft' => self::MAX_SENDS - $challenge->sends,
            // Only ever populated with OTP_TEST_MODE=true, where no provider is contacted.
            'testCode' => $this->otp->testMode() ? $code : null,
        ], fn ($value) => $value !== null);
    }

    /**
     * Checks the digits and, when they are right, does the thing the challenge was for:
     * issues the session, creates the account, or unlocks the new-password step.
     */
    public function verify(array $body, string $ip): array
    {
        $challenge = $this->activeChallenge($body['challengeId'] ?? null);
        $code = preg_replace('/\D/', '', (string) ($body['code'] ?? ''));

        if (! $challenge->channel) {
            throw new RimasException('Request a verification code first.');
        }
        if (! preg_match('/^\d{6}$/', (string) $code)) {
            throw new RimasException('Enter the six-digit code from your ' . ($challenge->channel === 'email' ? 'email' : 'phone') . '.');
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
            'register' => $this->completeRegistration($challenge),
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

    private function completeRegistration(OtpChallenge $challenge): array
    {
        $details = $challenge->payload;

        if (! is_array($details)) {
            $this->discard($challenge);

            throw new RimasException('These sign-up details are no longer available. Please start again.');
        }

        // Re-checked at the last moment: the address or number may have been taken while the
        // code was in transit.
        $account = $this->accounts->createAccount($this->accounts->validateRegistration($details));

        $this->consume($challenge);

        return ['registered' => true, 'account' => $account];
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

    private function generateCode(): string
    {
        if ($this->otp->testMode()) {
            return str_pad(preg_replace('/\D/', '', (string) config('mandasafe.otp.test_code')) ?: '123456', 6, '0', STR_PAD_LEFT);
        }

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
