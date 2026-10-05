<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/**
 * Key/value row store for the sequence counters the JSON store used to hold, and for the
 * data-version stamp that invalidates the analytics cache whenever a write happens.
 */
class Setting extends Model
{
    protected $table = 'rimas_settings';
    protected $primaryKey = 'key';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;
    protected $fillable = ['key', 'value'];

    public static function get(string $key, $default = null)
    {
        $row = static::find($key);

        return $row ? $row->value : $default;
    }

    public static function put(string $key, $value): void
    {
        static::updateOrCreate(['key' => $key], ['value' => (string) $value]);
    }

    /** Atomically hands out the next id in a sequence, the way nextIncidentSeq() did. */
    public static function nextSequence(string $key): int
    {
        return DB::transaction(function () use ($key) {
            $row = static::lockForUpdate()->find($key);
            $next = $row ? ((int) $row->value) : 1;
            static::put($key, $next + 1);

            return $next;
        });
    }

    /**
     * Bumped by every write so cached predictions/hotspots/summaries are recomputed — in the
     * background, once this request is over (see AnalyticsWarmer).
     */
    public static function touchDataVersion(): void
    {
        static::put('dataVersion', (int) static::get('dataVersion', 0) + 1);
        \App\Services\AnalyticsWarmer::kick();
    }

    public static function dataVersion(): int
    {
        return (int) static::get('dataVersion', 0);
    }
}
