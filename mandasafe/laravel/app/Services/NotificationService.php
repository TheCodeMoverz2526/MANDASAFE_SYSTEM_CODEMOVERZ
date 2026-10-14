<?php

namespace App\Services;

use App\Exceptions\RimasException;
use App\Models\Notification;
use App\Models\Setting;

/**
 * The RIMAS console's admin notification feed — a shared inbox every administrator reads
 * from the same rows, the way the bell icon and the Notifications page always assumed.
 */
class NotificationService
{
    public function nextNotificationId(): string
    {
        return 'NTF-' . (1000 + Setting::nextSequence('nextNotificationSeq'));
    }

    private function nextSortKey(): int
    {
        return ((int) Notification::max('sort_key')) + 1;
    }

    public function create(string $type, string $title, ?string $desc = null): Notification
    {
        return Notification::create([
            'id' => $this->nextNotificationId(),
            'type' => $type,
            'title' => $title,
            'desc' => $desc,
            'created_at_iso' => AccountService::isoNow(),
            'read_at_iso' => null,
            'sort_key' => $this->nextSortKey(),
        ]);
    }

    /** Raised whenever registerAccount() creates a resident/user account, admin console included. */
    public function notifyAccountCreated(array $account): Notification
    {
        return $this->create(
            'account_created',
            'New account created',
            "{$account['name']} ({$account['email']}) just created an account."
        );
    }

    /** Raised when an administrator permanently removes an account from User Management. */
    public function notifyAccountRemoved(array $account, ?string $actorEmail): Notification
    {
        $by = $actorEmail ? " by {$actorEmail}" : '';

        return $this->create(
            'account_removed',
            'Account removed',
            "{$account['name']} ({$account['email']}) was removed{$by}."
        );
    }

    /** Raised when an administrator logs a new accident report. */
    public function notifyIncidentCreated(array $incident, ?string $actorEmail): Notification
    {
        $by = $actorEmail ? " by {$actorEmail}" : '';

        return $this->create(
            'incident_created',
            'Accident report added',
            "{$incident['sev']} {$incident['type']} on {$incident['road']}, {$incident['barangay']} added{$by}."
        );
    }

    /** Raised when an administrator edits an existing accident report. */
    public function notifyIncidentUpdated(array $incident, ?string $actorEmail): Notification
    {
        $by = $actorEmail ? " by {$actorEmail}" : '';

        return $this->create(
            'incident_updated',
            'Accident report updated',
            "{$incident['id']} ({$incident['road']}, {$incident['barangay']}) was updated{$by}."
        );
    }

    /** Raised when an administrator deletes one accident report. */
    public function notifyIncidentDeleted(array $incident, ?string $actorEmail): Notification
    {
        $by = $actorEmail ? " by {$actorEmail}" : '';

        return $this->create(
            'incident_deleted',
            'Accident report deleted',
            "{$incident['id']} ({$incident['date']}, {$incident['barangay']}) was deleted{$by}."
        );
    }

    /**
     * Raised once per "Delete selected", rather than once per row: how many went, the dates
     * they covered and the first few ids, so the feed says what was removed.
     *
     * @param  array<int, array{id: string, date: ?string}>  $incidents  the rows actually deleted
     */
    public function notifyIncidentsDeleted(array $incidents, ?string $actorEmail): ?Notification
    {
        $count = count($incidents);
        if ($count === 0) {
            return null;
        }
        if ($count === 1) {
            return $this->notifyIncidentDeleted($incidents[0] + ['barangay' => 'unknown barangay'], $actorEmail);
        }

        $by = $actorEmail ? " by {$actorEmail}" : '';
        $dates = array_filter(array_column($incidents, 'date'));
        sort($dates, SORT_STRING);
        $span = $dates === [] ? '' : (reset($dates) === end($dates) ? ' from ' . reset($dates) : ' dated ' . reset($dates) . ' to ' . end($dates));
        $ids = array_column($incidents, 'id');
        $sample = implode(', ', array_slice($ids, 0, 3)) . ($count > 3 ? ' and ' . ($count - 3) . ' more' : '');

        return $this->create(
            'incident_deleted',
            'Accident reports deleted',
            "{$count} accident reports{$span} were deleted{$by}: {$sample}."
        );
    }

    /** Raised once per CSV/Excel import, rather than once per row. */
    public function notifyIncidentsImported(int $count, ?string $actorEmail): ?Notification
    {
        if ($count <= 0) {
            return null;
        }
        $by = $actorEmail ? " by {$actorEmail}" : '';
        $plural = $count === 1 ? '' : 's';

        return $this->create(
            'incident_created',
            'Accident data imported',
            "{$count} accident report{$plural} imported{$by}."
        );
    }

    /** Raised when an account sets a new password through "Forgot password?". */
    public function notifyPasswordChanged(array $account): Notification
    {
        return $this->create(
            'password_changed',
            'Password changed',
            "{$account['name']} ({$account['email']}) changed their password."
        );
    }

    /** Raised when a signed-in account edits its own name, email or contact number. */
    public function notifyProfileUpdated(array $account, array $changedFields): Notification
    {
        $labels = ['name' => 'name', 'email' => 'email', 'phone' => 'contact number'];
        $fields = implode(', ', array_map(fn ($f) => $labels[$f] ?? $f, $changedFields));

        return $this->create(
            'profile_updated',
            'Profile updated',
            "{$account['name']} ({$account['email']}) updated their {$fields}."
        );
    }

    public function list(): array
    {
        return Notification::newestFirst()->get()->map->toApi()->all();
    }

    /**
     * What the console asks every few seconds: only the notifications newer than the last
     * one it has, plus the unread total so it notices another administrator reading them.
     * Two indexed queries and usually an empty list — cheap enough to call constantly.
     */
    public function changesSince(int $after): array
    {
        return [
            'latest' => (int) Notification::max('sort_key'),
            'unread' => Notification::whereNull('read_at_iso')->count(),
            'items' => Notification::where('sort_key', '>', $after)->newestFirst()->limit(50)->get()->map->toApi()->all(),
        ];
    }

    public function markRead(string $id): array
    {
        $notification = Notification::find($id);
        if (! $notification) {
            throw new RimasException('Notification not found.');
        }
        if ($notification->read_at_iso === null) {
            $notification->read_at_iso = AccountService::isoNow();
            $notification->save();
        }

        return $notification->toApi();
    }

    public function markAllRead(): void
    {
        Notification::whereNull('read_at_iso')->update(['read_at_iso' => AccountService::isoNow()]);
    }
}
