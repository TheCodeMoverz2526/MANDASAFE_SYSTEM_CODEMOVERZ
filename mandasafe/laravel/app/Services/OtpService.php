<?php

namespace App\Services;

use App\Exceptions\RimasException;
use Illuminate\Support\Facades\Http;

/**
 * Delivers the six-digit sign-in code by email (Resend) or SMS (Twilio). With
 * OTP_TEST_MODE=true no provider is contacted and the sign-in page accepts OTP_TEST_CODE,
 * which is how the system runs out of the box.
 */
class OtpService
{
    private function config(string $key)
    {
        return config('mandasafe.otp.' . $key);
    }

    private function testMode(): bool
    {
        return filter_var($this->config('test_mode'), FILTER_VALIDATE_BOOLEAN);
    }

    /** What the sign-in page reads to decide which channels to offer. */
    public function status(): array
    {
        $testMode = $this->testMode();

        return [
            'testMode' => $testMode,
            'email' => $testMode || (bool) ($this->config('resend_key') && $this->config('from_email')),
            'sms' => $testMode || (bool) ($this->config('twilio_sid') && $this->config('twilio_token') && $this->config('twilio_from')),
        ];
    }

    public function send(array $data): array
    {
        $code = (string) ($data['code'] ?? '');
        $channel = $data['channel'] ?? '';
        $destination = $data['destination'] ?? '';

        if (! preg_match('/^\d{6}$/', $code) || ! in_array($channel, ['email', 'sms'], true)) {
            throw new RimasException('Invalid verification request.');
        }

        if ($this->testMode()) {
            return ['testMode' => true, 'code' => (string) $this->config('test_code')];
        }

        return $channel === 'email'
            ? $this->sendEmail($destination, $code)
            : $this->sendSms($destination, $code);
    }

    private function sendEmail(string $destination, string $code): array
    {
        if (! $this->config('resend_key') || ! $this->config('from_email')) {
            throw new RimasException('Email delivery is not configured. Set RESEND_API_KEY and OTP_FROM_EMAIL.');
        }

        $response = Http::withToken($this->config('resend_key'))
            ->asJson()
            ->post('https://api.resend.com/emails', [
                'from' => $this->config('from_email'),
                'to' => [$destination],
                'subject' => 'Your RIMAS verification code',
                'html' => '<p>Your RIMAS verification code is <strong>' . e($code) . '</strong>.</p>'
                    . '<p>This code expires in 10 minutes.</p>',
            ]);

        if ($response->failed()) {
            throw new RimasException('Provider returned ' . $response->status());
        }

        return ['sent' => true];
    }

    private function sendSms(string $destination, string $code): array
    {
        $sid = $this->config('twilio_sid');
        $token = $this->config('twilio_token');
        $from = $this->config('twilio_from');

        if (! $sid || ! $token || ! $from) {
            throw new RimasException('SMS delivery is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.');
        }

        $response = Http::withBasicAuth($sid, $token)
            ->asForm()
            ->post('https://api.twilio.com/2010-04-01/Accounts/' . $sid . '/Messages.json', [
                'To' => $destination,
                'From' => $from,
                'Body' => 'Your RIMAS verification code is ' . $code . '. It expires in 10 minutes.',
            ]);

        if ($response->failed()) {
            throw new RimasException('SMS provider returned ' . $response->status());
        }

        return ['sent' => true];
    }
}
