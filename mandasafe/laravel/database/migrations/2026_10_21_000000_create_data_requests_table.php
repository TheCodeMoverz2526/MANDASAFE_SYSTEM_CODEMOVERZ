<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Requests sent from the resident Request Data form, kept so each account can see its own
 * requests on My Account. The office still hears about each one through the admin inbox.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('data_requests', function (Blueprint $table) {
            $table->id();
            $table->string('account_id')->index();
            $table->string('name');
            $table->string('role');
            $table->string('organization');
            $table->string('data_type');
            $table->text('purpose');
            $table->string('email');
            $table->string('status')->default('pending');
            $table->string('created_at_iso')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('data_requests');
    }
};
