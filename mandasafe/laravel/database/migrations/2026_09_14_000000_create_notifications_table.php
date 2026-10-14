<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Admin-facing notifications (e.g. "a new account was created"). One shared inbox for every
 * administrator, the way the RIMAS console's bell icon already reads it — there is no
 * per-recipient row, so any admin marking one read clears it for all of them.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('notifications', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->string('type')->index();
            $table->string('title');
            $table->text('desc')->nullable();
            $table->string('created_at_iso')->index();
            $table->string('read_at_iso')->nullable()->index();
            $table->bigInteger('sort_key')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('notifications');
    }
};
