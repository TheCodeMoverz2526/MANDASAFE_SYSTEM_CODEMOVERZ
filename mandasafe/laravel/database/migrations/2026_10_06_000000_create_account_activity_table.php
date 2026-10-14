<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What each account has done — sign-ins, failed attempts, password and profile changes, and an
 * administrator's edits — shown in the user details panel of User Management. Passwords are
 * never readable (only a bcrypt hash is kept), so the panel shows when one last changed instead.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('account_activity', function (Blueprint $table) {
            $table->id();
            $table->string('account_id')->index();
            $table->string('action')->index();
            $table->text('detail')->nullable();
            $table->string('ip')->nullable();
            $table->string('user_agent', 512)->nullable();
            $table->string('created_at_iso')->index();
        });

        Schema::table('accounts', function (Blueprint $table) {
            $table->string('password_changed_at_iso')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('account_activity');

        Schema::table('accounts', function (Blueprint $table) {
            $table->dropColumn('password_changed_at_iso');
        });
    }
};
