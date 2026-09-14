<?php

namespace App\Http\Controllers\Api;

use App\Services\NotificationService;

/**
 * The RIMAS console's notification bell and Notifications page. Administrator-only —
 * see the RimasAdmin middleware on the route group.
 */
class NotificationController extends ApiController
{
    public function __construct(private NotificationService $notifications)
    {
    }

    /** GET /api/notifications */
    public function index()
    {
        return response()->json($this->notifications->list());
    }

    /** PUT /api/notifications/{id}/read */
    public function markRead(string $id)
    {
        return $this->attempt(fn () => $this->notifications->markRead(rawurldecode($id)));
    }

    /** POST /api/notifications/read-all */
    public function markAllRead()
    {
        $this->notifications->markAllRead();

        return response()->json(['ok' => true]);
    }
}
