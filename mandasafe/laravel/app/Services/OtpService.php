<?php

namespace App\Services;

use App\Exceptions\RimasException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Delivery of the six-digit code — nothing else. Who is being verified, how many tries are
 * left and whether a code was accepted is VerificationService's business.
 *
 * Two kinds of provider live behind one interface:
 *
 *   Vocotext iSMS 2FA (SMS)  generates the code itself, substitutes it for %OTP% in the
 *                            message and checks it on its own side. We never see the digits;
 *                            we keep the uuid / sms_id it answers with and hand them back at
 *                            verification time.
 *   Resend (email), Twilio   plain delivery: MandaSafe generates the code and checks it
 *   (SMS), test mode         against the hash it stored. Twilio stays as a fallback for
 *                            deployments that already had it configured.
 *
 * Either way send() answers in the same shape, so nothing else in the system cares which
 * provider is in use.
 */
class OtpService
{
    /** Providers that generate and verify their own code; MandaSafe stores no hash for these. */
    public const PROVIDER_MANAGED = ['vocotext'];

    private function config(string $key)
    {
        return config('mandasafe.otp.' . $key);
    }

    /**
     * Test mode is the fallback for a system with no credentials yet, not a switch that can
     * be left on by accident: the moment a real provider is configured, real codes go out
     * and nothing is echoed back to the browser, whatever OTP_TEST_MODE says.
     */
    public function testMode(): bool
    {
        if ($this->vocotextReady() || $this->twilioReady() || $this->resendReady()) {
            return false;
        }

        return filter_var($this->config('test_mode'), FILTER_VALIDATE_BOOLEAN);
    }

    private function vocotextReady(): bool
    {
        return (bool) ($this->config('vocotext_user') && $this->config('vocotext_pass'));
    }

    private function twilioReady(): bool
    {
        return (bool) ($this->config('twilio_sid') && $this->config('twilio_token') && $this->config('twilio_from'));
    }

    private function resendReady(): bool
    {
        return (bool) ($this->config('resend_key') && $this->config('from_email'));
    }

    /** What the sign-in page reads to decide which channel buttons to offer. */
    public function status(): array
    {
        $testMode = $this->testMode();

        return [
            'testMode' => $testMode,
            'email' => $testMode || $this->resendReady(),
            'sms' => $testMode || $this->vocotextReady() || $this->twilioReady(),
            'smsProvider' => $testMode ? 'test' : ($this->vocotextReady() ? 'vocotext' : ($this->twilioReady() ? 'twilio' : null)),
        ];
    }

    /** Which provider handles this channel right now. */
    public function driverFor(string $channel): string
    {
        if ($this->testMode()) {
            return 'test';
        }

        if ($channel === 'email') {
            if (! $this->resendReady()) {
                throw new RimasException('Email verification is not available. Choose SMS, or ask an administrator to configure email delivery.');
            }

            return 'resend';
        }

        if ($this->vocotextReady()) {
            return 'vocotext';
        }
        if ($this->twilioReady()) {
            return 'twilio';
        }

        throw new RimasException('SMS verification is not available. Choose email, or ask an administrator to configure SMS delivery.');
    }

    /** True when the provider keeps the code itself, so MandaSafe must not generate one. */
    public function providerManagesCode(string $driver): bool
    {
        return in_array($driver, self::PROVIDER_MANAGED, true);
    }

    /**
     * Sends a code to one destination.
     *
     * @param  string|null  $code  the digits to deliver — null for a provider that makes its own
     * @return array{uuid: ?string, ref: ?string}  what verification will need later
     */
    public function send(string $driver, string $destination, ?string $code): array
    {
        return match ($driver) {
            'test' => ['uuid' => null, 'ref' => null],
            'resend' => $this->sendEmail($destination, (string) $code),
            'twilio' => $this->sendTwilio($destination, (string) $code),
            'vocotext' => $this->sendVocotext($destination),
            default => throw new RimasException('No verification provider is configured.'),
        };
    }

    /**
     * Asks a provider-managed channel whether the digits the person typed are the ones it
     * sent. Channels MandaSafe generates codes for never reach this method — those are
     * checked against the stored hash instead.
     */
    public function verifyWithProvider(string $driver, string $destination, string $code, ?string $uuid, ?string $ref): bool
    {
        return match ($driver) {
            'vocotext' => $this->verifyVocotext($destination, $code, $uuid, $ref),
            default => false,
        };
    }

    /* ---------------------------------------------------------------- Vocotext iSMS 2FA */

    /**
     * Vocotext wants the number in two pieces: the country code on its own, and the national
     * number with no country code and no leading zero. Accounts are stored as +639171234567,
     * so the country code is split back off here.
     *
     * @return array{0: string, 1: string}  [country code, national number]
     */
    public function splitPhone(string $phone): array
    {
        $trimmed = trim($phone);
        $digits = preg_replace('/\D/', '', $trimmed);
        $international = str_starts_with($trimmed, '+') || str_starts_with($trimmed, '00');
        $default = (string) $this->config('sms_country_code');

        if ($international) {
            $codes = array_map('strval', (array) $this->config('sms_country_codes'));
            usort($codes, fn ($a, $b) => strlen($b) <=> strlen($a));

            foreach ($codes as $code) {
                if ($code !== '' && str_starts_with($digits, $code)) {
                    $national = ltrim(substr($digits, strlen($code)), '0');
                    if (strlen($national) >= 7) {
                        return [$code, $national];
                    }
                }
            }
        }

        $national = ltrim($digits, '0');

        // A local number typed with its own country code but no plus sign: 639171234567.
        if ($default !== '' && str_starts_with($national, $default) && strlen($national) > 10) {
            $national = ltrim(substr($national, strlen($default)), '0');
        }

        if (strlen($national) < 7 || strlen($national) > 13) {
            throw new RimasException('That contact number is not in a format we can send an SMS to.');
        }

        return [$default, $national];
    }

    private function sendVocotext(string $destination): array
    {
        [$countryCode, $mobile] = $this->splitPhone($destination);

        $data = $this->callVocotext([
            'mobile' => $mobile,
            'country_code' => $countryCode,
            'message' => (string) $this->config('vocotext_message'),
            'type' => (string) $this->config('vocotext_type'),
        ]);

        if (strcasecmp((string) ($data['status'] ?? ''), 'Success') !== 0) {
            throw new RimasException($this->providerMessage($data, 'We could not send the SMS code. Please try again, or choose email.'));
        }

        // Both are needed to verify: the provider ties the code to this pair, not to us.
        $uuid = $data['uuid'] ?? null;
        $ref = $data['sms_id'] ?? null;

        if (! $uuid || ! $ref) {
            throw new RimasException('The SMS provider did not return a verification reference. Please try again.');
        }

        return ['uuid' => (string) $uuid, 'ref' => (string) $ref];
    }

    private function verifyVocotext(string $destination, string $code, ?string $uuid, ?string $ref): bool
    {
        if (! $uuid || ! $ref) {
            return false;
        }

        [$countryCode, $mobile] = $this->splitPhone($destination);

        $data = $this->callVocotext([
            'mobile' => $mobile,
            'country_code' => $countryCode,
            'method' => 'verify',
            'code' => $code,
            'sms_id' => $ref,
            'uuid' => $uuid,
            'interval' => (string) $this->config('vocotext_interval'),
        ]);

        // The provider answers "Verified" only for the code it actually sent to that number.
        return strcasecmp((string) ($data['status'] ?? ''), 'Verified') === 0;
    }

    /**
     * One call to the iSMS 2FA endpoint. The credentials are added here so they never appear
     * in a caller, and the reply is decoded defensively — a gateway that answers with plain
     * text or an HTML error page must not become an unhandled exception on the sign-in page.
     */
    private function callVocotext(array $params): array
    {
        $params = array_merge([
            'un' => (string) $this->config('vocotext_user'),
            'pass' => (string) $this->config('vocotext_pass'),
            'sendid' => (string) $this->config('vocotext_sender'),
        ], $params);

        try {
            $response = Http::timeout((int) $this->config('http_timeout'))
                ->connectTimeout(10)
                ->retry(2, 400, throw: false)
                ->get((string) $this->config('vocotext_endpoint'), $params);
        } catch (Throwable $exception) {
            // Never log the exception message: it can carry the URL, and the URL carries the
            // account password as a query parameter.
            Log::error('Vocotext request failed', ['exception' => $exception::class]);

            throw new RimasException('We could not reach the SMS provider. Please try again in a moment.');
        }

        if ($response->failed()) {
            Log::warning('Vocotext returned an error status', ['status' => $response->status()]);

            throw new RimasException('The SMS provider rejected the request (HTTP ' . $response->status() . ').');
        }

        $data = $response->json();

        if (! is_array($data)) {
            // Some gateways answer with a JSON body under a text/plain content type.
            $decoded = json_decode(trim((string) $response->body()), true);
            $data = is_array($decoded) ? $decoded : ['status' => trim((string) $response->body())];
        }

        return $data;
    }

    /** A provider's own wording, but only when it is a short, safe-looking string. */
    private function providerMessage(array $data, string $fallback): string
    {
        $message = $data['message'] ?? $data['status'] ?? null;

        if (! is_string($message) || trim($message) === '' || strlen($message) > 160) {
            return $fallback;
        }

        return $fallback . ' (' . strip_tags(trim($message)) . ')';
    }

    /* ------------------------------------------------------------------------- Resend */

    private function sendEmail(string $destination, string $code): array
    {
        $minutes = (int) round(VerificationService::CHALLENGE_TTL_SECONDS / 60);

        $response = Http::withToken((string) $this->config('resend_key'))
            ->timeout((int) $this->config('http_timeout'))
            ->asJson()
            ->post('https://api.resend.com/emails', [
                'from' => $this->config('from_email'),
                'to' => [$destination],
                'subject' => 'Your MandaSafe verification code',
                'html' => '<p>Your MandaSafe verification code is <strong>' . e($code) . '</strong>.</p>'
                    . '<p>It expires in ' . $minutes . ' minutes. If you did not ask for it, ignore this message.</p>',
            ]);

        if ($response->failed()) {
            Log::warning('Resend returned an error status', ['status' => $response->status()]);

            throw new RimasException('We could not send the email code. Please try again, or choose SMS.');
        }

        return ['uuid' => null, 'ref' => null];
    }

    /* ------------------------------------------------------------------------- Twilio */

    private function sendTwilio(string $destination, string $code): array
    {
        $sid = (string) $this->config('twilio_sid');
        $minutes = (int) round(VerificationService::CHALLENGE_TTL_SECONDS / 60);

        $response = Http::withBasicAuth($sid, (string) $this->config('twilio_token'))
            ->timeout((int) $this->config('http_timeout'))
            ->asForm()
            ->post('https://api.twilio.com/2010-04-01/Accounts/' . $sid . '/Messages.json', [
                'To' => $destination,
                'From' => $this->config('twilio_from'),
                'Body' => 'Your MandaSafe verification code is ' . $code . '. It expires in ' . $minutes . ' minutes.',
            ]);

        if ($response->failed()) {
            Log::warning('Twilio returned an error status', ['status' => $response->status()]);

            throw new RimasException('We could not send the SMS code. Please try again, or choose email.');
        }

        return ['uuid' => null, 'ref' => null];
    }
}
