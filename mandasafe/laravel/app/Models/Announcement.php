<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** A road closure, reroute or warning posted on the public homepage. */
class Announcement extends Model
{
    public const CATEGORIES = ['closure', 'reroute', 'warning'];

    protected $table = 'announcements';
    public $timestamps = false;

    protected $guarded = [];

    protected $casts = ['published' => 'boolean'];

    public function photos(): HasMany
    {
        // Only the columns needed to list them — the image data is served on its own.
        return $this->hasMany(AnnouncementPhoto::class)->select(['id', 'announcement_id', 'position', 'caption'])->orderBy('position');
    }

    /**
     * upcoming, active or ended, read against Manila time. Times are stored as the
     * datetime-local value the form sent (YYYY-MM-DDTHH:MM), so plain string comparison
     * orders them.
     */
    public function state(?string $now = null): string
    {
        $now ??= now('Asia/Manila')->format('Y-m-d\TH:i');
        if ($this->starts_at > $now) {
            return 'upcoming';
        }

        return $this->ends_at && $this->ends_at < $now ? 'ended' : 'active';
    }

    public function toApi(bool $withAudit = false): array
    {
        $record = [
            'id' => $this->id,
            'category' => $this->category,
            'title' => $this->title,
            'location' => $this->location,
            'barangay' => $this->barangay,
            'summary' => $this->summary,
            'details' => $this->details,
            'reroute' => $this->reroute,
            'startsAt' => $this->starts_at,
            'endsAt' => $this->ends_at,
            'state' => $this->state(),
            'published' => $this->published,
            'createdAt' => $this->created_at_iso,
            'updatedAt' => $this->updated_at_iso,
            'photos' => $this->photos->map(fn (AnnouncementPhoto $photo) => [
                'id' => $photo->id,
                'url' => AnnouncementPhoto::url($photo->id),
                'caption' => $photo->caption,
            ])->values()->all(),
        ];

        if ($withAudit) {
            $record['createdBy'] = $this->created_by;
            $record['updatedBy'] = $this->updated_by;
        }

        return $record;
    }
}
