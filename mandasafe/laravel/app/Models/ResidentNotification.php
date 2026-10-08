<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ResidentNotification extends Model
{
    protected $table = 'resident_notifications';
    public $timestamps = false;

    protected $guarded = [];

    public function toApi(int $seenId): array
    {
        return [
            'id' => (int) $this->id,
            'type' => $this->type,
            'title' => $this->title,
            'desc' => $this->desc,
            'link' => $this->link,
            'createdAt' => $this->created_at_iso,
            'unread' => $this->id > $seenId,
        ];
    }
}
