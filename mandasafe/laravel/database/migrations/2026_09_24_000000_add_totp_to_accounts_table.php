<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Authenticator-app codes (TOTP) for administrators.
 *
 * The shared secret is stored encrypted with the application key (see the Account casts),
 * and only once the administrator has proved their app produces matching codes. The last
 * accepted time step is kept so the same code cannot be used twice.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('accounts', function (Blueprint $table) {
            $table->text('totp_secret')->nullable();
            $table->string('totp_enabled_at_iso')->nullable();
            $table->unsignedBigInteger('totp_last_step')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('accounts', function (Blueprint $table) {
            $table->dropColumn(['totp_secret', 'totp_enabled_at_iso', 'totp_last_step']);
        });
    }
};
