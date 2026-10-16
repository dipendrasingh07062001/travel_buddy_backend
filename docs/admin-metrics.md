# Administrator metrics

`GET /api/v1/admin/metrics/overview?days=30` provides an operational summary for
the founders' future admin UI. This milestone implements the backend API only.
No external analytics service, tracking SDK, API key, schema migration or new
personal-data collection is required.

## Access and contract

- Requires a valid Firebase Bearer token, a provisioned active local account,
  and the local PostgreSQL `ADMIN` role. `USER` and `MODERATOR` are forbidden.
  GitHub access or a Firebase/custom client claim does not grant this role.
  Use the existing reviewed staff-grant workflow; this feature grants no roles.
- The repository rechecks active administrator status in the same repeatable-read
  snapshot used for all counts. No cached role or metrics response is used.
  Revocations apply to subsequent requests; a read already authorized in its
  transaction snapshot may complete.
- `days` supports 7, 30 or 90, default 30. No arbitrary date range, user, city,
  demographic or content filters are supported. Caller-selected IDs/roles have
  no effect on authorization. Invalid windows return 400.
- Returns a `data` object with `generatedAt`, `window` and four count sections:
  `accounts`, `trips`, `connectionRequests` and `reports`.
  Each section contains `total`, `byStatus` and `createdInWindow`.
  All documented status buckets are present, including zeros. `reports.open`
  is the sum of `SUBMITTED` and `UNDER_REVIEW`.
- `window` contains `days`, `from` and `to`. It is a rolling interval of exactly
  N × 24 hours, using PostgreSQL transaction time in UTC, not local calendar
  days. Creation timestamps satisfy `from <= createdAt < to`; future-dated
  records are excluded from window counts. `generatedAt` equals `window.to`.
- Responses are `Cache-Control: private, no-store`. Polling is limited to 30
  requests/minute per verified Firebase subject (the existing rate limiter is
  process-local). Keep dashboard refreshes to once a minute or less; configure
  shared rate limiting if deploying multiple API instances.

## What the numbers mean

Accounts count current retained `ACTIVE`, `SUSPENDED` and `PENDING_DELETION`
accounts with no deletion timestamp, including staff accounts. Erased `DELETED`
tombstones are excluded. `ACTIVE` is an account status, **not** daily/monthly
active users or proof that somebody recently opened the app.

Trips, connection requests and reports count all retained rows, with their
**current** statuses. Trip totals include private drafts, paused/finished trips,
moderation-removed trips and trips owned by erased accounts. They are not counts
of publicly discoverable or currently joinable trips. Creation counts use the
same population as totals, restricted to the selected interval.

These are live snapshots, not an immutable historical analytics warehouse.
Status changes, erasure and physical cleanup can change later snapshots.
`createdInWindow` is not the number of transitions to a status during that
window, accepted-request conversion rate, unique travellers or engagement.
No payment/revenue interpretation or automatic moderation escalation is added.

## Privacy and operational limits

Only counts and window timestamps are returned: no IDs, names, contact details,
locations, messages, report details, free-text content or per-user breakdowns.
Counts are exact and may be small; they are not anonymized public statistics.
Keep this endpoint restricted to administrators. Strict response allowlists
also prevent incidental extra repository fields from being serialized.

Queries run in a read-only transaction, with a five-second per-statement timeout
and a fifteen-second transaction limit. No tracking events, notifications or
stored aggregate copies are written. Existing source-data retention remains
unchanged. Exact on-demand counts still scan data: the timeouts/rate limit are
safeguards, not a claim of unlimited-scale performance. Measure against launch
load targets; add reviewed indexes/preaggregation later if real volume needs it.

Automated contract, repository and PostgreSQL integration tests cover access,
revocation, zero buckets, population/window semantics, response privacy,
read-only behavior, query bounds and polling limits. Real deployment load and
multi-instance rate-limit verification remain on the external setup checklist.
