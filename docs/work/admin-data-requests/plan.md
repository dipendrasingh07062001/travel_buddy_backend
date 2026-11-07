# Plan: admin actions on data requests

Spec approved by the owner on 2026-11-07, with D1–D5 as recommended:

- D1: administrators only;
- D2: the audit row links to the request through
  `moderation_actions.data_request_id`;
- D3: no notification;
- D4: no admin action on deletion requests;
- D5: 20 requests per minute.

## Files to change

### `prisma/schema.prisma`

- `enum ModerationActionType`: add `DATA_REQUEST_COMPLETED`, after
  `USER_LOOKED_UP`, with the comment "An administrator finished an ACCESS
  data request by hand."
- `model ModerationAction`: add
  `dataRequestId String? @map("data_request_id") @db.Uuid` and
  `dataRequest AccountDataRequest? @relation(fields: [dataRequestId], references: [id], onDelete: Restrict)`.
  This is modelled on `reportId`. The partial unique index cannot be
  expressed in Prisma, so it lives in the SQL migration, like the existing
  `account_data_requests_one_open_per_type_idx`.
- `model AccountDataRequest`: add the back relation
  `moderationActions ModerationAction[]`.

### Migrations (see "Migration")

There are two folders, timestamped after the latest one on `main`:
`<ts1>_data_request_completion_action` and
`<ts2>_data_request_completion_link`.

### `src/modules/data-requests/data-request.repository.ts`

- `completeAccessRequest(requestId, actorId, note, hooks = {})`. `hooks` has
  one optional `afterRead`, used only by the race tests, as in staff roles.
  It runs one interactive transaction:
  1. `findUnique` the request (`id`, `userId`, `type`, `status`); missing
     gives `404 DATA_REQUEST_NOT_FOUND`.
  2. `type === 'ACCOUNT_DELETION'` gives `409 DATA_REQUEST_AUTOMATIC`:
     "Deletion requests are completed automatically."
  3. `status === 'COMPLETED'` returns `changed: false`.
  4. `status === 'CANCELLED'` gives `409 DATA_REQUEST_NOT_OPEN`: "This
     request is no longer open."
  5. `await hooks.afterRead?.()`.
  6. `updateMany({ where: { id, type: 'ACCESS', status: 'OPEN' }, data: { status: 'COMPLETED', completedAt: now } })`.
     If it matches no row, the request is re-read: a cancellation gives the
     409 from step 4, and a completion by someone else returns
     `changed: false`.
  7. `moderationAction.create` with `actorId`,
     `action: 'DATA_REQUEST_COMPLETED'`, `targetType: 'USER'`,
     `targetId: request.userId`, `reason: note` and `dataRequestId`.
  8. Read the request back with its completion (helper below) and return
     `{ request, changed }`.
- `adminRequestSelect` is shared by the list and the completion. It holds
  the request fields plus
  `moderationActions: { where: { action: 'DATA_REQUEST_COMPLETED' }, select: { id: true, actorId: true }, take: 1 }`.
- `listAdminDataRequests(status, type, page, pageSize)` gains the optional
  `type` filter and uses `adminRequestSelect`.

### `src/modules/data-requests/data-request.routes.ts`

- `cleanAdminNote(note)` trims the note; fewer than 10 characters gives
  `400 INVALID_ADMIN_NOTE`, "An admin note must contain at least 10
  non-space characters." It mirrors `cleanReason`, but this field has its
  own code.
- `adminDataRequestSchema` is `dataRequestSchema` plus `completedById` and
  `completionActionId` (each a UUID or `null`, both required). The user
  routes keep `dataRequestSchema` unchanged, so these two fields can never
  reach users, even by mistake (`additionalProperties: false`).
- `presentAdminRequest(row)` is `presentRequest` plus
  `completionActionId: row.moderationActions[0]?.id ?? null` and
  `completedById: row.moderationActions[0]?.actorId ?? null`.
- `GET /admin/data-requests` gains `type` (enum) in the querystring and uses
  the admin schema and presenter.
- `POST /admin/data-requests/:requestId/complete` is registered inside its
  own `app.register` scope, which adds an `onSend` hook for
  `cache-control: no-store`, as in `admin-users`. Its settings:
  - config `rateLimit: { max: 20, timeWindow: '1 minute' }`; tag
    `Account data`; `security: bearerAuth`;
  - `params`: a UUID `requestId`;
  - `body`: required `note`, a string of 10–1000 characters, with
    `additionalProperties: false`;
  - response `200`: `{ data: adminDataRequestSchema + changed }`.

  The handler runs `authenticateRequest(request, auth, { fresh: true })`,
  then `requireAdmin(await requireStaff(user.id))` (the admin list's
  pattern), then `cleanAdminNote`, then `completeAccessRequest`.

- `registerDataRequestRoutes` gets an optional third argument
  `{ completionHooks }`, passed from `buildApp` options, so the race tests
  can set `afterRead`. Production passes nothing.

### `src/app.ts`

Add `dataRequests?: { completionHooks?: DataRequestCompletionHooks }` to
`BuildAppOptions`, and pass it to `registerDataRequestRoutes`.

### `src/modules/data-export/data-export.repository.ts`

Add `completedAt: true` to the `dataRequests` select. Nothing else changes.

## Migration

`<ts1>_data_request_completion_action/migration.sql`:

```sql
-- An administrator finished an ACCESS data request by hand. Added alone
-- because PostgreSQL cannot use a new enum value in the transaction that
-- adds it, and the next migration's CHECKs use it.
ALTER TYPE "ModerationActionType" ADD VALUE 'DATA_REQUEST_COMPLETED';
```

`<ts2>_data_request_completion_link/migration.sql`. The column and the
foreign key come from `prisma migrate diff`; the CHECKs and the partial
index are added by hand:

```sql
-- Links each manual completion's audit row to the request it completed.
ALTER TABLE "moderation_actions" ADD COLUMN "data_request_id" UUID;
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_data_request_id_fkey"
  FOREIGN KEY ("data_request_id") REFERENCES "account_data_requests"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- Only completion rows carry the link, and every completion row has one.
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_data_request_link_check"
  CHECK ("data_request_id" IS NULL
         OR ("action" = 'DATA_REQUEST_COMPLETED' AND "target_type" = 'USER'));
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_data_request_required_check"
  CHECK ("action" <> 'DATA_REQUEST_COMPLETED' OR "data_request_id" IS NOT NULL);
-- One completion per request.
CREATE UNIQUE INDEX "moderation_actions_one_completion_per_request_idx"
  ON "moderation_actions"("data_request_id") WHERE "data_request_id" IS NOT NULL;
```

Then `npx prisma migrate deploy` and `npx prisma generate`. Running
`migrate diff` again must print an empty migration; that is a required
check. If it is not empty, for example because it proposes dropping the
partial index or a CHECK, the build stops and that is investigated before
anything else. It is not accepted as noise. The existing partial indexes on
`account_data_requests` already give an empty diff today.

## Tests

### Unit: `test/data-requests-admin.test.ts`

No database is needed, because schema checks run before the handler. It
covers:

- a missing note, a note of 9 characters, and one of 1001 characters;
- a non-UUID `requestId`;
- an unknown `type` filter on the list.

Each gives `400 REQUEST_ERROR`.

### Integration: `test/data-requests-admin.integration.ts`

Fixtures, following `staff-roles.integration.ts`:

- a per-run marker;
- `randomUUID()` accounts with Firebase auth accounts;
- a verifier with a `revoked` token.

Administrators: one per group, each making at most 10 completion requests,
which is under the limit of 20:

- `adminAuth`;
- `adminMain`;
- `adminRace`;
- `adminOther`, which completes in the race;
- `adminHeaders`;
- `rateAdmin`, which makes 21 requests.

Others:

- `moderator` and `user`, as callers;
- requesters:
  - `alice` (active), with ACCESS requests created one at a time: the
    database allows only one `OPEN` request per type. The first is inserted
    in `beforeAll` and completed in case 3. The second is created through
    the user route in case 5, after the first is completed, and completed in
    case 6;
  - `suspended`, `pending`, `deletedUser`, for the account states;
  - `canceller`, for the cancel cases;
  - `eraseUser`, with an ACCESS request plus a due `ACCOUNT_DELETION`;
  - `rateUser`.

Requests are created directly in PostgreSQL with known IDs, except where the
case goes through the user route. Two apps are built: the main one, and a
hooked one with `dataRequests.completionHooks`.

Cases:

1. **Callers:** no token gives `401`; `revoked` gives `401`; `user` gives
   `403 STAFF_ONLY`; `moderator` gives `403 ADMIN_ONLY`.
2. **Targets:**
   - an unknown ID gives `404`;
   - a deletion request gives `409 DATA_REQUEST_AUTOMATIC`, unchanged, with
     no audit row;
   - a cancelled request gives `409 DATA_REQUEST_NOT_OPEN`;
   - a note too short after trimming gives `400 INVALID_ADMIN_NOTE`.
3. **Complete:** `alice`'s first request gives `200 changed: true` with:
   - `COMPLETED` and `completedAt`;
   - `completedById` set to `adminMain`;
   - `completionActionId` set to the row's ID.

   There is exactly one audit row, with the trimmed note,
   `dataRequestId`, `targetType USER` and `targetId alice`. The row is found
   in `GET /admin/moderation-actions` with `dataRequestId`, paging by ID.

4. **Repeat:** `changed: false`, the same `completedAt`, and no second row.
5. **New request after completion:** `alice` creates an `ACCESS` request
   through `POST /me/data-requests`. It gives `201` with a new ID and status
   `OPEN`. Repeating the old completion gives `changed: false`, and the new
   request is still `OPEN`.
6. **Two completions, one admin:** completing `alice`'s second request (from
   case 5) gives
   a second audit row. Each row's `dataRequestId` and each request's
   `completionActionId` point at each other, with no crossing.
7. **User view:**
   - `GET /me/data-requests` as `alice` shows `COMPLETED` and `completedAt`,
     with no `completedById` or `completionActionId` keys, and the note
     absent from the body;
   - `POST /me/data-export` shows `completedAt`, with none of the three.
8. **Account states:** the `suspended`, `pending` and `deletedUser` ACCESS
   requests each complete with `200`.
9. **Races:**
   - Cancel in between: `afterRead` cancels the request through the global
     client. The result is `409 DATA_REQUEST_NOT_OPEN`, the request is
     `CANCELLED` and there is no audit row.
   - Another admin in between: `afterRead` completes the request and writes
     `adminOther`'s completion row in one global transaction. The result is
     `200 changed: false` with `completedById` set to `adminOther`, and
     there is exactly one row.
   - Completion first, then the user's cancel: the user's cancel route
     returns `200` with status `COMPLETED`. The completion row and
     `completedAt` are unchanged.
10. **Erasure:**
    - `eraseUser`'s deletion request has `scheduledFor` in the past, and its
      account is `PENDING_DELETION`.
    - The test runs `processAccountErasures` with `MemoryStorage`, a no-op
      sign-in remover and `now` set to the present.
    - Afterwards the deletion request is `COMPLETED` and the account is
      `DELETED`, while the `ACCESS` request is still `OPEN`.
    - Completing it then gives `200`, and both requests are `COMPLETED`.
11. **Audit failure:** a direct `completeAccessRequest` call with a
    `randomUUID()` actor rejects with `P2003`. The request is still `OPEN`,
    with no row.
12. **Database rules:** raw `database.moderationAction.create` calls fail
    for:
    - a `dataRequestId` on a `USER_SUSPENDED` row;
    - a `DATA_REQUEST_COMPLETED` row without one;
    - a second completion row for an already completed request;
    - a `DATA_REQUEST_COMPLETED` row with a valid link but
      `targetType: 'TRIP'`.

    Each is checked by its constraint name, or by `P2002` for the unique
    index.

13. **List:**
    - `?type=ACCESS&status=OPEN` as `adminMain` contains only open `ACCESS`
      requests (checked on this file's IDs);
    - items include the two new fields;
    - a worker-completed deletion has both fields `null`.
14. **Headers and limit:**
    - `no-store` on `200`, `400`, `403`, `404` and `409` from the completion
      route;
    - `rateAdmin` repeats an already completed request 20 times
      (`changed: false`), then the 21st gives `429` with `no-store`.

Erasure note: `processAccountErasures` handles every due deletion in the
shared database. That is acceptable here because integration files run one
at a time, and `account-deletion.integration.ts` already does the same.

Cleanup in `afterAll`, in this order:

1. moderation actions by actor, target or this run's request IDs;
2. account cleanup tasks for this run's users;
3. data requests;
4. users.

## Docs

- **README "Account data requests and deletion":**
  - the `ACCESS` sentence explains how the founders close a request with the
    new route, including the note guidance (no personal data or contacts);
  - the admin list paragraph gains `type` and the two new fields.
- **`docs/backend-remaining-work.md`:** a "Current milestone" entry, plus an
  "Already implemented" entry marked "in review".
- **`docs/roadmap.md`:** the row becomes "In review" at the code stage.

## Risks

- **A migration that touches `moderation_actions`, a shared table.** The
  column is nullable, with no backfill. The CHECKs hold for every existing
  row, because none has the new action or the column. The FK uses `RESTRICT`,
  and nothing deletes data requests.
- **Erasure and purge:** the purge only updates `evidence_storage_key`, so it
  does not conflict with the CHECKs. Erasure never touches `ACCESS` requests.
- **Shared schema object:** separate admin and user response schemas keep
  admin fields away from users.
- **Breaking changes:** none. Admin list items gain fields, and the export
  gains one field.

## Commit

One local commit on `feature/admin-data-requests`:
`feat(data-requests): let administrators complete access requests`. It also
includes the PR #65 status updates.

## Changes from the plan

- **Rate-limit case:** `rateAdmin`'s first request completes its own open
  request (`changed: true`), and the next 19 repeat it (`changed: false`);
  the 21st gives `429`. The plan had 20 repeats of an already completed
  request. The count against the limit is the same.
- **Database rules:** the "link on another action" and "another target
  type" cases point at a request that was never completed. Then the unique
  index cannot fire first and hide the CHECK being tested.
- **Unit test:** the plan's 400 cases are unchanged. A check that invalid
  requests never reach the token verifier was tried and dropped: the
  per-user rate limiter reads the token before schema validation runs.
- `completeAccessRequest` also takes an optional `now`, like the other
  functions in the repository.
