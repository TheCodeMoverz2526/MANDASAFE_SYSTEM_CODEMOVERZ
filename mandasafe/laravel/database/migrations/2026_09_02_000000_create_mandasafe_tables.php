<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The MandaSafe store, previously a single data/store.json file, expressed as real tables.
 * Every column maps one-to-one onto a field the browser already expects, so the JSON the
 * API returns is byte-for-byte the shape the resident pages and the RIMAS console read.
 *
 * Ids stay human-readable strings (#A18037, RF-1001, USR-1001) because they are printed on
 * reports and exports; `sort_key` preserves the newest-first order the JSON array had.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('accounts', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->string('name');
            $table->string('email')->unique();
            $table->string('phone')->index();
            $table->string('role')->default('user');
            $table->string('dept')->nullable();
            $table->string('status')->default('active');
            $table->string('password');
            $table->string('created_at_iso')->nullable();
            $table->string('updated_at_iso')->nullable();
            $table->string('last_login_at_iso')->nullable();
        });

        Schema::create('rimas_sessions', function (Blueprint $table) {
            $table->string('token')->primary();
            $table->string('account_id')->index();
            $table->string('created_at_iso')->nullable();
            $table->string('expires_at_iso')->index();
        });

        Schema::create('incidents', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->string('date')->nullable()->index();
            $table->string('time')->nullable();
            $table->string('loc')->nullable();
            $table->string('barangay')->nullable()->index();
            $table->string('road')->nullable()->index();
            $table->string('sev')->nullable()->index();
            $table->string('type')->nullable()->index();
            $table->double('lat')->nullable();
            $table->double('lng')->nullable();
            $table->string('status')->default('active')->index();
            $table->string('created_by')->nullable();
            $table->string('created_at_iso')->nullable();
            $table->string('updated_by')->nullable();
            $table->string('updated_at_iso')->nullable();
            $table->bigInteger('sort_key')->index();
        });

        Schema::create('prediction_inputs', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->string('barangay')->index();
            $table->string('road')->default('All Roads');
            $table->string('month')->index();
            $table->integer('incident_count')->default(0);
            $table->text('notes')->nullable();
            $table->string('updated_by')->nullable();
            $table->string('updated_at_iso')->nullable();
            $table->bigInteger('sort_key')->index();
        });

        // Replaces the nextIncidentSeq / nextInputSeq / nextAccountSeq counters the JSON
        // store kept, plus the data-version stamp the analytics cache is keyed on.
        Schema::create('rimas_settings', function (Blueprint $table) {
            $table->string('key')->primary();
            $table->string('value')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('rimas_settings');
        Schema::dropIfExists('prediction_inputs');
        Schema::dropIfExists('incidents');
        Schema::dropIfExists('rimas_sessions');
        Schema::dropIfExists('accounts');
    }
};
