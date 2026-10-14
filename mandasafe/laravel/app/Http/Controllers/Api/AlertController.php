<?php

namespace App\Http\Controllers\Api;

use App\Services\AccountService;
use App\Services\AnalyticsService;
use App\Services\ResidentNotificationService;
use Illuminate\Http\Request;

/**
 * The bell on the resident pages: new accident reports and new hotspots. Any signed-in
 * account may read it, residents and administrators alike.
 */
class AlertController extends ApiController
{
    public function __construct(
        private ResidentNotificationService $alerts,
        private AccountService $accounts,
    ) {
    }

    /** GET /api/alerts — polled by the resident pages every 30 seconds. */
    public function index(Request $request, AnalyticsService $analytics)
    {
        $account = $this->accounts->accountForToken($this->accounts->tokenFromRequest($request));
        if (! $account) {
            return response()->json(['error' => 'Please sign in to continue.'], 401);
        }

        // Normally done by the background warm already; then this is one settings read.
        $this->alerts->checkForNewHotspots($analytics);

        return response()->json($this->alerts->feedFor($account));
    }

    /** POST /api/alerts/read-all — opening the bell marks everything in it as seen. */
    public function markAllRead(Request $request)
    {
        $account = $this->accounts->accountForToken($this->accounts->tokenFromRequest($request));
        if (! $account) {
            return response()->json(['error' => 'Please sign in to continue.'], 401);
        }

        $this->alerts->markAllRead($account);

        return response()->json(['ok' => true]);
    }
}
