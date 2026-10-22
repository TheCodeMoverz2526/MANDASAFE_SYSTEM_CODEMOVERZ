<?php

namespace App\Http\Controllers\Api;

use App\Exceptions\RimasException;
use App\Models\Announcement;
use App\Models\AnnouncementPhoto;
use App\Models\Setting;
use App\Services\AccountService;
use App\Services\GeoService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Road closures, reroutes and warnings for the homepage Announcement card. Anyone may read
 * the published ones; only administrators post, edit or remove them.
 */
class AnnouncementController extends ApiController
{
    private const MAX_PHOTOS = 6;
    private const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
    private const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

    /** GET /api/announcements — published announcements, newest first. */
    public function index()
    {
        return response()->json(
            Announcement::with('photos')->where('published', true)->orderByDesc('id')->get()
                ->map(fn (Announcement $row) => $row->toApi())
        );
    }

    /** GET /api/announcements/all — administrators: drafts too, with who posted them. */
    public function all()
    {
        return response()->json(
            Announcement::with('photos')->orderByDesc('id')->get()
                ->map(fn (Announcement $row) => $row->toApi(true))
        );
    }

    /**
     * GET /api/announcements/photos/{id} — the image itself. A photo row is never changed
     * once saved (replacing a photo makes a new row), so the browser may keep it for good.
     */
    public function photo(string $id)
    {
        $photo = AnnouncementPhoto::find($id);
        if (! $photo) {
            return response()->json(['error' => 'Photo not found.'], 404);
        }

        return response(base64_decode($photo->data), 200, [
            'Content-Type' => $photo->mime,
            'Cache-Control' => 'public, max-age=31536000, immutable',
        ]);
    }

    /** POST /api/announcements */
    public function store(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $fields = $this->validated($this->body($request));
            $email = $this->actor($request)->email;

            return DB::transaction(function () use ($request, $fields, $email) {
                $row = Announcement::create($fields + [
                    'created_by' => $email,
                    'created_at_iso' => AccountService::isoNow(),
                ]);
                $this->syncPhotos($row, $this->body($request)['photos'] ?? []);

                Setting::touchContentVersion();

                return $row->load('photos')->toApi(true);
            });
        }, 400, 201);
    }

    /** PUT /api/announcements/{id} */
    public function update(Request $request, string $id)
    {
        return $this->attempt(function () use ($request, $id) {
            $row = Announcement::find($id);
            if (! $row) {
                return response()->json(['error' => 'Announcement not found.'], 404);
            }
            $fields = $this->validated($this->body($request));
            $email = $this->actor($request)->email;

            return DB::transaction(function () use ($request, $row, $fields, $email) {
                $row->update($fields + [
                    'updated_by' => $email,
                    'updated_at_iso' => AccountService::isoNow(),
                ]);
                $this->syncPhotos($row, $this->body($request)['photos'] ?? []);

                Setting::touchContentVersion();

                return $row->load('photos')->toApi(true);
            });
        });
    }

    /** DELETE /api/announcements/{id} */
    public function destroy(string $id)
    {
        $row = Announcement::find($id);
        if (! $row) {
            return response()->json(['error' => 'Announcement not found.'], 404);
        }
        DB::transaction(function () use ($row) {
            AnnouncementPhoto::where('announcement_id', $row->id)->delete();
            $row->delete();
        });
        Setting::touchContentVersion();

        return response()->json(['ok' => true]);
    }

    /** The columns to save, after checking every field the form sends. */
    private function validated(array $body): array
    {
        $body = array_map(fn ($v) => is_string($v) ? trim($v) : $v, $body);
        $this->requireFields($body, ['category', 'title', 'location', 'summary', 'details', 'startsAt']);

        if (! in_array($body['category'], Announcement::CATEGORIES, true)) {
            throw new RimasException('Please choose Road Closure, Rerouting or Road Warning.');
        }
        foreach (['title' => 150, 'location' => 200, 'summary' => 300, 'details' => 5000, 'reroute' => 2000] as $field => $max) {
            if (mb_strlen((string) ($body[$field] ?? '')) > $max) {
                throw new RimasException("Please keep the {$field} under {$max} characters.");
            }
        }

        $when = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/';
        $starts = substr((string) $body['startsAt'], 0, 16);
        $ends = substr((string) ($body['endsAt'] ?? ''), 0, 16);
        if (! preg_match($when, $starts) || ($ends !== '' && ! preg_match($when, $ends))) {
            throw new RimasException('Please enter the start and end as a date and time.');
        }
        if ($ends !== '' && $ends <= $starts) {
            throw new RimasException('The end must be after the start.');
        }

        $barangay = (string) ($body['barangay'] ?? '');
        if ($barangay !== '' && ! array_key_exists($barangay, GeoService::barangayCentroids())) {
            throw new RimasException('Unknown barangay: ' . $barangay);
        }

        return [
            'category' => $body['category'],
            'title' => $body['title'],
            'location' => $body['location'],
            'barangay' => $barangay === '' ? null : $barangay,
            'summary' => $body['summary'],
            'details' => $body['details'],
            'reroute' => ($body['reroute'] ?? '') === '' ? null : $body['reroute'],
            'starts_at' => $starts,
            'ends_at' => $ends === '' ? null : $ends,
            'published' => filter_var($body['published'] ?? true, FILTER_VALIDATE_BOOLEAN),
        ];
    }

    /**
     * Makes the stored photos match the list the form sent, in its order. Each entry is
     * either { id } for a photo already saved, or { data: "data:image/...;base64,..." } for
     * a new one; saved photos left out of the list are removed.
     */
    private function syncPhotos(Announcement $row, $photos): void
    {
        if (! is_array($photos)) {
            throw new RimasException('Photos must be sent as a list.');
        }
        if (count($photos) > self::MAX_PHOTOS) {
            throw new RimasException('Please attach at most ' . self::MAX_PHOTOS . ' photos.');
        }

        $kept = [];
        foreach (array_values($photos) as $position => $photo) {
            $caption = mb_substr(trim((string) ($photo['caption'] ?? '')), 0, 200) ?: null;

            if (! empty($photo['id'])) {
                $saved = AnnouncementPhoto::where('announcement_id', $row->id)->find($photo['id']);
                if ($saved) {
                    $saved->update(['position' => $position, 'caption' => $caption]);
                    $kept[] = $saved->id;
                }
                continue;
            }

            if (! preg_match('#^data:(image/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$#', (string) ($photo['data'] ?? ''), $m)
                || ! in_array($m[1], self::PHOTO_TYPES, true)) {
                throw new RimasException('Photos must be JPEG, PNG or WebP images.');
            }
            $bytes = base64_decode(preg_replace('/\s+/', '', $m[2]), true);
            if ($bytes === false || strlen($bytes) > self::MAX_PHOTO_BYTES) {
                throw new RimasException('Each photo must be under 3 MB.');
            }
            // The declared type is only a claim; make sure the bytes really are that image.
            $info = @getimagesizefromstring($bytes);
            if (! $info || ! in_array($info['mime'], self::PHOTO_TYPES, true)) {
                throw new RimasException('One of the photos could not be read as an image.');
            }

            $kept[] = AnnouncementPhoto::create([
                'announcement_id' => $row->id,
                'position' => $position,
                'mime' => $info['mime'],
                'data' => base64_encode($bytes),
                'caption' => $caption,
            ])->id;
        }

        AnnouncementPhoto::where('announcement_id', $row->id)->whereNotIn('id', $kept ?: [0])->delete();
    }
}
