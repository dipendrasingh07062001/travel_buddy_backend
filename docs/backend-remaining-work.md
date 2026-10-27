# Backend remaining work

Status recorded 2026-10-27. This is a working engineering checklist, not a
claim that the backend is launch-ready or a percentage-complete estimate.
Frontend/UI implementation belongs to the Flutter developer.

## Current milestone

- Settlement method (PRD §11.5): an optional `method` of up to 50 characters
  on settlement records, such as "UPI" or "Cash". At most 3 digits, so PINs,
  OTPs and card or account numbers are refused. Set only when recording; shown
  with every settlement and in the data export, never in notifications.
- One migration (`20261027180000_settlement_method`) adding a nullable column;
  no provider or API key.

## Already implemented

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
- Duplicate-submission audit: policy acceptance used a Prisma `upsert` that
  reads before inserting, so simultaneous identical requests could fail with a
  unique-key error (fixed with an atomic insert-or-ignore). Check the other
  `upsert` calls (community follow, block, push device, profile, conversation
  participants) for the same race before relying on them under double-taps.
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
