<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Why the office declined a request. Required when an administrator declines one, and shown
 * to the resident on the Request Data tracker and in My Account.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('data_requests', function (Blueprint $table) {
            $table->text('decline_reason')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('data_requests', function (Blueprint $table) {
            $table->dropColumn('decline_reason');
        });
    }
};
