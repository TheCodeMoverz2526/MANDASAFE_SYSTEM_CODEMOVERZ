<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One row per verification in flight — a sign-in, a sign-up or a password reset waiting for
 * its six-digit code.
 *
 * The code itself is never in this table in readable form: for the email channel only a hash
 * of it is stored, and for SMS the provider (Vocotext iSMS 2FA) generates and checks the code
 * on its own side, so all we keep is the uuid / sms_id pair needed to ask it.
 *
 * A row moves in one direction only: created -> verified -> consumed. Attempts, sends and the
 * expiry are counted here rather than in the browser, which is what makes the step real.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('otp_challenges', function (Blueprint $table) {
            $table->string('id')->primary();              // 64 hex chars from random_bytes(32)
            $table->string('purpose');                    // login | register | reset
            $table->string('channel')->nullable();        // email | sms — chosen after the challenge starts
            $table->string('account_id')->nullable()->index();
            $table->string('identifier')->index();        // normalised email of the account being verified
            $table->string('name')->nullable();
            $table->string('email')->nullable();
            $table->string('phone')->nullable();
            $table->text('payload')->nullable();          // encrypted sign-up details, incl. the password
            $table->string('provider')->nullable();       // test | resend | vocotext | twilio
            $table->string('code_hash')->nullable();      // email / test channels only
            $table->string('provider_uuid')->nullable();  // Vocotext: uuid
            $table->string('provider_ref')->nullable();   // Vocotext: sms_id
            $table->unsignedInteger('attempts')->default(0);
            $table->unsignedInteger('sends')->default(0);
            $table->string('ip')->nullable();
            $table->string('created_at_iso')->nullable();
            $table->string('last_sent_at_iso')->nullable();
            $table->string('expires_at_iso')->index();
            $table->string('verified_at_iso')->nullable();
            $table->string('consumed_at_iso')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('otp_challenges');
    }
};
