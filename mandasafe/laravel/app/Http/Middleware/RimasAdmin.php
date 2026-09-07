<?php

namespace App\Http\Middleware;

use App\Services\AccountService;
use Closure;
use Illuminate\Http\Request;

/**
 * Reading MandaSafe is open — that is what lets the public landing page and signed-in
 * residents see the reports and predictions the administrators produced. Writing is not:
 * every route behind this middleware needs an active administrator session, and the role is
 * read from the database on every request rather than trusted from the browser.
 */
class RimasAdmin
{
    public function __construct(private AccountService $accounts)
    {
    }

    public function handle(Request $request, Closure $next)
    {
        $account = $this->accounts->accountForToken($this->accounts->tokenFromRequest($request));

        if (! $account) {
            return response()->json(['error' => 'Please sign in to continue.'], 401);
        }

        if (! $account->isAdmin()) {
            return response()->json(['error' => 'Administrator access is required for this action.'], 403);
        }

        $request->attributes->set('rimas_account', $account);

        return $next($request);
    }
}
