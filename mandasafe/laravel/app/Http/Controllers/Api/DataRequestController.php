<?php

namespace App\Http\Controllers\Api;

use App\Exceptions\RimasException;
use App\Models\Account;
use App\Models\AccountActivity;
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
    private const STATUSES = ['pending', 'approved', 'sent', 'declined'];

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

    /** GET /api/data-requests/all — administrators: every request, with the account that sent it. */
    public function all()
    {
        $rows = DataRequest::orderByDesc('id')->get();
        $emails = Account::whereIn('id', $rows->pluck('account_id')->unique())->pluck('email', 'id');

        return response()->json($rows->map(fn (DataRequest $row) => $row->toApi() + [
            'account' => $emails[$row->account_id] ?? null,
        ]));
    }

    /** PUT /api/data-requests/{id} — administrators: move a request along the tracker. */
    public function update(Request $request, string $id)
    {
        return $this->attempt(function () use ($request, $id) {
            $body = $this->body($request);
            $status = (string) ($body['status'] ?? '');
            if (! in_array($status, self::STATUSES, true)) {
                throw new RimasException('Unknown status: ' . $status);
            }

            // The resident sees this reason, so a decline without one is refused.
            $reason = trim((string) ($body['reason'] ?? ''));
            if ($status === 'declined' && $reason === '') {
                throw new RimasException('Please give a reason for declining this request.');
            }
            if (mb_strlen($reason) > 1000) {
                throw new RimasException('Please keep the reason under 1000 characters.');
            }

            $row = DataRequest::find($id);
            if (! $row) {
                return response()->json(['error' => 'Request not found.'], 404);
            }

            $changes = [
                'status' => $status,
                'decline_reason' => $status === 'declined' ? $reason : null,
            ];
            // Each step keeps the date it was first reached; pending has none of its own.
            if ($status !== 'pending' && $row->status !== $status) {
                $changes["{$status}_at_iso"] = AccountService::isoNow();
            }
            $row->update($changes);
            AccountActivity::record($row->account_id, 'admin_action',
                "Data request REQ-" . str_pad((string) $row->id, 4, '0', STR_PAD_LEFT)
                . " set to {$status} by {$this->actor($request)->email}."
                . ($status === 'declined' ? " Reason: {$reason}" : ''));

            return $row->toApi();
        });
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
