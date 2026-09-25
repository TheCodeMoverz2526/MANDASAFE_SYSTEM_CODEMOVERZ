<?php

namespace App\Services;

/**
 * Time-based one-time passwords (RFC 6238) — the six-digit codes shown by Google
 * Authenticator, Microsoft Authenticator, Authy and the like.
 *
 * SHA-1, 6 digits and a 30-second step are what every authenticator app assumes when it
 * scans an otpauth:// QR code, so those are fixed here rather than configurable.
 */
class TotpService
{
    public const PERIOD = 30;
    public const DIGITS = 6;

    /** Codes one step either side of now are accepted, to allow for clock drift. */
    public const WINDOW = 1;

    private const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** A fresh 160-bit secret, base32-encoded the way authenticator apps expect it. */
    public function generateSecret(): string
    {
        return $this->base32Encode(random_bytes(20));
    }

    /** What the QR code carries; scanning it adds the account to the authenticator app. */
    public function provisioningUri(string $secret, string $accountName, string $issuer = 'MandaSafe'): string
    {
        return 'otpauth://totp/' . rawurlencode($issuer . ':' . $accountName)
            . '?secret=' . $secret
            . '&issuer=' . rawurlencode($issuer)
            . '&algorithm=SHA1&digits=' . self::DIGITS . '&period=' . self::PERIOD;
    }

    /**
     * Returns the time step the code matched, or null. A step at or before $lastStep is
     * refused, so a code that has already been used cannot be used again.
     */
    public function verify(string $secret, string $code, ?int $lastStep = null, ?int $time = null): ?int
    {
        if (! preg_match('/^\d{' . self::DIGITS . '}$/', $code)) {
            return null;
        }

        $key = $this->base32Decode($secret);
        $now = intdiv($time ?? time(), self::PERIOD);

        for ($offset = -self::WINDOW; $offset <= self::WINDOW; $offset++) {
            $step = $now + $offset;

            if ($lastStep !== null && $step <= $lastStep) {
                continue;
            }
            if (hash_equals($this->codeAt($key, $step), $code)) {
                return $step;
            }
        }

        return null;
    }

    /** The code for a given moment — used by the tests, and handy for checking a clock. */
    public function codeFor(string $secret, ?int $time = null): string
    {
        return $this->codeAt($this->base32Decode($secret), intdiv($time ?? time(), self::PERIOD));
    }

    private function codeAt(string $key, int $step): string
    {
        $hash = hash_hmac('sha1', pack('J', $step), $key, true);
        $offset = ord($hash[19]) & 0x0F;
        $value = ((ord($hash[$offset]) & 0x7F) << 24)
            | (ord($hash[$offset + 1]) << 16)
            | (ord($hash[$offset + 2]) << 8)
            | ord($hash[$offset + 3]);

        return str_pad((string) ($value % (10 ** self::DIGITS)), self::DIGITS, '0', STR_PAD_LEFT);
    }

    private function base32Encode(string $bytes): string
    {
        $bits = '';
        foreach (str_split($bytes) as $byte) {
            $bits .= str_pad(decbin(ord($byte)), 8, '0', STR_PAD_LEFT);
        }

        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::BASE32[bindec(str_pad($chunk, 5, '0'))];
        }

        return $out;
    }

    private function base32Decode(string $text): string
    {
        $text = strtoupper(preg_replace('/[\s=]/', '', $text));

        $bits = '';
        foreach (str_split($text) as $char) {
            $index = strpos(self::BASE32, $char);
            if ($index === false) {
                continue;
            }
            $bits .= str_pad(decbin($index), 5, '0', STR_PAD_LEFT);
        }

        $out = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $out .= chr(bindec($byte));
            }
        }

        return $out;
    }
}
