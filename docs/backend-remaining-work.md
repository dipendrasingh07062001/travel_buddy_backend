# Backend remaining work

Status recorded 2026-11-07. This is a working engineering checklist, not a
claim that the backend is launch-ready or a percentage-complete estimate.
Frontend/UI implementation belongs to the Flutter developer.

## Current milestone

- Staff role management (second admin panel step, PRD FR-15 and §18):
  administrators grant or remove the moderator role with
  `POST /admin/users/:userId/staff-role`, with a reason, audited in the same
  transaction. `ADMIN` stays CLI-only. No migration. See
  [Staff roles](../README.md#staff-roles).

## Already implemented

- Staff role management (second admin panel step, in review): administrators
  can make an active account a moderator or remove the role, with a reason.
  Own account and administrators are protected; repeats change nothing;
  races give `409 USER_STATE_CHANGED`. Each change is a `STAFF_ROLE_GRANTED`
  or `STAFF_ROLE_REVOKED` action with the administrator as actor. Claimed
  reports stay claimed and are counted (`claimedReportCount`); releasing
  them automatically is deferred. `ADMIN` is still granted only with the CLI.

- Admin user search (first admin panel step, PRD §6.4 and FR-15, PR #64):
  staff can find an account's ID by exact ID or part of the display name, with
  status and role filters (`GET /admin/users`), or by an exact stored email or
  phone (`POST /admin/users/lookup`). Results carry only status, role,
  restrictions and open report count, never contacts. Contacts stay out of
  URLs and logs; successful lookups are audited as `USER_LOOKED_UP` (one
  additive enum migration). Name searches are not audited.

- Server-startup test deadline (PR #63, found as C2-1 in the admin user search
  review): `test/server-startup.test.ts` starts six real servers at once, and
  under full-suite load their startup sometimes passed the 45 s child deadline.
  Each child now gets 120 s and the hook 150 s; every assertion is unchanged,
  and a child still running at the deadline is killed and fails. The cause
  (resource contention during startup) is likely, not proven. Test-only.

- Duplicate submissions (PR #61): following a community or blocking a user twice at the
  same moment, such as a double-tap, returned `500` because Prisma's upsert
  with an empty update reads before inserting. Both now insert-or-ignore and
  then read the row, so every duplicate gets `200` with the original time. The
  upserts for push devices, profiles, profile photos, mark-read and mute already
  send one atomic insert. Accepting a request still reads first, but its
  serializable transaction retries and maps a clash to `409`; a new test that
  accepts two requests at once on a trip without a room saw no `500` in 5
  rounds. Its code is unchanged.

- Hosted Firebase credentials (roadmap item 28, PR #60, from PR #44): the server can
  read the Firebase service-account key from one secret variable,
  `FIREBASE_SERVICE_ACCOUNT_JSON`, for hosts such as Railway that have no
  secret files. It checks the value offline at startup and refuses to start
  with a fixed reason if it is malformed; the value is never logged. A revoked
  key is only detected by a live sign-in. Setting up Railway and the real key
  is item 29. See [hosted credential setup](firebase-hosted-credentials.md).

- Flaky tests (roadmap item 39, PR #59): `test/rate-limit.test.ts` now starts each
  test's app in `beforeAll`, so app startup no longer counts against the 5 s
  test limit. Setup hooks get 30 s in unit tests and 60 s in integration tests;
  test bodies keep 5 s and 15 s, and nothing is retried. No production code
  changed. The integration hook timeouts were not reproduced; the cause (app
  startup plus data setup in `beforeAll` on a busy machine) is likely, not
  proven.

- Rounding disclosure (PRD §11.2): expense responses show `rounding`
  (`remainderPaise`, `baseSharePaise`) and a per-share `roundingPaise`, so an
  uneven equal split says which members absorbed the leftover paise. The own
  view (`/expenses/me`) adds only `ownRoundingPaise`. The assignment rule is
  unchanged. No migration: it is worked out from the stored shares.

- Publish confirmation (PRD §7.2): every publish, including republishing a
  paused trip, requires `confirmsPersonalPlan: true`, meaning the owner
  confirmed the plan is personal, accurate and not a commercial tour listing.
  The trip stores the latest confirmation time and wording version, shown to
  the owner, in the data export and to moderators, never publicly. Trips
  published earlier are not backfilled. The Flutter client must send
  `confirmsPersonalPlan` when it connects to the publish endpoint.

- Settlement method (PRD §11.5): an optional `method` of up to 50 characters
  on settlement records, such as "UPI" or "Cash". At most 3 digits, so PINs,
  OTPs and card or account numbers are refused. Set only when recording; shown
  with every settlement and in the data export, never in notifications.

- Expense note (PRD §11.1): an optional private `note` of up to 500 characters
  on expenses. Omitting it on edit keeps the current note; `null` or `""`
  clears it. It is recorded in the revision history and the data export.

- Former-member expense payer (PRD §11.1): a member who left or was removed,
  with an active account, can be the payer of a new expense. New participants
  stay current members.

- Required profile photo (PRD §5.4): with `PROFILE_PHOTO_REQUIRED=true`,
  publishing trips, connection requests and community contributions also need
  a profile photo. Off by default; the API refuses to start with it on unless
  photo storage (R2) is fully configured. Turning it on is a founder decision
  recorded in the [setup checklist](backend-setup-checklist.md).

- Feature restrictions (PRD §6.4): staff can block connection requests,
  community posting, trip publishing or messaging for 1–90 days or until
  lifted, directly or from a report. Checked inside each action's transaction;
  the account is notified and can list its active restrictions. See
  [feature restrictions](../README.md#feature-restrictions).
- Moderation notices (PRD §12): removing a trip, post, comment or message, and
  suspending or restoring an account, notify the affected user in-app. Suspended
  accounts get `403 ACCOUNT_SUSPENDED`. Notices carry no reason text or staff
  identity. See [moderation notices](../README.md#moderation-notices).
- Trip date windows (PRD §7.1): a trip can be exact dates or "any N days"
  within a window of up to 92 days, optionally weekends only. See
  [rules and search behaviour](trip-date-windows.md).
- Trip-status filter (PRD §7.3): closed as a documented decision, not new code.
  Public search only ever returns `PUBLISHED` and `FULL` trips, so the PRD's
  "trip status" and "group availability" filters choose between the same two
  states. `availableOnly=true` (open trips with a free place) covers both, and
  each result's `status` lets clients show a "Full" badge. A full-trips-only
  view was not added: no product need was identified, and a second overlapping
  filter would allow contradictory combinations. Revisit if the Flutter filter
  design needs it.
- Home discovery: recent public posts across all communities and a transparent
  `activity` sort for communities. See [contract and rules](home-discovery.md).
- Public-text privacy: reject supported disclosures in public-facing writes and
  mask matching legacy text in public responses without rewriting stored content.
  See [scope, behavior and limits](public-text-privacy.md).
- Atomic connection-request quota: serialize the rolling 20-per-requester limit
  with request/notification creation in PostgreSQL. See [rules and tests](connection-request-limits.md).
- Trip-change history: structured, private, transactional history of material
  trip-plan/status/group changes. See [contract](trip-change-history.md).
  Its migration is part of the existing 34-migration baseline.
- Administrator metrics: private operational counts/status breakdowns and rolling
  creation windows. See [definitions and access rules](admin-metrics.md). This is
  not an admin dashboard or the PRD's full product-success measurement.

## Feature/decision work still open

- The initial operational admin counts are already implemented.
  Daily/monthly engagement, conversion funnels or historical series are not
  included; confirm a product need and privacy/retention decisions before adding
  tracking. They are not silently treated as required MVP features.
- Moderation follow-up: founders must agree severity/escalation, appeals and
  response expectations, including whether moderation notices explain the
  reason. Existing report review/removal is not a complete operational
  moderation policy. Implement any agreed workflow gaps separately.
- Automatic limits for new accounts (PRD §9.2): request limits apply to every
  account equally; stricter limits for new accounts are not built. Moderator
  feature restrictions cover abusive accounts.
- Account/policy notice coverage: decide which notices are mandatory versus
  optional and approved content/version rules. Existing policy acceptance and
  opt-in email preferences do not settle these decisions.
- Community cover images: the Flutter design shows a photo on every community
  card, but communities have no image field yet. Needs an admin upload flow
  using the existing object storage; plan it as its own milestone.
- Recheck PRD-to-API coverage at the end, including edge cases across features.

## Deferred external integrations and launch checks

Maintain the detailed [external setup checklist](backend-setup-checklist.md).
It includes real email provider/domain and unsubscribe/bounce handling, live
Firebase/FCM and storage checks, approved policy URLs/versions, production
hosting/secrets/HTTPS/CORS, backups and restore, monitoring, security/load tests
and final API integration. These require separate verification, not just PRs.

No new external key is required for these public-text safeguards. Keep all service-account
files and provider secrets outside Git and chat. Complete feature work first,
then prepare the agreed provider/setup list together as requested by the founders.
