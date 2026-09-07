<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PredictionInput extends Model
{
    protected $table = 'prediction_inputs';
    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;

    protected $guarded = [];

    protected $casts = [
        'incident_count' => 'integer',
        'sort_key' => 'integer',
    ];

    public function scopeNewestFirst($query)
    {
        return $query->orderByDesc('sort_key');
    }

    public function toApi(): array
    {
        return [
            'id' => $this->id,
            'barangay' => $this->barangay,
            'road' => $this->road,
            'month' => $this->month,
            'incidentCount' => (int) $this->incident_count,
            'notes' => $this->notes ?? '',
            'updatedBy' => $this->updated_by,
            'updatedAt' => $this->updated_at_iso,
        ];
    }
}
