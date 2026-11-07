# Plan: staff role management

Spec approved by the owner on 2026-11-07, with D1–D4 as recommended:

- D1: the API changes only `USER` and `MODERATOR`; `ADMIN` stays CLI-only;
- D2: claimed reports stay claimed and are reported as `claimedReportCount`;
- D3: no notification;
- D4: 10 requests per minute.

The owner also decided that the admin panel will be a separate web app. That
does not change this item, which stays an API.

## Files to change

### New module `src/modules/staff-roles/`

It is a separate module rather than part of `admin-users`, because it writes
data and has different rules. It follows the same layout as `admin-users`.

- **`staff-role.types.ts`**
  - `assignableRoles = ['USER', 'MODERATOR'] as const satisfies readonly StaffRole[]`.
  - `StaffRoleChange { actorId, targetId, role: AssignableRole, reason }`.
  - `StaffRoleResult { userId, staffRole, changed, claimedReportCount }`.
  - `StaffRoleRepository { change(input): Promise<StaffRoleResult> }`.
  - `StaffRoleDependencies { repository }`.
- **`staff-role.repository.ts`**
  - `createStaffRoleRepository(hooks = {})` returns the repository;
    `prismaStaffRoleRepository = createStaffRoleRepository()`.
  - `hooks` holds one optional async callback, `afterRead`, called inside the
    transaction just before the update. It exists only so tests can force the
    race deterministically (see "Tests"); production passes none.
  - `change(input)` runs in one interactive `database.$transaction`:
    1. Read the target `{ status, staffRole }`; missing gives
       `404 USER_NOT_FOUND`.
    2. Check `targetId === actorId` or `staffRole === 'ADMIN'`; either gives
       `403 STAFF_TARGET_PROTECTED` with the existing message.
    3. If `staffRole === role`, set `changed = false` and skip to step 7.
    4. Grant only: if `status !== 'ACTIVE'`, return `409 USER_NOT_ACTIVE`
       with the message "Only active accounts can become moderators."
    5. `await hooks.afterRead?.()`.
    6. `updateMany` with the spec's predicate:
       - grant: `{ id, staffRole: 'USER', status: 'ACTIVE' }`;
       - revoke: `{ id, staffRole: 'MODERATOR' }`.

       If `count !== 1`, return `409 USER_STATE_CHANGED` with the message
       "The account changed during this request." Then create the
       `moderationAction`:
       `actorId`, `STAFF_ROLE_GRANTED` or `STAFF_ROLE_REVOKED`,
       `targetType: 'USER'`, `targetId` and the reason. Set `changed = true`.

    7. `claimedReportCount = tx.report.count({ where: { reviewerId: targetId, status: 'UNDER_REVIEW' } })`.
    8. Return the result, where `staffRole` is the role now stored.

  Any error, including one thrown by a hook, rolls the whole transaction
  back.

- **`staff-role.routes.ts`**
  - `registerStaffRoleRoutes(app, auth, overrides)` registers one scope with
    an `onSend` hook that sets `cache-control: no-store`, as `admin-users`
    does.
  - `POST /admin/users/:userId/staff-role`:
    - config `rateLimit: { max: 10, timeWindow: '1 minute' }`; tag
      `Moderation`; `security: bearerAuth`.
    - `params`: the existing `userParams` (UUID), already exported from `moderation.routes.ts`.
    - `body`: `additionalProperties: false`, required `role` (enum
      `assignableRoles`) and `reason`, reusing `reasonSchema`'s property.
    - `response 200`: `data { userId (uuid), staffRole (enum all staff roles), changed (boolean), claimedReportCount (integer ≥ 0) }`, with
      `additionalProperties: false`.
    - Handler: `staffIdentity`, then `requireAdmin(role)`, then
      `cleanReason`, then `repository.change(...)`, returning `{ data }`.

### `src/app.ts`

- Add `staffRoles?: Partial<StaffRoleDependencies>` to `BuildAppOptions`.
- Register `registerStaffRoleRoutes(api, authDependencies, options.staffRoles)`
  after `registerAdminUserRoutes`.

## Migration

None. `STAFF_ROLE_GRANTED`, `STAFF_ROLE_REVOKED` and every column already
exist. After the build, `prisma migrate diff` must still be empty.

## Tests

### Unit: `test/staff-roles.test.ts`

This tests the route with a fake repository and a fake verifier, with no
database. The schema rejects:

- `role: 'ADMIN'`;
- a missing reason;
- unknown fields;
- a non-UUID `userId`.

Each of these gives `400 REQUEST_ERROR`. Schema validation runs before the
handler, so these need no authentication or database.

The trimmed-reason case (10 or more characters, but fewer than 10 after
trimming) reaches the handler, which calls `staffIdentity` and therefore
`requireStaff`, a database read. It lives in the integration test, as do the
auth cases.

### Integration: `test/staff-roles.integration.ts`

Fixtures follow `admin-users.integration.ts`:

- a per-run marker and `randomUUID()` accounts, created directly in
  PostgreSQL;
- a token verifier that maps a token to a subject, plus a `revoked` token
  that fails only with `checkRevoked`.

The accounts:

- administrator callers, one per group of cases. Each makes at most 8 POSTs
  (validation failures included), which stays under the route's limit of
  10 per minute per account:
  - `adminAuth`: cases 1, 2 and the trimmed reason;
  - `adminGrant`: cases 3, 4 and 6 for grants;
  - `adminRevoke`: cases 5 and 6 for revokes;
  - `adminRace`: case 9, through the hooked app;
  - `adminClaims`: case 10;
  - `adminHeaders`: case 11's header checks;
  - `rateAdmin`: the rate-limit case only.

  Each case's comment names its caller, so the per-caller budget can be
  checked when reading the file;

- `otherAdmin`, the protected target;
- `moderator` (the caller for `ADMIN_ONLY`);
- `user` (the caller for `STAFF_ONLY`);
- grant targets: `target`, `suspended`, `pending`, `deleted`;
- revoke targets: `mod1`, `suspendedMod`, `modWithClaims`, `otherMod`;
- `raceRole`, `raceStatus`, `raceRevoke`, `auditFail`.

`modWithClaims` and `otherMod` each get `UNDER_REVIEW` reports from a
reporter fixture, with `reviewerId` set to them.

There are two apps:

- the main app, with the real repository;
- a hooked app, built with `staffRoles.repository` set to
  `createStaffRoleRepository(hooks)`, where the test switches `hooks` per
  case.

Cases, one per acceptance criterion:

1. **Callers:**
   - no token: `401`;
   - `revoked`: `401`;
   - `user`: `403 STAFF_ONLY`;
   - `moderator`: `403 ADMIN_ONLY`.
2. **Targets:**
   - unknown UUID: `404 USER_NOT_FOUND`;
   - self: `403 STAFF_TARGET_PROTECTED`;
   - a reason that is too short after trimming:
     `400 INVALID_MODERATION_REASON`;
   - `otherAdmin`: `403 STAFF_TARGET_PROTECTED`.

   Each leaves no new audit row.

3. **Grant:** `target` gives `200` with `changed: true`, `staffRole: MODERATOR`
   and `claimedReportCount: 0`. The database role is `MODERATOR`, and
   `GET /admin/reports` as `target` then gives `200`.
4. **Grant blocked:** `suspended`, `pending` and `deleted` give
   `409 USER_NOT_ACTIVE`, with the role unchanged and no audit row.
5. **Revoke:**
   - `mod1` gives `200` with `staffRole: USER`, and `mod1`'s next
     `GET /admin/reports` gives `403 STAFF_ONLY`;
   - `suspendedMod` gives `200`, and its next staff request gives
     `403 ACCOUNT_SUSPENDED`.
6. **Repeat:** the same request on `target` and on `mod1` gives `200` with
   `changed: false` and no second audit row.
7. **Audit:** exactly one row per change, with `actorId` set to the admin, the
   right action, `targetType: USER`, `targetId` and the trimmed reason. The
   row is found in `GET /admin/moderation-actions` (paging until the row's ID
   appears, because the trail is shared).
8. **Audit fail-closed:** a real audit-insert failure. The test calls
   `prismaStaffRoleRepository.change` directly to grant `auditFail`, with an
   `actorId` that is a fresh `randomUUID()` matching no account. The role
   update succeeds, then `moderationAction.create` fails on the actor
   foreign key (`P2003`). The call rejects, the role is still `USER`, and
   there is no audit row for `auditFail`. This is the same technique admin
   search used. It runs at the repository level, because over HTTP the actor
   is always a real admin.
9. **Races,** using `afterRead` to commit a change through the global
   `database` client (not `tx`) before the update:
   - `raceRole` grant, with the role changed to `MODERATOR`;
   - `raceStatus` grant, with the status changed to `SUSPENDED`;
   - `raceRevoke` revoke, with the role changed to `USER`.

   Each gives `409 USER_STATE_CHANGED`, with no audit row, and the stored
   values are the ones the hook wrote.

10. **Claimed reports:**
    - revoking `modWithClaims` gives `claimedReportCount` equal to its
      fixture count;
    - its reports keep `UNDER_REVIEW`, `reviewerId` and `reviewedAt`;
    - `otherMod`'s reports are not counted;
    - repeating the revoke gives `200`, `changed: false`, the same nonzero
      count, and no new audit row;
    - granting `MODERATOR` back to `modWithClaims` while the claims remain
      gives `changed: true` and the same nonzero count (the count is not
      fixed at 0 on a grant). Then it is revoked again, so the next step
      shows the administrator override;
    - `adminClaims` resolves one of `modWithClaims`'s reports through the
      existing resolve route (`200`). A following repeated revoke reports one
      fewer.
11. **Headers and limits:**
    - `Cache-Control: no-store` on `200`, `400`, `403` and `409`;
    - `rateAdmin` makes 10 no-op requests (its target is already `USER`), and
      the 11th gives `429` with `no-store`.

Isolation:

- Every account and report is created by this file and deleted in
  `afterAll`, in this order: moderation actions by actor or target, then
  reports, then users.
- Every group has its own administrator, and the rate-limit case has its own
  (`rateAdmin`), so no case can hit another case's `429`. The real 10-per-
  minute limit is kept. Nothing waits on wall-clock time.
- `afterRead` is reset after each race case. The race cases run one after
  another, never in parallel.

## Docs

- **`README.md` "Staff moderation":** replace the "only by a database
  operator" paragraph:
  - administrators can grant or remove the moderator role through the new
    route (request, response, rules and errors);
  - `ADMIN` is still granted and revoked only with the CLI, which keeps the
    last-admin rule;
  - claimed reports stay with the former moderator for administrators to
    resolve.
- **`docs/backend-remaining-work.md`:** a "Current milestone" entry, plus an
  "Already implemented" entry marked "in review".
- **`docs/roadmap.md`:** the staff role row becomes "In review" when the code
  goes to review.

## Risks

- **Changing an earlier security stance** (README: "never through a public
  API"). Mitigations: moderator only, admin-only caller, fresh checks, a rate
  limit and audit in the same transaction. Accepted by the owner in D1.
- **Test hooks in production code.** They are optional callbacks that are
  undefined in production, and they are not reachable from HTTP. This
  matches how admin search used a switchable repository in tests.
- **Shared audit trail in tests.** Assertions filter by this run's account
  IDs; the audit-trail route check pages until it finds the row's ID.
- **No breaking changes.** It is a new route; no existing route or schema
  changes.

## Commit

One local commit on `feature/staff-role-management`:
`feat(moderation): let administrators grant and remove the moderator role`.
It also includes the PR #64 status updates already made in the docs.

## Changes from the plan

- **Unknown body fields are dropped, not rejected.** The app's schema
  validator removes properties a schema does not list (Fastify's default
  `removeAdditional`), as admin search found for query parameters. So the
  spec's "unknown fields are rejected with `400`" does not hold for this or
  any other route. The unit case was removed; the integration grant now sends
  an extra `notify: true` and checks that it succeeds and the field has no
  effect. `role: ADMIN`, a missing or short reason, and a non-UUID ID are
  still rejected with `400`.
- **Only the `afterRead` hook exists**, as revised in plan round 1 (P1-3). The
  audit failure is a real foreign-key failure (`P2003`) from a direct
  repository call.
- **Each fixture report has its own reporter**, because the database allows
  one open report per reporter and account (`reports_open_user_target_key`).
- **Mutation check:** with `status: 'ACTIVE'` removed from the grant's update
  predicate, exactly the "grant after the account was suspended" race case
  failed (`staff-roles-mutation.log`). The predicate was then restored.
- **README:** the CLI paragraph is now under a new "Staff roles" heading,
  together with the API route.
