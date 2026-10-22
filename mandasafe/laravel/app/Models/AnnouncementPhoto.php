<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** One photo attached to an announcement, stored as base64 (see the migration for why). */
class AnnouncementPhoto extends Model
{
    protected $table = 'announcement_photos';
    public $timestamps = false;

    protected $guarded = [];

    /** The address the pages load the image from; the photo id changes when it is replaced. */
    public static function url(int $id): string
    {
        return "/api/announcements/photos/{$id}";
    }
}
