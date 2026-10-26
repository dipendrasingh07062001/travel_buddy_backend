# Trip date windows

PRD §7.1 allows trip dates to be "fixed dates, flexible by 1-3 days, or a
weekend/month window", with an expected number of days. Fixed and flexible
dates already existed. This milestone adds windows, such as "any 3 days in
December" or "a weekend in March". It adds one migration and no provider or
API key.

## Contract

Each trip has a `dateMode`:

| `dateMode`        | Meaning                                                              | `durationDays`                 | `flexibilityDays` |
| ----------------- | -------------------------------------------------------------------- | ------------------------------ | ----------------- |
| `EXACT` (default) | `startDate`–`endDate` are the trip                                   | derived from the dates         | 0–30, as before   |
| `WINDOW`          | a trip of `durationDays` somewhere between `startDate` and `endDate` | required, entered by the owner | must be 0         |

`weekendsOnly: true` is allowed only on a window and marks a weekend trip.

Rules, all returning `400 INVALID_TRIP_DATES`:

- An exact trip cannot send `durationDays` or `weekendsOnly: true`.
- A window spans at most 92 days and needs `durationDays` that fits inside it.
- A window cannot also be flexible by days; the window is the flexibility.
- A weekend window allows at most 4 days and must include a Saturday or
  Sunday.

When an edit switches `dateMode`, settings that belong only to the old type are
dropped: flexibility when moving to a window, `weekendsOnly` when moving to
exact dates. A window keeps its entered length when only its dates move.

The migration adds `date_mode` (default `EXACT`) and `weekends_only` (default
`false`). Existing trips become exact without being rewritten. The
`trips_date_mode_check` constraint enforces the same rules in PostgreSQL, so an
invalid combination cannot be stored even through another code path.

## Where it appears

`dateMode` and `weekendsOnly` are returned wherever trip dates are shown: public
trip lists and details, the owner's trips, connection-request trip summaries,
the trip room plan, profile activity cards and the account data export. The
fields are additive; existing clients keep working and see the window's range.
Clients should show a window as, for example, "Any 3 days, 1–31 Dec".

Trip change history records `dateMode` and `weekendsOnly`, and changing them,
or a window's length, notifies active members like any other plan change.

## Search and alerts

- Date filters match a window when its range overlaps the searched dates, the
  same inclusive overlap used for exact trips.
- `minDuration` and `maxDuration` use a window's entered length.
- `sort=date_overlap` counts shared days up to the trip's `durationDays`, so a
  31-day window holding a 3-day trip cannot outrank an exact trip sharing four
  days. For exact trips the cap changes nothing.
- Matching-trip alerts already compare the range and `durationDays`, so windows
  match without a separate rule.
- A window leaves search after its last day, like an exact trip.

Not included: changing the existing 0–30 `flexibilityDays` limit (the PRD
mentions 1–3 days), and widening search results by flexibility days.

## Tests

- `test/trip-management.test.ts`: every validation rule, the defaults, and
  switching modes on edit.
- `test/trip-alerts.test.ts`: alert matching for a window.
- `test/trip-date-windows.integration.ts`: API storage, the database rule,
  search overlap, duration filters, the capped overlap sort, change history
  and member notifications.
