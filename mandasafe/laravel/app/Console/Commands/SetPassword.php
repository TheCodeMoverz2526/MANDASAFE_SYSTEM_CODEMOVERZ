<?php

namespace App\Console\Commands;

use App\Models\Account;
use App\Models\RimasSession;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Hash;

/**
 * Sets an account's password from the server's command line — for replacing a default
 * password (such as the seeded administrator's) before the system goes online:
 *
 *   php artisan mandasafe:set-password admin@rimas.gov.ph
 *
 * The password is typed at a hidden prompt, never passed on the command line (where it would
 * land in the shell history). Every session of the account is ended.
 */
class SetPassword extends Command
{
    protected $signature = 'mandasafe:set-password {email : The account\'s email address}';

    protected $description = 'Set a new password for an account and sign it out everywhere';

    public function handle(): int
    {
        $account = Account::where('email', Account::normaliseEmail($this->argument('email')))->first();
        if (! $account) {
            $this->error('  No account has that email address.');

            return self::FAILURE;
        }

        $password = (string) $this->secret('New password (at least 12 characters)');
        if (strlen($password) < 12) {
            $this->error('  Too short — use at least 12 characters.');

            return self::FAILURE;
        }
        if ($password !== (string) $this->secret('Type it again')) {
            $this->error('  The two passwords do not match.');

            return self::FAILURE;
        }

        $account->password = Hash::make($password);
        $account->updated_at_iso = now()->utc()->format('Y-m-d\TH:i:s.v\Z');
        $account->save();
        RimasSession::where('account_id', $account->id)->delete();

        $this->info("  Password updated for {$account->email}. All of its sessions were signed out.");

        return self::SUCCESS;
    }
}
