<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** One request sent from the Request Data form. */
class DataRequest extends Model
{
    protected $table = 'data_requests';
    public $timestamps = false;

    protected $guarded = [];

    public function toApi(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'role' => $this->role,
            'organization' => $this->organization,
            'dataType' => $this->data_type,
            'purpose' => $this->purpose,
            'email' => $this->email,
            'status' => $this->status,
            'declineReason' => $this->decline_reason,
            'createdAt' => $this->created_at_iso,
        ];
    }
}
