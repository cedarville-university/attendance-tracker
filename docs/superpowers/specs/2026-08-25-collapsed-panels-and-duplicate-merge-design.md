# Collapsed panels by default + duplicate-scan row merging

## 1. Settings and Diagnostics panels start collapsed; API key warning banner

**Problem:** The Settings and Reader Diagnostics `<details>` panels currently
default to `open`, cluttering the page for day-to-day use. If they start
closed, a user with no API key saved has no visible cue that card lookups
will fail until they scan a card and see a lookup error.

**Change:**

- Remove the `open` attribute from `#settings-panel` and `#diagnostics-panel`
  in `index.html`. Both start collapsed; the user can still expand either via
  its `<summary>`. The diagnostics panel's existing auto-collapse-on-first-
  valid-report logic (`app.js`) is left in place — harmless no-op now that it
  starts closed already.
- Add a new persistent banner element (visually consistent with the existing
  `#restore-session-banner`), placed near the top of the page (after the
  header, before `#app-messages`), that reads something like: "No API key
  saved — scanned cards won't resolve to student names until you add one in
  Settings." It is shown/hidden reactively, not just once at load:
  - Shown on `init()` if `credentials.getCredentials()` has no `keyName`/`key`.
  - Hidden immediately when the user successfully saves credentials
    (`btn-save-credentials` click handler).
  - Shown again when the user clears credentials (`btn-clear-credentials`
    click handler).
  - This is a dedicated persistent element, not a `showAppMessage(...)` toast,
    so it can't be pushed out of the DOM by the `MAX_APP_MESSAGES` cap on
    later info/warning/error messages.

## 2. Duplicate card scans update the existing row instead of adding a new one

**Problem:** Today, `ScanPipeline` only suppresses a scan as a "duplicate" if
the same card code was accepted within `DUPLICATE_SUPPRESS_WINDOW_MS` (2s) —
intended to catch a reader firing multiple reports for one physical tap.
Outside that window, rescanning the same card creates a brand-new attendance
row. This means if the first lookup for a card times out (lookup-error), a
professor having the student rescan later just produces a second, separate
row instead of fixing the first one.

**Change:** `ScanPipeline` gains a second, unbounded-time index —
`recordIdByCardCode: Map<cardCode, recordId>` — tracking the current live
record for each card code (separate from the existing time-windowed
`lastAcceptedByCode` map, which keeps its current behavior for the
suppressed-duplicates stat).

When a candidate scan comes in for a card code that has a live record in
`recordIdByCardCode`:

- No new row is created. This still counts toward the existing
  `suppressedDuplicates` stat (no new attendance line was added), regardless
  of which branch below is taken.
- If that record's `status` is `'lookup-error'` (a previous lookup already
  finished and failed): first flip that record back to `status: 'pending'`,
  `rosterStatus: rosterState.enabled ? 'pending' : 'unchecked'` and fire
  `onRecordUpdated` (so the row shows "Looking up…" again during the retry),
  then kick off a fresh `lookupCard()` call targeting that existing record id
  (reusing the same resolution path as `_resolveScan`, just against an
  existing record instead of a newly-created one). On resolution it updates
  that record/row in place (`onRecordUpdated`, `onStatsChanged`, and
  `onLatestScanUpdate` if it's still the latest scan).

  Stats bookkeeping: the original failed attempt already incremented
  `stats.lookupErrors`. To avoid double-counting when the retry resolves
  (success or failure again), the resolution path decrements whatever stats
  the record's *current* status/rosterStatus previously contributed (reusing
  the same logic as `_decrementStatsForRecord`, used today by `removeRecord`)
  before applying the new result and incrementing the new stats. This makes
  the apply-result step correct regardless of whether it's resolving a
  brand-new record (nothing to decrement) or re-resolving a previously
  failed one (decrements the stale `lookupErrors` credit first).
- If that record's `status` is `'pending'` (a lookup is already in flight)
  or `'accepted'` (already resolved successfully): do nothing further. This
  avoids a second concurrent lookup racing the first and double-counting
  stats (e.g. `totalAccepted` incremented twice for one row) when a duplicate
  scan happens while the original lookup is still in flight.

`recordIdByCardCode` entries are removed when their record is removed
(`removeRecord`) so a rescan of that card code afterward is treated as a
brand-new scan and gets its own new row, same as today. It's also rebuilt
from scratch on `restoreState` (session restore), the same way
`lastAcceptedByCode`/`recordsById` are handled today (note:
`lastAcceptedByCode` is currently *not* restored from a saved session either
— duplicate-window suppression state doesn't survive a reload today, and
that's unchanged by this work).

**Out of scope:** No change to the existing 2-second `lastAcceptedByCode`
window or its `DUPLICATE_SUPPRESS_WINDOW_MS` config value — it continues to
exist and drive the `suppressedDuplicates` stat exactly as today. The new
`recordIdByCardCode` check is an independent, additional condition checked
before creating a new record.
