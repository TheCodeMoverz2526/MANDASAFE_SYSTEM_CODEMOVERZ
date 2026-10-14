<?php

namespace Database\Seeders;

use App\Services\AccountService;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    /**
     * Guarantees there is always an administrator to sign in as — the same thing the old
     * server did on every boot. Existing accounts are left untouched.
     */
    public function run(): void
    {
        $password = app(AccountService::class)->seedDefaultAdmin();

        if ($password !== null && $this->command) {
            $this->command->warn('Administrator created: ' . AccountService::DEFAULT_ADMIN['email']);
            $this->command->warn('Password: ' . $password . '   (shown once; change it with php artisan mandasafe:set-password)');
        }
    }
}
