<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Road announcements the TPMO posts on the public homepage: road closures, reroutes and
 * warnings. Photos are kept in the database rather than on disk, because the Vercel
 * deployment has no lasting filesystem — an uploaded file there would vanish on the next
 * cold start.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('announcements', function (Blueprint $table) {
            $table->id();
            $table->string('category');                 // closure | reroute | warning
            $table->string('title');
            $table->string('location');                 // the road or area affected
            $table->string('barangay')->nullable();     // null = city-wide
            $table->string('summary', 300);
            $table->text('details');
            $table->text('reroute')->nullable();        // the alternate route, for closures and reroutes
            $table->string('starts_at');                // YYYY-MM-DDTHH:MM, Manila time
            $table->string('ends_at')->nullable();      // null = until further notice
            $table->boolean('published')->default(true);
            $table->string('created_by')->nullable();
            $table->string('created_at_iso')->index();
            $table->string('updated_by')->nullable();
            $table->string('updated_at_iso')->nullable();
        });

        Schema::create('announcement_photos', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('announcement_id')->index();
            $table->unsignedSmallInteger('position')->default(0);
            $table->string('mime');
            $table->longText('data');                   // base64, so SQLite and MySQL store it alike
            $table->string('caption')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('announcement_photos');
        Schema::dropIfExists('announcements');
    }
};
