<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Notification extends Model
{
    protected $table = 'notifications';
    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;

    protected $guarded = [];

    /** Newest first, same convention as incidents/prediction inputs. */
    public function scopeNewestFirst($query)
    {
        return $query->orderByDesc('sort_key');
    }

    public function toApi(): array
    {
        return [
            'id' => $this->id,
            // Increasing number the console polls against: "anything after seq N?".
            'seq' => (int) $this->sort_key,
            'type' => $this->type,
            'title' => $this->title,
            'desc' => $this->desc,
            'createdAt' => $this->created_at_iso,
            'unread' => $this->read_at_iso === null,
        ];
    }
}
