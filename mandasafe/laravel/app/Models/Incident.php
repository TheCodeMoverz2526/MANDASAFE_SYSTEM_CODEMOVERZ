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

        foreach (['createdBy' => 'created_by', 'createdAt' => 'created_at_iso', 'updatedBy' => 'updated_by', 'updatedAt' => 'updated_at_iso'] as $key => $column) {
            if ($this->{$column} !== null) {
                $record[$key] = $this->{$column};
            }
        }

        return $record;
    }
}
