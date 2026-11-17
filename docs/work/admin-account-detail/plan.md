# Plan: admin account detail

Spec approved by the owner on 2026-11-17, with D1–D5 as recommended:

- D1: both list filters in this item;
- D2: open data requests in the detail, for administrators only;
- D3: views are not audited;
- D4: moderators and administrators can open the detail;
- D5: content reports are neither listed nor counted per account.

The spec's last revision (after round 3) was not reviewed again. The owner
approved it as is, so this plan review should also check that the plan
matches the final spec.

## Files to change

### `src/modules/admin-users/admin-users.types.ts`

New types:

- `StatusCounts`: `{ submitted, underReview, actioned, dismissed }`.
- `AdminUserDetail`, which mirrors the spec's response:
  - `account`;
  - `activeRestrictions`;
  - `reports: { aboutAccount, filed }`;
  - `claimedReportCount`;
  - `content`;
  - `openDataRequests` (an array or `null`).
- `AdminUserDetailInput`: `{ userId, includeDataRequests, now? }`.

`AdminUserRepository` gains
`detail(input: AdminUserDetailInput): Promise<AdminUserDetail | null>`.
`null` means "no such account", so the route gives `404` (as `lookup`
returns `null`).

### `src/modules/admin-users/admin-users.repository.ts`

`detail` reads the user first (`findUnique`), selecting:

- `id`, `displayName`, `status`, `staffRole`, `createdAt`;
- `deletedAt`, `recordsPurgedAt`, `statusBeforeDeletion`;
- `profile.profilePhotoStorageKey`.

It returns `null` if there is none. It then runs one array
`database.$transaction([...])`, so the reads are batched in one transaction,
as `search` does. The reads, all for this one account:

1. `authIdentity.findMany({ where: { userId, verifiedAt: { not: null } }, select: { type: true } })`.
   This gives `hasVerifiedEmail` and `hasVerifiedPhone`; no value is ever
   selected.
2. `accountRestriction.findMany`, filtered by `userId`, not lifted and
   started, with `endsAt` null or in the future. It selects `id`, `feature`,
   `startsAt`, `endsAt` and `liftedAt`, never `reason`, and is ordered by
   `startsAt`, then `id`. Rows are also passed through `isActiveRestriction`,
   as in `summarize`.
3. `report.groupBy({ by: ['status'], where: { reportedUserId: userId, targetType: { in: ['USER', 'PROFILE_PHOTO'] } } })`.
   `reportedUserId` is only set for those types today. The `targetType`
   condition makes the D5 rule explicit and protects it against a future
   change.
4. `report.groupBy({ by: ['status'], where: { reporterId: userId } })`.
5. `report.count({ where: { reviewerId: userId, status: 'UNDER_REVIEW' } })`.
6. `trip.count({ where: { ownerId: userId } })`.
7. `communityPost.groupBy({ by: ['status'], where: { authorId: userId } })`.
8. `communityComment.groupBy({ by: ['status'], where: { authorId: userId } })`.
9. `userBlock.count({ where: { blockedId: userId } })`.
10. Only when `includeDataRequests`:
    `accountDataRequest.findMany({ where: { userId, status: 'OPEN' }, select: { id, type, createdAt, scheduledFor }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })`.

A helper `statusCounts(groups)` fills every bucket, using `0` for missing
ones. Comments map `ACTIVE` and `EDITED` to `visible`, and `REMOVED` to
`removed`.

No content-report query exists anywhere (D5).

### `src/modules/admin-users/admin-users.routes.ts`

`GET /admin/users/:userId` is registered in the existing scope, so it gets
`no-store` (including on `401`, `429` and errors), the log serializer and
`guard`. Its settings:

- `config.rateLimit: { max: 60, timeWindow: '1 minute' }`;
- `params: userParams`;
- tags `Moderation`, with a description that states the D5 and D2 rules.

A response schema `detailSchema` uses `additionalProperties: false` on every
object and lists every field as required:

- dates are `date-time` strings or `null`;
- `openDataRequests` is `anyOf` an array or `null`.

The handler:

1. `const { role } = await staffIdentity(request, auth)`.
2. `guard(request, () => repository.detail({ userId, includeDataRequests: role === 'ADMIN' }))`.
3. `null` gives `404 USER_NOT_FOUND` ("User not found."), the code and message the
   staff role route already uses.
4. `presentDetail` turns the dates into ISO strings.

### `src/modules/moderation/moderation.repository.ts`

- `listStaffReports(status, userId, page, pageSize)`: when `userId` is
  given, `where` adds
  `{ reportedUserId: userId, targetType: { in: ['USER', 'PROFILE_PHOTO'] } }`.
- `listModerationActions(page, pageSize, target?)`: when `target` is given,
  `where` is `{ targetType, targetId }`. The same `where` is used for the
  count.

### `src/modules/moderation/moderation.routes.ts`

- **`/admin/reports`:** the querystring gains `userId` (`format: uuid`), and
  `ReportQuery` gains `userId?`.
- **`/admin/moderation-actions`:** the querystring gains `targetType` (enum
  of `ReportTargetType`) and `targetId` (`format: uuid`).
  - `dependencies: { targetId: ['targetType'], targetType: ['targetId'] }`
    (draft-07, which Fastify's AJV supports), so one without the other gives
    `400`.
  - The `ReportTargetType` values come from a `const` list next to the
    route, typed with `satisfies readonly ReportTargetType[]`, like
    `userStatuses`.

Nothing else on either route changes.

### `test/admin-users.integration.ts` (P1-1)

Its `switchable: AdminUserRepository` test double must implement the new
`detail` method, or `npm run typecheck` fails (integration tests are
type-checked). `detail` forwards to `prismaAdminUserRepository.detail`, like
the other methods. No assertion changes. The existing moderation tests need
no edits, because the unfiltered predicates and order are unchanged.

## Migration

None. Query access paths are checked during the build (see "Query check").

## Query check (spec "Data")

After the code is written, every new query's SQL is captured. Prisma query
logging is used in a throwaway script; nothing is added to the app. Each
query is then run with `EXPLAIN (ANALYZE, BUFFERS)` on the local database.
That covers:

- the initial user and profile lookup and the ten detail reads;
- the reports filter's list and count statements, with and without
  `status`;
- the audit filter's list and count statements.

The normal planner's output is the baseline. The local tables are small, so
it may rightly choose sequential scans. Each query is then run again in a
transaction with `SET LOCAL enable_seqscan = off`, which ends with the
transaction. That shows the index path that larger tables would use. The
log records, for each query:

- the SQL and its predicates;
- the plan nodes: Index Cond, Filter and Sort;
- the reasoning about how many rows a production-size table would have to
  read. A full index scan is not counted as a selective path.

Expected indexes, all existing:

- reports: `reportedUserId`, `(reporterId, status, createdAt)`,
  `(reviewerId, status)`;
- trips: `ownerId`;
- posts and comments: `(authorId, status, …)`;
- blocks: `blockedId`;
- restrictions: `(userId, feature, liftedAt)`, using the `userId` prefix;
- identities: `userId`;
- data requests: `(userId, createdAt, id)`;
- audit rows: `(targetType, targetId, createdAt)`.

The report filter with `status` may use `reportedUserId` and then filter by
status. That is selective, because one account has few reports.

A migration is proposed, for owner approval, only if a query would read a
large part of a big table to return a few rows (spec "Data"). The output
goes to `admin-account-detail-explain.log`, and the result is summarised in
"Changes from the plan".

## Tests

### Unit: `test/admin-account-detail.test.ts`

No database. The app gets a fake `AdminUserRepository` through
`adminUsers.repository`, and a verifier that accepts any token. Staff checks
still read the database, so the detail cases that need a staff caller are in
the integration test. This file covers what runs before authentication or
needs a fake failure:

- `400 REQUEST_ERROR` for a non-UUID `userId` on the detail;
- `400` for a non-UUID `userId` on `/admin/reports`;
- `400` for `targetId` without `targetType`, for `targetType` without
  `targetId`, for an unknown `targetType`, and for a non-UUID `targetId`;
- `401` with `no-store` on the detail when the verifier rejects the token.

The guarded `500` needs a staff caller, so it is tested in the integration
test with a second app whose repository's `detail` throws.

### Integration: `test/admin-account-detail.integration.ts`

The fixtures follow `admin-users.integration.ts` and `staff-roles.integration.ts`:

- a per-run marker;
- `randomUUID()` accounts with Firebase auth accounts;
- a verifier with `invalid` and `revoked` tokens.

**Callers** (each with its own rate-limit budget):

- `admin`, `adminRate` and `moderator`;
- `suspendedMod` (`SUSPENDED`, `MODERATOR`);
- `pendingMod` (`PENDING_DELETION`, `MODERATOR`, inserted directly, because
  the API cannot create this);
- `user`.

**Targets:**

- `subject`, an active account with:
  - a profile photo, a verified `EMAIL` identity and an unverified `PHONE`
    identity;
  - restrictions: active (no end), active (future end), lifted, expired, and
    starting in the future;
  - reports with `reportedUserId` = `subject` (`USER` and `PROFILE_PHOTO`)
    in all four statuses, each from its own reporter (open reports are
    unique per reporter and target);
  - reports filed by `subject` in all four statuses, each against a
    different target, because open reports are unique per reporter and
    target;
  - three trips in different statuses, posts in `DRAFT`, `PUBLISHED` and
    `REMOVED`, and comments in `ACTIVE`, `EDITED` and `REMOVED`;
  - two blockers;
  - one `OPEN` `ACCESS` request and one `CANCELLED` request.
- `privateOnly`, an active account whose only report is one `SUBMITTED`
  report on a message it sent. This is the S3-1 case.
- `contentOwner`, with reports on every content type: a member-only
  (`DRAFT`) trip, a removed post, a comment, a message and a connection
  request it sent. None of them may appear or be counted.
- `bothVerified`, with a verified email and a verified phone; `phoneOnly`,
  with an unverified email and a verified phone; `noIdentity`, with neither.
  Identity values use the run marker, because normalized values are unique.
- `formerMod`, role `USER`, with two `UNDER_REVIEW` reports where it is the
  reviewer.
- `suspendedUser` and `pendingUser`, the latter with
  `statusBeforeDeletion: 'SUSPENDED'`.
- `erased`, prepared as `PENDING_DELETION` with:
  - a due deletion request, identities, a profile and a blocker;
  - a published post, a comment and a trip;
  - one `USER` report about the account and one `PROFILE_PHOTO` report;
  - a `COMMUNITY_COMMENT` report on its comment, made before erasure, so
    there is a reported comment by an erased author.

Cases:

1. **Callers:**
   - no token, `invalid` and `revoked` give `401` with `no-store`;
   - `user` gives `403 STAFF_ONLY`;
   - `suspendedMod` gives `403 ACCOUNT_SUSPENDED`;
   - `pendingMod` gives the existing pending-deletion refusal (the code the
     other staff routes give, which the test checks);
   - `moderator` and `admin` give `200`.
2. **Targets:**
   - an unknown UUID gives `404 USER_NOT_FOUND`;
   - `admin` can view itself, `moderator`, another admin, and `formerMod`.
3. **Full detail:** `subject` as `admin` gives exactly the expected object,
   checked with `toEqual`, so no extra field passes:
   - account fields, `hasVerifiedEmail: true`, `hasVerifiedPhone: false`;
   - the two active restrictions, with no `reason`;
   - every status bucket in `aboutAccount` and `filed`;
   - the content buckets and `blockedByCount: 2`;
   - `openDataRequests` holding only the open `ACCESS` request.

   The body contains neither stored contact value, nor any blocker's or
   reporter's ID.

4. **Moderator view:** the same as case 3, except `openDataRequests: null`.
5. **Search consistency:**
   `aboutAccount.submitted + underReview === openReportCount` from
   `GET /admin/users?query=<subject id>`.
6. **D5:**
   - `privateOnly` gives all report counts `0`, and the body has no other
     report key;
   - `contentOwner` gives `aboutAccount` all zeros;
   - neither account appears in `?userId=` results (case 11).
7. **Verification:**
   - `bothVerified` gives true/true;
   - `phoneOnly` gives `hasVerifiedEmail: false`, `hasVerifiedPhone: true`;
   - `noIdentity` gives false/false;
   - none of their stored values appears in any body.
8. **Claims:** `formerMod` gives `claimedReportCount: 2`, with role `USER`.
9. **States:**
   - `suspendedUser` matches its account fields;
   - `pendingUser` has `statusBeforeDeletion: 'SUSPENDED'`;
   - an account with no open data request gives `openDataRequests: []` for
     an administrator.
10. **Erasure and purge:**
    - `processAccountErasures` with `MemoryStorage` runs on `erased`. Its
      detail then shows:
      - `DELETED` with `deletedAt` set;
      - the photo and verification flags `false`;
      - `blockedByCount: 0`;
      - its post and comment as `removed`;
      - the trip and both account reports still counted.
    - Then `purgeModerationRecords` runs, through `processAccountErasures`
      with `now` 366 days after `deletedAt`, as `account-deletion.integration.ts`
      does. The detail shows `recordsPurgedAt` set and the same counts.
    - The run passes a no-op `signInAccounts` remover and `MemoryStorage`, so
      cleanup never reaches Firebase or R2. The processor handles every due
      row in the shared database, so the test checks `erased`'s stored state,
      not the processor's totals.
11. **Reports filter:**
    - `?userId=subject` as `moderator` returns exactly `subject`'s `USER`
      and `PROFILE_PHOTO` reports, oldest first, with `totalItems`
      matching;
    - paging: `pageSize=1` over successive pages returns them one at a time,
      in the same order, with the same `totalItems`, and the page after the
      last is empty, still with that `totalItems`;
    - with `&status=SUBMITTED` it returns only those;
    - `?userId=erased` after erasure returns its `USER` and `PROFILE_PHOTO`
      reports but not the `COMMUNITY_COMMENT` report on its comment;
    - `?userId=contentOwner` and `?userId=privateOnly` return an empty page;
    - an unknown UUID gives an empty page;
    - no audit row is written for any of these (the count of
      `REPORT_INSPECTED` rows by the caller is unchanged).
12. **Audit filter:**
    - the test writes these actions directly, with fixed, distinct
      `createdAt` values:
      - three actions on `subject` with `targetType: 'USER'`;
      - one action with `targetId` = `subject`'s ID but another
        `targetType` (`TRIP`);
      - one action on another account;
    - `?targetType=USER&targetId=subject` as `admin` returns exactly the
      three, newest first, with `totalItems: 3`;
    - `pageSize=1` over three pages keeps that order, and page 4 is empty;
    - `?targetType=TRIP&targetId=subject` returns only the `TRIP` row;
    - an unknown ID gives an empty page;
    - `moderator` gives `403 ADMIN_ONLY`.
13. **Failure:** a second app built with a repository whose `detail` throws
    a Prisma-style error carrying a fake contact value. It gives the fixed
    `500` with `no-store`, and the captured log does not contain the value.
    This uses the same log-capture approach as the admin user search test.
14. **Headers and limit:**
    - `no-store` on the detail's `200`, `400`, `403` and `404`;
    - `adminRate` makes 60 requests, then the 61st gives `429` with
      `no-store`.

Erasure note: `processAccountErasures` handles every due deletion in the
shared database, as in the data requests test. Integration files run one at
a time.

Cleanup in `afterAll`, in foreign-key order:

1. moderation actions;
2. reports;
3. restrictions;
4. blocks;
5. comments, posts and the community;
6. messages, conversations and connection requests;
7. trips;
8. data requests and cleanup tasks;
9. identities;
10. users.

The exact helpers follow the existing tests that create the same rows.

## Docs

- **README "Finding accounts":**
  - the detail route, its fields, who sees `openDataRequests`, and that
    views are not audited;
  - the `userId` filter on `/admin/reports`, account reports only (D5);
  - the paired audit filter.
- **`docs/backend-remaining-work.md`:** an "Already implemented" entry
  ("in review"). A "Current milestone" line stays out, as on main.
- **`docs/roadmap.md`:** "In review" at the code stage.

## Risks

- **Two existing routes change.** Both filters are optional, and leaving
  them out gives the current `where`. The existing moderation tests must pass
  unchanged.
- **Detail cost:** eleven small queries per view, each for one account, at
  60 views a minute per staff account at most. This is acceptable for an
  internal tool.
- **Snapshot:** an array `$transaction` runs at READ COMMITTED, so counts may
  come from slightly different moments under concurrent writes. That is
  harmless for an informational view, and is noted in the README.
- **Breaking changes:** none.

## Commit

One local commit on `feature/admin-account-detail`:
`feat(moderation): let staff view an account's moderation detail`. It also
includes the PR #66 status updates.

## Changes from the plan

- **Query check result:** saved in `admin-account-detail-explain.log`.
  - The local tables are tiny, so the normal planner picks sequential scans.
  - With `enable_seqscan` off (transaction-local), every query has a
    selective index path whose Index Cond is the one account or target. This
    includes `reports_reported_user_id_idx` for both filter statements, with
    and without `status`, and the audit index scanned backwards for
    newest-first.
  - No migration is needed.

  The SQL was captured from an equivalent Prisma client with query logging,
  in a throwaway script outside the repository. The app's shared client was
  not changed.

- **Open data requests:** read only when the caller is an administrator,
  with a separate query after the batched reads. The plan listed it as read
  10 in the batch; a conditional entry would have made the batch's types
  awkward.
- **Integration fixtures:**
  - `pendingMod`'s refusal is `403 ACCOUNT_DELETION_PENDING`, the code the
    other staff routes give;
  - the audit `TRIP` row reuses `subject`'s ID as its `targetId`, to show
    that both filter conditions apply.
- **Cases:** cases 13 (failure) and 14 (headers and limit) are in one
  `describe`, and case 9's `openDataRequests: []` check uses `suspendedUser`.
- **Mutation check:** without `verifiedAt: { not: null }`, exactly the
  full-detail and `phoneOnly` tests fail
  (`admin-account-detail-mutation.log`). The condition was restored.
- **First full integration run (`aad-integration.log`) failed, for reasons
  outside this item:**
  - `data-requests.integration.ts` counted 15 open data requests instead of 3. They were leftover rows from an interrupted run of
    `data-requests-admin.integration.ts` at 12:56 IST, before this build's
    runs, plus a stray "alice" account created at 13:04 IST. Rerun alone, it
    failed the same way (`aad-data-requests-alone.log`).
  - A worker crashed natively (exit code `3221226505`) during
    `profiles.integration.ts`. Rerun alone, it passed
    (`aad-profiles-alone.log`). The cause is unknown.

  With the owner's approval, the 16 leftover accounts and their data
  requests, sign-in links and profiles were deleted
  (`aad-db-cleanup.log`). The rerun (`aad-integration-r2.log`) passed: 49
  files and 522 tests, with no crash.
