<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The residents' notification bell: "a new accident was reported", "a new hotspot appeared".
 * Kept apart from the admin inbox (notifications), which names who did what and covers
 * account events residents have no business seeing.
 *
 * One shared feed for every signed-in account; each account remembers the newest item it has
 * seen (alerts_seen_id), so reading them is per person without a row per recipient.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('resident_notifications', function (Blueprint $table) {
            $table->id();
            $table->string('type')->index();
            $table->string('title');
            $table->text('desc')->nullable();
            $table->string('link')->nullable();
            $table->string('created_at_iso')->index();
        });

        Schema::table('accounts', function (Blueprint $table) {
            // Null until the account first opens a page with the bell; it then starts at the
            // newest item, so a new account is not greeted by the whole backlog as unread.
            $table->unsignedBigInteger('alerts_seen_id')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('accounts', function (Blueprint $table) {
            $table->dropColumn('alerts_seen_id');
        });
        Schema::dropIfExists('resident_notifications');
    }
};
