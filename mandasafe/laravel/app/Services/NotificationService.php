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
