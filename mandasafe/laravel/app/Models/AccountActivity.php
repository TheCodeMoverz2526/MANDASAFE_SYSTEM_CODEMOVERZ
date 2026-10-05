<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Log;

/** One line of an account's activity history, as shown in User Management's details panel. */
class AccountActivity extends Model
{
    protected $table = 'account_activity';
    public $timestamps = false;

    protected $guarded = [];

    /**
     * Records an action against an account. A failure here is logged and swallowed: the history
     * is for administrators to review, and must never be the reason a sign-in or an edit fails.
     */
    public static function record(?string $accountId, string $action, ?string $detail = null): void
    {
        if (! $accountId) {
            return;
        }

        try {
            $request = request();
            static::create([
                'account_id' => $accountId,
                'action' => $action,
                'detail' => $detail,
                'ip' => $request?->ip(),
                'user_agent' => mb_substr((string) $request?->userAgent(), 0, 512) ?: null,
                'created_at_iso' => now()->utc()->format('Y-m-d\TH:i:s.v\Z'),
            ]);
        } catch (\Throwable $exception) {
            Log::warning('Could not record account activity: ' . $exception->getMessage());
        }
    }

    /** Same as record(), for an action whose actor is known only by email (incident edits). */
    public static function recordFor(?string $email, string $action, ?string $detail = null): void
    {
        if (! $email) {
            return;
        }

        static::record(Account::where('email', Account::normaliseEmail($email))->value('id'), $action, $detail);
    }

    public function toApi(): array
    {
        return [
            'action' => $this->action,
            'detail' => $this->detail,
            'ip' => $this->ip,
            'userAgent' => $this->user_agent,
            'at' => $this->created_at_iso,
        ];
    }
}
