<?php

namespace App\Http\Controllers\Api;

use App\Services\AnalyticsService;
use App\Services\OtpService;
use App\Services\SpatialService;
use Illuminate\Http\Request;

/**
 * The open, read-only endpoints: forecasts, city statistics, the hotspot surface, the single
 * summary payload the resident pages use, and the barangay boundaries every map draws.
 */
class AnalyticsController extends ApiController
{
    public function __construct(private AnalyticsService $analytics)
    {
    }

    /** GET /api/predictions */
    public function predictions()
    {
        return response()->json($this->analytics->predictions());
    }

    /** GET /api/stats */
    public function stats()
    {
        return response()->json($this->analytics->stats());
    }

    /** GET /api/summary — totals, per-barangay counts, trend, mix, forecasts, newest reports. */
    public function summary()
    {
        return response()->json($this->analytics->summary());
    }

    /** GET /api/hotspots/barangays — every barangay ranked by accident density. */
    public function barangayHotspots()
    {
        return response()->json($this->analytics->barangayHotspots());
    }

    /** GET /api/hotspots */
    public function hotspots()
    {
        return response()->json($this->analytics->hotspots());
    }

    /** GET /api/prone-areas — KDE features -> Random Forest prediction of accident-prone cells. */
    public function proneAreas()
    {
        return response()->json($this->analytics->proneAreas());
    }

    /** GET /api/severity — severity distribution and the severity classifier's state. */
    public function severity()
    {
        return response()->json($this->analytics->severityClassification());
    }

    /**
     * GET /api/spatial/summary — per barangay: accidents whose POINT falls inside its polygon,
     * accidents per km², and records naming another barangay; plus city-wide location checks.
     */
    public function spatialSummary()
    {
        return response()->json(SpatialService::summary());
    }

    /** GET /api/spatial/nearby?lat=&lng=&radius= — accidents within a radius (meters), nearest first. */
    public function spatialNearby(Request $request)
    {
        $lat = $request->query('lat');
        $lng = $request->query('lng');
        $radius = $request->query('radius', 200);
        if (! is_numeric($lat) || ! is_numeric($lng) || ! is_numeric($radius) || $radius <= 0 || $radius > 5000) {
            return response()->json(['error' => 'Give lat, lng and a radius in meters (1–5000).'], 400);
        }

        $found = SpatialService::nearby((float) $lat, (float) $lng, (float) $radius);

        return response()->json([
            'center' => ['lat' => (float) $lat, 'lng' => (float) $lng],
            'radiusMeters' => (float) $radius,
            'barangay' => SpatialService::locate((float) $lat, (float) $lng)['name'] ?? null,
            'count' => count($found),
            'incidents' => $found,
        ]);
    }

    /** GET /api/barangays — the 27 official barangay polygons, served verbatim. */
    public function barangays()
    {
        $path = config('mandasafe.geojson');

        if (! is_string($path) || ! is_file($path)) {
            return response()->json(['error' => 'Barangay boundary data is missing.'], 500);
        }

        return response()->file($path, ['Content-Type' => 'application/geo+json']);
    }

    /** GET /api/otp-status — which verification channels are configured. */
    public function otpStatus(OtpService $otp)
    {
        return response()->json($otp->status());
    }

    /**
     * POST /api/send-otp — retired.
     *
     * It took the six digits from the browser and delivered them, which left the browser
     * holding the answer to its own test. Verification now starts at /api/auth/login,
     * /api/auth/register or /api/auth/contact and is checked at /api/auth/otp/verify.
     * The route is kept so an old cached copy of login.js gets a clear message instead of
     * silently sending a code nobody checks.
     */
    public function sendOtp()
    {
        return response()->json([
            'error' => 'This page is out of date. Reload it (Ctrl+F5) to use the current sign-in.',
        ], 410);
    }
}
