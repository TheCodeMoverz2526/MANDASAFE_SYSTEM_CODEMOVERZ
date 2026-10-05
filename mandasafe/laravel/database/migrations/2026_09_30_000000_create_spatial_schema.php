<?php

use App\Services\SpatialService;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * MandaSafe's spatial schema (see SpatialService for how it is queried).
 *
 *  barangays   the 27 official boundaries: MULTIPOLYGON geometry in WKT (SRID 4326), an
 *              indexed bounding box, centroid and area — the spatial reference table.
 *  incidents   + geom_wkt         POINT geometry in WKT (SRID 4326)
 *              + geohash          indexed grid-cell code, the spatial index for proximity search
 *              + barangay_id      the barangay the POINT falls inside (spatial join, not the
 *                                 typed name), foreign key to barangays
 *              + location_status  inside / other_barangay / outside_city / no_location
 *
 * The boundaries are loaded from the official GeoJSON and every existing accident is located.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('barangays', function (Blueprint $table) {
            $table->id();
            $table->string('psgc_code')->unique();
            $table->string('name')->unique();
            $table->string('city')->default('City of Mandaluyong');
            $table->unsignedInteger('srid')->default(SpatialService::SRID);
            $table->longText('geom_wkt');
            $table->double('min_lat');
            $table->double('max_lat');
            $table->double('min_lng');
            $table->double('max_lng');
            $table->double('centroid_lat');
            $table->double('centroid_lng');
            $table->double('area_km2');
            $table->index(['min_lat', 'max_lat', 'min_lng', 'max_lng'], 'barangays_bbox_index');
        });

        Schema::table('incidents', function (Blueprint $table) {
            $table->string('geom_wkt')->nullable();
            $table->string('geohash', 12)->nullable()->index();
            $table->foreignId('barangay_id')->nullable()->constrained('barangays')->nullOnDelete();
            $table->string('location_status', 20)->default(SpatialService::NO_LOCATION)->index();
            $table->index(['lat', 'lng'], 'incidents_lat_lng_index');
        });

        SpatialService::seedBarangays();
        SpatialService::syncAllIncidents();
    }

    public function down(): void
    {
        Schema::table('incidents', function (Blueprint $table) {
            $table->dropIndex('incidents_lat_lng_index');
            $table->dropConstrainedForeignId('barangay_id');
            $table->dropIndex(['geohash']);
            $table->dropIndex(['location_status']);
            $table->dropColumn(['geom_wkt', 'geohash', 'location_status']);
        });
        Schema::dropIfExists('barangays');
    }
};
