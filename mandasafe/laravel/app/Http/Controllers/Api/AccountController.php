<?php

namespace App\Http\Controllers\Api;

use App\Services\AccountService;
use Illuminate\Http\Request;

/**
 * User Management in the RIMAS console. Every route here is administrator-only —
 * see the RimasAdmin middleware on the route group.
 */
class AccountController extends ApiController
{
    public function __construct(private AccountService $accounts)
    {
    }

    /** GET /api/accounts */
    public function index()
    {
        return response()->json($this->accounts->listAccounts());
    }

    /** POST /api/accounts */
    public function store(Request $request)
    {
        return $this->attempt(function () use ($request) {
            $body = $this->body($request);
            $this->requireFields($body, ['name', 'email', 'phone', 'password']);
            $created = $this->accounts->registerAccount($body);

            // An admin adding a user may set the role straight away.
            return ($body['role'] ?? null) === 'admin'
                ? $this->accounts->updateAccount($created['id'], ['role' => 'admin'])
                : $created;
        }, 400, 201);
    }

    /** PUT /api/accounts/{id} */
    public function update(Request $request, string $id)
    {
        return $this->attempt(fn () => $this->accounts->updateAccount(rawurldecode($id), $this->body($request)));
    }

    /** DELETE /api/accounts/{id} */
    public function destroy(Request $request, string $id)
    {
        return $this->attempt(fn () => $this->accounts->deleteAccount(rawurldecode($id), $this->actor($request)->email));
    }
}
