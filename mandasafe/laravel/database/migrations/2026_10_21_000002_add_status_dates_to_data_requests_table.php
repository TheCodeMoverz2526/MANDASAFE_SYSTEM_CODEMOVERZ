<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * When each step of a data request happened, so residents and the office can see the date of
 * every step and not only when it was sent in.
 */
return new class extends Migration
{
    private const STATUSES = ['approved', 'sent', 'declined'];

    public function up(): void
    {
        Schema::table('data_requests', function (Blueprint $table) {
            foreach (self::STATUSES as $status) {
                $table->string("{$status}_at_iso")->nullable();
            }
        });

        // Requests that moved along before this column existed: every status change was written
        // to the resident's activity log ("Data request REQ-0001 set to approved by …"), so the
        // first such entry gives the date.
        foreach (DB::table('data_requests')->get(['id', 'account_id']) as $row) {
            $code = 'REQ-' . str_pad((string) $row->id, 4, '0', STR_PAD_LEFT);
            $dates = [];
            foreach (self::STATUSES as $status) {
                $at = DB::table('account_activity')
                    ->where('account_id', $row->account_id)
                    ->where('detail', 'like', "Data request {$code} set to {$status} %")
                    ->orderBy('id')
                    ->value('created_at_iso');
                if ($at) {
                    $dates["{$status}_at_iso"] = $at;
                }
            }
            if ($dates) {
                DB::table('data_requests')->where('id', $row->id)->update($dates);
            }
        }
    }

    public function down(): void
    {
        Schema::table('data_requests', function (Blueprint $table) {
            $table->dropColumn(array_map(fn ($status) => "{$status}_at_iso", self::STATUSES));
        });
    }
};
