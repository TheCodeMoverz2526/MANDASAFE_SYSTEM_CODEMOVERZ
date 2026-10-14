<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One of Mandaluyong's 27 barangays: its official boundary (MULTIPOLYGON, WKT, SRID 4326),
 * bounding box, centroid and area. Accidents link here by where their coordinates fall.
 */
class Barangay extends Model
{
    protected $table = 'barangays';
    public $timestamps = false;

    protected $guarded = [];

    protected $casts = [
        'min_lat' => 'float',
        'max_lat' => 'float',
        'min_lng' => 'float',
        'max_lng' => 'float',
        'centroid_lat' => 'float',
        'centroid_lng' => 'float',
        'area_km2' => 'float',
    ];

    public function incidents(): HasMany
    {
        return $this->hasMany(Incident::class, 'barangay_id');
    }
}
