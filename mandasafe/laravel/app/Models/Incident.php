<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Incident extends Model
{
    protected $table = 'incidents';
    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;

    protected $guarded = [];

    protected $casts = [
        'lat' => 'float',
        'lng' => 'float',
        'sort_key' => 'integer',
    ];

    /** Newest first — the order the JSON array had, since new records were unshifted. */
    public function scopeNewestFirst($query)
    {
        return $query->orderByDesc('sort_key');
    }

    /** The audit fields, in the order they appear in the record: API key => column. */
    private const AUDIT_FIELDS = [
        'createdBy' => 'created_by',
        'createdAt' => 'created_at_iso',
        'updatedBy' => 'updated_by',
        'updatedAt' => 'updated_at_iso',
    ];

    /**
     * Every incident, newest first, in the same shape as toApi().
     *
     * The map page asks for all of them — around 8,000 records — and building that list
     * through Eloquent meant hydrating 8,000 models and then pulling roughly fifteen
     * attributes out of each one through the magic accessor, casts and all. That was by
     * far the slowest request in the system. The query builder hands back plain rows and
     * the shape is assembled here instead, which is the same work without the ceremony.
     *
     * Kept next to toApi() deliberately: the two must produce identical records.
     */
    public static function listApi(): array
    {
        $rows = static::query()->newestFirst()->toBase()->get();

        $records = [];

        foreach ($rows as $row) {
            $record = [
                'id' => $row->id,
                'date' => $row->date,
                'time' => $row->time,
                'loc' => $row->loc,
                'barangay' => $row->barangay,
                'road' => $row->road,
                'sev' => $row->sev,
                'type' => $row->type,
                'lat' => $row->lat === null ? null : (float) $row->lat,
                'lng' => $row->lng === null ? null : (float) $row->lng,
                'status' => $row->status,
            ];

            foreach (self::AUDIT_FIELDS as $key => $column) {
                if ($row->{$column} !== null) {
                    $record[$key] = $row->{$column};
                }
            }

            $records[] = $record;
        }

        return $records;
    }

    /**
     * Exactly the object shape script.js and js/api.js already consume. The audit fields are
     * left out when they are empty rather than sent as nulls, which is how the records looked
     * before the move to a database — a record only grows an updatedBy once it is edited.
     */
    public function toApi(): array
    {
        $record = [
            'id' => $this->id,
            'date' => $this->date,
            'time' => $this->time,
            'loc' => $this->loc,
            'barangay' => $this->barangay,
            'road' => $this->road,
            'sev' => $this->sev,
            'type' => $this->type,
            'lat' => $this->lat === null ? null : (float) $this->lat,
            'lng' => $this->lng === null ? null : (float) $this->lng,
            'status' => $this->status,
        ];

        foreach (self::AUDIT_FIELDS as $key => $column) {
            if ($this->{$column} !== null) {
                $record[$key] = $this->{$column};
            }
        }

        return $record;
    }
}
