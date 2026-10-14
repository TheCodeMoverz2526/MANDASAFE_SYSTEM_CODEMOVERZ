<?php

namespace App\Console\Commands;

use App\Models\Account;
use App\Models\RimasSession;
use Illuminate\Console\Command;

/**
 * For an administrator who lost or replaced the phone with their authenticator app:
 *
 *   php artisan mandasafe:totp-reset admin@rimas.gov.ph
 *
 * Clears the account's authenticator secret and signs it out everywhere. The next sign-in
 * shows a fresh QR code to scan, exactly like the first one did.
 */
class ResetTotp extends Command
{
    protected $signature = 'mandasafe:totp-reset {email : The administrator\'s email address}';

    protected $description = 'Remove an administrator\'s authenticator app so they set it up again at next sign-in';

    public function handle(): int
    {
        $account = Account::where('email', Account::normaliseEmail($this->argument('email')))->first();

        if (! $account) {
            $this->error('  No account has that email address.');

            return self::FAILURE;
        }

        $account->totp_secret = null;
        $account->totp_enabled_at_iso = null;
        $account->totp_last_step = null;
        $account->save();

        RimasSession::where('account_id', $account->id)->delete();

        $this->info('  Authenticator removed for ' . $account->email . '. They will scan a new QR code at their next sign-in.');

        return self::SUCCESS;
    }
}
