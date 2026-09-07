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
        app(AccountService::class)->seedDefaultAdmin();
    }
}
