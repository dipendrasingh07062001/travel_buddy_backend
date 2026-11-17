# Admin actions on data requests

- **Roadmap:** found later (not in the original 39); third admin panel step,
  after admin user search (PR #64) and staff role management (PR #65).
- **PRD sections:**
  - §8.3: "Users must have accessible account deletion and data-request
    routes, subject to required retention."
  - §18 Privacy: "user data-request workflows".
  - §18 Auditability: material account changes produce tamper-resistant logs.
  - §14 FR-15: authorised staff manage account states with audit logging.
- **Branch:** `feature/admin-data-requests`, from `main` at `5930ab8`.

## Problem

Users can file two kinds of request with `POST /me/data-requests`:

- **`ACCOUNT_DELETION`.** This is already fully automatic. The account is
  locked at once. After 30 days the erasure worker marks the request
  `COMPLETED` (`account-erasure.ts`). The user can cancel within that time.
  Administrators see the queue with `GET /admin/data-requests` (type, status,
  `scheduledFor`). They need nothing more here.
- **`ACCESS`.** README: "for the founders to handle by hand; the
  self-service export above covers most needs." But no code path can ever
  close one:
  - the status enum has `COMPLETED`, but only the erasure worker sets it, and
    only for deletions;
  - an `ACCESS` request therefore stays `OPEN` forever, even after the
    founders have answered it;
  - the user's own list (`GET /me/data-requests`) never shows it done;
  - the admin queue (`?status=OPEN`) fills with requests already handled;
  - nothing records who handled a request, or when.

  This is the gap PRD §8.3 and §18 point at: a request workflow that cannot
  be finished, with no audit trail.

## Proposed behaviour

### `POST /api/v1/admin/data-requests/:requestId/complete`

Administrators only, with the same check as the admin list: a fresh Firebase
check, then `requireStaff` and `requireAdmin`. Moderators get
`403 ADMIN_ONLY`. The body is:

```json
{ "note": "at least 10 characters, at most 1000" }
```

`note` is the administrator's internal record of what was done, for example
"Sent the export and moderation history by email on 7 Nov". It is trimmed,
and fewer than 10 characters after trimming gives `400 INVALID_ADMIN_NOTE`.
It is never shown to the user. Administrators are told not to paste the
user's data or contact details into it (README).

Rules, in order:

1. `requestId` must be a UUID (schema), and the request must exist, otherwise
   `404 DATA_REQUEST_NOT_FOUND`.
2. Only `ACCESS` requests can be completed by hand. An `ACCOUNT_DELETION`
   request gives `409 DATA_REQUEST_AUTOMATIC`, because the erasure worker
   completes it.
3. A request that is already `COMPLETED` gives `200` with `changed: false`,
   and nothing is written. A double-tap is harmless.
4. A `CANCELLED` request gives `409 DATA_REQUEST_NOT_OPEN`.
5. The change is a compare-and-set in one transaction:
   `updateMany where { id, type: 'ACCESS', status: 'OPEN' }` sets `COMPLETED`
   and `completedAt`.
   - If the user cancelled in between, the update matches no row.
   - The request is then re-read: a cancellation gives
     `409 DATA_REQUEST_NOT_OPEN`, and a completion by another administrator
     gives `200 changed: false`.
6. In the same transaction, the audit row is written (see "Audit"). If it
   fails, nothing changes.

The response `200` is
`{ "data": { ...the admin data request, "changed": true | false } }`. The
admin request shape (see below) includes `completedById` and
`completionActionId`. The route sends
`Cache-Control: no-store` and allows 20 requests a minute per administrator.

The account's status does not matter. A suspended, pending-deletion or
deleted account's open `ACCESS` request can still be completed, because the
founders may answer it by email after the account is locked. The erasure
worker only touches the account's `ACCOUNT_DELETION` request, never an
`ACCESS` one. So an `ACCESS` request is neither completed nor cancelled by an
erasure.

**A new request after completion.** Once an `ACCESS` request is `COMPLETED`,
the user can file a new one. The existing partial unique index allows one
`OPEN` request per type, and `createDataRequest` reuses only an `OPEN` row.
The new request gets a new ID and starts `OPEN`. The completed one is
unchanged, and repeating its completion returns `changed: false` without
touching the new request. This is intended: a user may ask again later.

### Admin list

`GET /admin/data-requests` adds two fields to each item, both a UUID or
`null`:

- `completionActionId`: the `DATA_REQUEST_COMPLETED` audit row for this
  request;
- `completedById`: that row's `actorId`.

Both are `null` for deletions completed by the worker, and for anything not
completed by hand. They come from the audit row (see "Audit"), not from a
copy on the request. The route also gains `type` as an optional filter
(`ACCESS` or `ACCOUNT_DELETION`), so administrators can list the open
`ACCESS` requests that need work: `?type=ACCESS&status=OPEN`.

### User side

- `GET /me/data-requests` shows the request as `COMPLETED` with its
  `completedAt`.
- It does **not** show `completedById`, `completionActionId` or the note:
  staff identities and
  internal notes are not the user's data about themselves.
- The data export already includes `dataRequests` with `id`, `type`,
  `status`, `createdAt` and `cancelledAt`. It gains `completedAt`, so the
  export matches the user's list. It does not gain the administrator, the
  audit link or the note.

### Notifications (D3)

None. The founders answer `ACCESS` requests outside the app (by email), and
that reply is the user's notice. The user's list shows the new status.

## Audit

The transaction writes one `moderation_actions` row:

- action `DATA_REQUEST_COMPLETED` (new enum value);
- `actorId`: the administrator;
- `targetType: USER`, `targetId`: the request's `userId`;
- `reason`: the trimmed note;
- `dataRequestId` (new nullable column): the completed request's ID.

`dataRequestId` is the durable link between the note and the request (D2).
Several `ACCESS` requests from one user, completed by the same
administrator, each have their own audit row pointing at their own request.
No matching on account, actor or time is needed.

- A partial unique index allows at most one `DATA_REQUEST_COMPLETED` row per
  request.
- `GET /admin/moderation-actions` returns the new field on every row (`null`
  on other actions). That route has no response schema, and its rows already
  carry every column.

This keeps every staff action in the one audit trail that the route already
serves.

## Data

Two migrations. PostgreSQL cannot use a new enum value in the same
transaction that adds it, and the CHECK constraints below use it.

1. `<timestamp>_data_request_completion_action`:
   `ALTER TYPE "ModerationActionType" ADD VALUE 'DATA_REQUEST_COMPLETED';`
2. `<timestamp>_data_request_completion_link`:
   - `ALTER TABLE "moderation_actions" ADD COLUMN "data_request_id" UUID`,
     with a foreign key to `account_data_requests(id)` `ON DELETE RESTRICT`,
     matching `report_id`. Requests are never deleted.
   - CHECK: `data_request_id IS NULL OR (action = 'DATA_REQUEST_COMPLETED' AND target_type = 'USER')`.
   - CHECK: `action <> 'DATA_REQUEST_COMPLETED' OR data_request_id IS NOT NULL`.
   - A partial unique index on `data_request_id` where it is not null: one
     completion row per request.

`account_data_requests` itself does not change. No backfill: no `ACCESS`
request has ever been completed, and existing actions keep
`data_request_id = NULL`.

## Privacy, safety and abuse

- **Administrators only**, with fresh checks, as for the existing admin
  queue. Moderators cannot close privacy requests.
- **Minimal disclosure.** The route returns only the request's own fields.
  The user never sees which administrator handled their request, or the
  internal note.
- **Audit.** Every manual completion is a moderation action with actor and
  note, in the same transaction. Repeats write nothing.
- **Note content.** It is internal and capped at 1000 characters. README
  tells administrators not to paste personal data into it. It is in the
  request body, which is not logged.
- **No early erasure or cancelling for the user (D4).** Administrators cannot
  speed up, cancel or complete a deletion. The 30-day grace period and the
  user's right to cancel stay entirely with the user and the worker.
- **Rate limit:** 20 per minute per administrator.

## Out of scope

- Delivering the data. The founders still produce an `ACCESS` answer by
  hand. Most of it is the self-service export, which the user can download
  themselves.
- An admin-side export of another user's data. It would be a strong,
  separate capability with its own spec.
- Declining or rejecting a request. The PRD does not define grounds; it
  could be a later item.
- Any admin action on deletion requests (D4).
- Notifying the user (D3).
- The admin panel UI.

## Acceptance criteria

- [ ] `POST /admin/data-requests/:requestId/complete` exists with the schema
      above. A missing note, a note under 10 characters, a note over 1000
      characters, or a non-UUID ID gives `400 REQUEST_ERROR`. A note that is
      too short after trimming gives `400 INVALID_ADMIN_NOTE`.
- [ ] Callers: no token gives `401`; a revoked Firebase token is rejected; an
      ordinary user gets `403 STAFF_ONLY`; a moderator gets `403 ADMIN_ONLY`.
- [ ] An unknown request gives `404 DATA_REQUEST_NOT_FOUND`. An
      `ACCOUNT_DELETION` request gives `409 DATA_REQUEST_AUTOMATIC`, unchanged
      and with no audit row.
- [ ] Completing an open `ACCESS` request gives `200` with `changed: true`,
      status `COMPLETED`, `completedAt` set, `completedById` set to the
      administrator and `completionActionId` set to the new audit row. Exactly one `DATA_REQUEST_COMPLETED` audit row is written,
      with the trimmed note and `dataRequestId` set to the request. It is
      visible in `GET /admin/moderation-actions` with `dataRequestId`.
- [ ] Two `ACCESS` requests from the same user, completed one after the
      other by the same administrator, each have their own audit row. Each
      row's `dataRequestId` points at its own request, and each request's
      `completionActionId` points at its own row.
- [ ] After completion, the user can create a new `ACCESS` request. It gets
      a new ID and is `OPEN`. The completed request is unchanged, and
      repeating its completion gives `changed: false` and leaves the new
      request `OPEN`.
- [ ] Repeating the request gives `200 changed: false`, with no second audit
      row and `completedAt` unchanged.
- [ ] A `CANCELLED` request gives `409 DATA_REQUEST_NOT_OPEN`.
- [ ] Races, made deterministic by changing the row between the read and the
      update:
  - the user cancels in between: `409 DATA_REQUEST_NOT_OPEN`, no audit row,
    and the request stays `CANCELLED`;
  - another administrator completes it in between: `200 changed: false`, and
    only that other completion's audit row exists;
  - completion first, then the user's cancel: the cancel returns `200` with
    the request still `COMPLETED`, as `cancelDataRequest` returns the current
    row. The completion and its audit row are unchanged;
  - the same user's `ACCOUNT_DELETION` erased by the worker while their
    `ACCESS` request is open: afterwards the access request can still be
    completed. Both requests are then `COMPLETED`, and the account is
    `DELETED`.
- [ ] If the audit write fails, the request stays `OPEN` (a real
      foreign-key failure, as in staff role management).
- [ ] It works for an `ACCESS` request whose account is suspended, pending
      deletion or deleted.
- [ ] `GET /admin/data-requests`:
  - items include `completedById` and `completionActionId`;
  - `?type=ACCESS&status=OPEN` lists only open access requests;
  - an unknown `type` gives `400`.
- [ ] `GET /me/data-requests` shows `COMPLETED` and `completedAt`, but no
      `completedById`, no `completionActionId` and no note. The data export's
      `dataRequests` gains `completedAt` only.
- [ ] The database rejects, by direct inserts in the test:
  - a `data_request_id` on another action type;
  - a `DATA_REQUEST_COMPLETED` row without one;
  - a `DATA_REQUEST_COMPLETED` row with a valid request link but a target
    type other than `USER`;
  - a second completion row for the same request.
- [ ] `Cache-Control: no-store`; the 21st request in a minute gets `429`.
- [ ] README "Account data requests and deletion" documents the route and
      the note guidance. `docs/backend-remaining-work.md` and
      `docs/roadmap.md` are updated, the migration diff is empty, and all
      AGENTS.md checks pass.

## Decisions for the owner

- **D1. Who can complete requests?** Recommended: administrators only, the
  same as who can see the queue today. The alternative is to let moderators
  complete them too. They cannot see the queue now, and privacy requests are
  a founder responsibility.
- **D2. How is a completion linked to its request?** Recommended: a
  `data_request_id` column on the audit row (`moderation_actions`), with one
  completion per request. The admin list reads the administrator and the
  audit row through it. The alternative, a `completed_by_id` column on the
  request, only names the administrator. It cannot tell two completions of
  the same user's requests apart in the audit trail (round 1, S1-1).
- **D3. Notify the user?** Recommended: no. The founders already reply by
  email when they deliver the data. A notification would need a new
  notification type, a fixed title and push and email handling.
- **D4. Any admin action on deletion requests?** Recommended: none. They stay
  automatic, and only the user can cancel. Letting staff cancel or speed up a
  deletion would override the user's own choice and the grace period.
- **D5. Rate limit.** Recommended: 20 per minute per administrator.
