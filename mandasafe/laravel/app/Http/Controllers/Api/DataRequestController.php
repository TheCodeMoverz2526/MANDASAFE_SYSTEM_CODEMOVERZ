<?php

namespace App\Http\Controllers\Api;

use App\Exceptions\RimasException;
use App\Models\DataRequest;
use App\Services\AccountService;
use App\Services\NotificationService;
use Illuminate\Http\Request;

/**
 * The resident "Request Data" form. A request is not fulfilled automatically — it lands in
 * the admin notification inbox, and the office sends the data out by email (3-5 working days).
 */
class DataRequestController extends ApiController
{
    private const ROLES = ['Student', 'Researcher', 'Employee', 'Others'];

    public function __construct(
        private AccountService $accounts,
        private NotificationService $notifications,
    ) {
    }

    /** GET /api/data-requests — the signed-in account's own requests, newest first. */
    public function index(Request $request)
    {
        $account = $this->accounts->accountForToken($this->accounts->tokenFromRequest($request));
        if (! $account) {
            return response()->json(['error' => 'Please sign in to continue.'], 401);
        }

        return response()->json(
            DataRequest::where('account_id', $account->id)->orderByDesc('id')->get()
                ->map(fn (DataRequest $row) => $row->toApi())
        );
    }

    /** POST /api/data-requests — any signed-in account. */
    public function store(Request $request)
    {
        $account = $this->accounts->accountForToken($this->accounts->tokenFromRequest($request));
        if (! $account) {
            return response()->json(['error' => 'Please sign in to continue.'], 401);
        }

        return $this->attempt(function () use ($request, $account) {
            $body = array_map(fn ($v) => is_string($v) ? trim($v) : $v, $this->body($request));
            $this->requireFields($body, ['name', 'role', 'organization', 'dataType', 'purpose', 'delivery']);

            if (! in_array($body['role'], self::ROLES, true)) {
                throw new RimasException('Please choose a role from the list.');
            }
            $role = $body['role'];
            if ($role === 'Others') {
                $this->requireFields($body, ['roleOther']);
                $role = $body['roleOther'];
            }

            $email = $body['delivery'] === 'other' ? ($body['email'] ?? '') : $account->email;
            if (! filter_var($email, FILTER_VALIDATE_EMAIL)) {
                throw new RimasException('Please enter a valid email address for the data.');
            }

            $saved = DataRequest::create([
                'account_id' => $account->id,
                'name' => $body['name'],
                'role' => $role,
                'organization' => $body['organization'],
                'data_type' => $body['dataType'],
                'purpose' => $body['purpose'],
                'email' => $email,
                'status' => 'pending',
                'created_at_iso' => AccountService::isoNow(),
            ]);

            $this->notifications->notifyDataRequested([
                'name' => $body['name'],
                'role' => $role,
                'organization' => $body['organization'],
                'dataType' => $body['dataType'],
                'purpose' => $body['purpose'],
                'email' => $email,
                'account' => $account->email,
            ]);

            return ['ok' => true, 'email' => $email, 'request' => $saved->toApi()];
        }, 400, 201);
    }
}
