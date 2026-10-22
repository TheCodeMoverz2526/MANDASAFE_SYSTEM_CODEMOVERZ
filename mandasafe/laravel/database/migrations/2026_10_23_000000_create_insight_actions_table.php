<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What the TPMO or the city has done about an insight ("enforcers posted at Shaw–Boni from
 * 3 PM"). Insights are written by the server and change with the data, so an action is tied
 * to the insight's stable id (city-hours, brgy-hulo, …) rather than to its wording.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('insight_actions', function (Blueprint $table) {
            $table->id();
            $table->string('insight_id')->index();
            $table->string('title');
            $table->text('details');
            $table->string('status')->default('ongoing');   // planned | ongoing | completed
            $table->string('action_date')->nullable();      // YYYY-MM-DD
            $table->string('created_by')->nullable();
            $table->string('created_at_iso');
            $table->string('updated_by')->nullable();
            $table->string('updated_at_iso')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('insight_actions');
    }
};
