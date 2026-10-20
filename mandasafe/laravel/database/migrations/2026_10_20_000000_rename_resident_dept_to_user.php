<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Accounts are now called "User" rather than "Resident" on every page, so the default
 * office/area given to sign-ups follows: existing accounts that still carry the old default
 * get the new one. An office an administrator typed by hand is left alone.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::table('accounts')->where('dept', 'Mandaluyong City Resident')->update(['dept' => 'Mandaluyong City User']);
    }

    public function down(): void
    {
        DB::table('accounts')->where('dept', 'Mandaluyong City User')->update(['dept' => 'Mandaluyong City Resident']);
    }
};
