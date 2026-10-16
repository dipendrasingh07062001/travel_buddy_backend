# Trip change history

`GET /api/v1/trips/:tripId/history` requires a Firebase Bearer token and an
active local account. It is a private trip-room feature, not a public discovery
feed or an admin dashboard. No additional provider, API key or Flutter change
is needed to run the backend tests.

## Contract

- `pageSize`: 1–100, default 20.
- `beforeVersion`: optional positive 32-bit integer, exclusive cursor.
- Response: `currentVersion`, `data`, and `pagination` containing `pageSize`
  and `nextBeforeVersion` (null when exhausted). Follow the cursor for the
  next page; records are ordered by descending trip version.
- Each record has `id`, `version`, `action`, `createdAt`, `actor` and `changes`.
  Structured changes use `{ "before": ..., "after": ... }`. Money is a
  decimal string, dates are YYYY-MM-DD. Description edits have only
  `{ "changed": true }`; neither text version is stored in the audit trail.
- `actor` is `{id, displayName}` only for an active, unblocked current member.
  Former/deleted/suspended members and non-member staff actors are null.
  No member being accepted/removed, contact data, report reasons, evidence,
  message contents, IP addresses or tokens are copied into the change payload.
- Owners can read their recorded history, including drafts. Other readers must
  be current active members of a previously published trip, with no block
  between themselves and the owner. Members see records from their latest
  acceptance version onward, including that acceptance's group-count change.
  Leaving or removal immediately revokes access. Rejoining starts a new boundary.
  Existing active members start at the next version when this migration runs;
  manually created memberships without a boundary use their join/publication time.
- Missing, outsider-only and moderation-removed trips all return 404. Staff
  roles do not bypass this endpoint's membership rules. Responses are no-store.

## Coverage and retention

New application writes record creation, owner plan edits/status transitions,
acceptance, leave/removal, destination-community merges, moderation removal and
account-erasure trip changes. The record and original write share a transaction:
failed/conflicting writes do not leave an audit event. Community merges now
increment affected trip versions, so a stale owner edit gets the usual conflict.
Membership events show counts/status, not the subject member's identity.

There is **no historical backfill**. Previously created trips start recording
with their next change. No-op edits retain the existing API version behavior but
do not create a false change; gaps in history versions are normal. Seeds,
manual SQL and direct Prisma writes outside these application paths are not
audited. This is a product history, not a tamper-proof regulatory audit system.

Shared structured trip history remains for the lifetime of its trip. Account
erasure clears the erased user's actor references; physical trip deletion
cascades history deletion. Account export includes only changes authored by
the requesting account, without other users or private staff notes. Historical
description text is never retained here, including during later text purges.

Automated tests cover HTTP validation/auth, private read access, latest-join
boundaries, actor redaction, stable pagination, concurrent/stale writes,
rollback, material edits and the other application mutation paths. Test data
belongs in an isolated database, never the running application's database.
