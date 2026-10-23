<?php

namespace App\Services;

use App\Models\Account;
use App\Models\DataRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Throwable;

/**
 * Tells the resident by email when the office accepts or declines their data request.
 *
 * Sent through Resend or SMTP, the same settings the verification codes use. Appwrite only
 * sends its own sign-in codes, so with Appwrite alone nothing goes out — the request tracker
 * still shows the new status. A failed email never undoes the decision: the administrator is
 * told it did not go out and can write to the resident instead.
 */
class DataRequestMailer
{
    private const SUBJECTS = [
        'approved' => 'Your MandaSafe data request %s was accepted',
        'declined' => 'Your MandaSafe data request %s was declined',
    ];

    /** Whether this status sends an email at all. */
    public static function covers(string $status): bool
    {
        return isset(self::SUBJECTS[$status]);
    }

    private function config(string $key)
    {
        return config('mandasafe.otp.' . $key);
    }

    public function ready(): bool
    {
        return $this->resendReady() || $this->smtpReady();
    }

    private function resendReady(): bool
    {
        return (bool) ($this->config('resend_key') && $this->config('from_email'));
    }

    private function smtpReady(): bool
    {
        return config('mail.default') === 'smtp'
            && config('mail.mailers.smtp.host')
            && config('mail.mailers.smtp.username')
            && config('mail.mailers.smtp.password');
    }

    /** Sends the email for the request's current status. True once it has gone out. */
    public function sendStatus(DataRequest $row): bool
    {
        if (! self::covers($row->status) || ! $this->ready()) {
            return false;
        }

        // The account's own address, and the delivery address when the resident gave another.
        $to = array_values(array_unique(array_filter([
            Account::find($row->account_id)?->email,
            $row->email,
        ], fn ($email) => filter_var($email, FILTER_VALIDATE_EMAIL))));
        if ($to === []) {
            return false;
        }

        $subject = sprintf(self::SUBJECTS[$row->status], self::code($row));
        $html = $this->body($row);

        try {
            if ($this->resendReady()) {
                $response = Http::withToken((string) $this->config('resend_key'))
                    ->timeout((int) $this->config('http_timeout'))
                    ->asJson()
                    ->post('https://api.resend.com/emails', [
                        'from' => $this->config('from_email'),
                        'to' => $to,
                        'subject' => $subject,
                        'html' => $html,
                    ]);
                if ($response->failed()) {
                    Log::warning('Resend refused a data request email', ['status' => $response->status()]);

                    return false;
                }

                return true;
            }

            Mail::mailer('smtp')->html($html, fn ($message) => $message->to($to)->subject($subject));

            return true;
        } catch (Throwable $error) {
            Log::warning('A data request email could not be sent', ['error' => $error->getMessage()]);

            return false;
        }
    }

    public static function code(DataRequest $row): string
    {
        return 'REQ-' . str_pad((string) $row->id, 4, '0', STR_PAD_LEFT);
    }

    private function body(DataRequest $row): string
    {
        $code = e(self::code($row));
        $what = e($row->data_type);

        $message = $row->status === 'approved'
            ? '<p>Good news &mdash; your request <strong>' . $code . '</strong> for <strong>' . $what . '</strong> has been '
                . '<strong style="color:#16a34a">accepted</strong> by the Mandaluyong City Traffic Planning and Management Office.</p>'
                . '<p>The office will send the data to <strong>' . e($row->email) . '</strong> within 3&ndash;5 working days.</p>'
            : '<p>Your request <strong>' . $code . '</strong> for <strong>' . $what . '</strong> has been '
                . '<strong style="color:#dc2626">declined</strong> by the Mandaluyong City Traffic Planning and Management Office.</p>'
                . '<p style="margin:16px 0;padding:12px 14px;background:#fef2f2;border-left:4px solid #dc2626;border-radius:6px">'
                . '<strong>Reason:</strong><br>' . nl2br(e((string) $row->decline_reason)) . '</p>'
                . '<p>You may send a new request from the Request Data page.</p>';

        return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2937;line-height:1.6">'
            . '<h2 style="margin:0 0 16px;color:#1e3a8a">MandaSafe</h2>'
            . '<p>Hi ' . e($row->name) . ',</p>'
            . $message
            . '<p>You can follow this request any time on the Request Data page of MandaSafe.</p>'
            . '<p style="color:#6b7280;font-size:12px;margin-top:24px">This is an automatic message &mdash; please do not reply to it.</p>'
            . '</div>';
    }
}
