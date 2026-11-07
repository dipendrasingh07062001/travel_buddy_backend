# Plan: admin user search

Implements the approved `spec.md` (owner decisions D1 to D4 at their
defaults: moderators and admins, contact lookup for all staff, counts
included, 60 and 20 per minute).

## Files

### New module `src/modules/admin-users/`

The routes are their own module rather than more code in
`moderation.routes.ts` (already about 400 lines), with an injectable
repository like `admin-metrics`, so tests can make the read or the audit write
fail.

**`admin-users.types.ts`**

- `AdminUserSummary`: `id`, `displayName`, `status`, `staffRole`,
  `createdAt: Date`, `hasProfilePhoto`, `activeRestrictions:
RestrictedFeature[]`, `openReportCount`.
- `AdminUserSearch`: `{ match?: { kind: 'id' | 'name'; value: string };
status?: UserStatus; staffRole?: StaffRole; page; pageSize }`.
- `ContactLookup`: `{ actorId; type: IdentityType; value }`.
- `AdminUserRepository`: `search(input): Promise<{ users: AdminUserSummary[];
totalItems: number }>` and `lookup(input): Promise<AdminUserSummary | null>`.
- `AdminUserDependencies { repository: AdminUserRepository }`.

**`admin-users.service.ts`** (pure functions, unit tested)

- `parseSearchQuery(raw: string | undefined)`: trims; `undefined` stays
  `undefined`; trimmed length under 2 throws
  `AppError(400, 'INVALID_USER_SEARCH', ...)`; contains `@` or starts with `+`
  throws `AppError(400, 'USE_CONTACT_LOOKUP', ...)`; a UUID (same regex as
  `scripts/grant-staff.ts`, case-insensitive, lower-cased) gives
  `{ kind: 'id' }`; anything else `{ kind: 'name' }`. Error messages are fixed
  and never include the value.
- `escapeLike(value)`: replaces `\` with `\\`, `%` with `\%` and `_` with
  `\_`. **Why it is needed:** a probe against the local database on
  2026-11-06 showed Prisma's `contains` does not escape wildcards: `50%`
  matched "ab50cd", `a__b` matched "a_xb", and a lone `\` matched nothing.
  PostgreSQL's default `LIKE` escape character is `\`, so the escaped value
  passed to `contains` matches literally.
- `normalizeContact(type, value)`: `EMAIL` trims and lower-cases (as
  `verifiedContacts` in `auth.repository.ts`); `PHONE` trims only.
- `isActiveRestriction(restriction, now)`: `liftedAt === null`,
  `startsAt <= now`, `endsAt === null || endsAt > now`. The existing
  `isActive` in `restriction.repository.ts` does not check `startsAt`; it is
  left as is (out of scope), and the difference is noted in a comment.
- `safeFailure(error)`: returns `{ errorName, prismaCode? }`. `errorName` is
  `error.constructor.name` (or `'Unknown'`); `prismaCode` is `error.code` only
  when it is a string matching `/^P\d{4}$/`. Nothing else is read.

**`admin-users.repository.ts`** (`prismaAdminUserRepository`)

- `search`: one `database.$transaction([findMany, count])` on `user` with
  `where`:
  - `status` filter if given, else `status: { not: 'DELETED' }`;
  - `staffRole` filter if given;
  - `kind: 'id'`: `id: value`; `kind: 'name'`:
    `displayName: { contains: escapeLike(value), mode: 'insensitive' }`.
  - `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]`, `skip`, `take`.
  - `select`: `id, displayName, status, staffRole, createdAt,
profile: { select: { profilePhotoStorageKey: true } }`.

  Then, for the page's IDs only (skipped when the page is empty), two queries:
  `accountRestriction.findMany` (`userId in ids`, `liftedAt: null`,
  `startsAt <= now`, `endsAt` null or `> now`; select `userId, feature`) and
  `report.groupBy({ by: ['reportedUserId'], where: { reportedUserId in ids,
status in [SUBMITTED, UNDER_REVIEW] }, _count: true })`. Restrictions are
  de-duplicated and sorted per user in `toSummary`.

- `lookup`: one interactive `database.$transaction(async (tx) => ...)`:
  1. `tx.authIdentity.findUnique({ where: { type_normalizedValue: { type,
normalizedValue } }, select: { userId: true } })`; `null` returns `null`.
  2. `tx.moderationAction.create` with `actorId`, `action: 'USER_LOOKED_UP'`,
     `targetType: 'USER'`, `targetId: userId` and the fixed reason
     (`Staff looked up an account by email.` / `... by phone.`).
  3. Read the summary for that one user with the same select and the two
     count queries, through `tx`.

  The audit row is written before the summary is read, and both are in one
  transaction, so if either fails nothing is returned and the audit row is
  rolled back.

**`admin-users.routes.ts`** (`registerAdminUserRoutes(app, auth, overrides)`)

Shared route options for both routes:

- `logSerializers: { req }` where `req` returns the same fields as Fastify's
  default serializer (`node_modules/fastify/lib/logger-pino.js`: `method`,
  `url`, `version`, `host`, `remoteAddress`, `remotePort`) with only `url`
  replaced by `request.url.split('?')[0]` (review P1-2). The request ID stays,
  because `reqId` is a child-logger binding, not part of the serializer. The
  reviewer confirmed in spec round 2 that Fastify 5 applies route-level
  serializers to the "incoming request" line.
- `onSend` hook setting `Cache-Control: no-store`. The reviewer confirmed in
  spec round 3 that a route `onSend` hook runs on the rate-limit plugin's `429`
  reply and on error-handler replies.
- `config.rateLimit`: `{ max: 60, timeWindow: '1 minute' }` for search,
  `{ max: 20, timeWindow: '1 minute' }` for lookup.
- Tag `Moderation`, `security: [{ bearerAuth: [] }]`, response schemas with
  `additionalProperties: false` and every field listed (`displayName` nullable,
  `activeRestrictions` an array of the `restrictedFeatures` enum,
  `createdAt` `date-time`).

`GET /admin/users` handler: `staffIdentity` (existing, exported from
`moderation.routes.ts`), `parseSearchQuery`, then `repository.search` inside
`guard`, then the existing `pagination` helper.

`POST /admin/users/lookup` handler: `staffIdentity`, `normalizeContact`, then
`repository.lookup` inside `guard`; logs `{ event: 'admin_user_lookup',
staffId, contactType, outcome }` at info with `request.log.info`, where
`outcome` is `hit`, `miss` or `failed`.

`guard(request, work)`: awaits `work()`; on an `AppError` rethrows unchanged;
otherwise logs `request.log.error({ event: 'admin_user_query_failed',
...safeFailure(error) }, 'Admin user query failed')` and throws
`new AppError(500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred.')`.
`AppError` attaches no cause (`src/errors/app-error.ts`), so the shared handler
logs only that fixed error and its stack, which points at the route.

Body schema for lookup: `type` enum `EMAIL`/`PHONE`, `value` string
`minLength: 3, maxLength: 320`, both required, `additionalProperties: false`.
Search querystring schema: `query` `minLength: 1, maxLength: 100`, `status`,
`staffRole` enums, `page` and `pageSize` as in `moderation.routes.ts`
(`pageSchema` is not exported; it is copied, as `community-admin.routes.ts`
already does).

### Changed files

- `src/app.ts`: import and register `registerAdminUserRoutes(api,
authDependencies, options.adminUsers)` next to the moderation routes, and add
  `adminUsers?: Partial<AdminUserDependencies>` to `BuildAppOptions` (same
  pattern as `adminMetrics`).
- `prisma/schema.prisma`: add `USER_LOOKED_UP` to `ModerationActionType`,
  with a short comment that it is a read audit and stores no searched value.

No change to `moderation.routes.ts`, the shared error handler, the global
logger or the rate-limit setup.

## Migration

`prisma/migrations/20261107180000_user_lookup_audit/migration.sql`, generated
with `prisma migrate diff` as `AGENTS.md` describes, plus a comment:

```sql
-- Staff looked up an account by an exact email or phone (admin user search).
-- The searched value is never stored.
ALTER TYPE "ModerationActionType" ADD VALUE 'USER_LOOKED_UP';
```

`ADD VALUE` cannot be used in the same transaction as the new value; nothing
in this migration uses it. Re-running the diff must print an empty migration.

Account erasure needs no change: `USER_LOOKED_UP` rows carry no evidence key
and a fixed reason with no personal data, so `purgeModerationRecords` has
nothing to clear in them.

## Tests

### Unit: `test/admin-users.test.ts` (no database)

- `parseSearchQuery`: `undefined`; `"a"`, `"  a  "`, `"   "` give
  `INVALID_USER_SEARCH`; `"a@b"`, `"+91"`, `"  +91"` give
  `USE_CONTACT_LOOKUP`; a UUID in upper case gives `id` lower-cased; `"Priya"`
  gives `name`; error messages never contain the input.
- `escapeLike`: `%`, `_`, `\` and a mixed string.
- `normalizeContact`: email with spaces and capitals; phone trimmed only.
- `isActiveRestriction`: lifted, expired, future, open-ended, ending exactly
  now (inactive).
- `safeFailure`: a Prisma-like error with a message containing an email
  returns only the name and code; a plain `Error`; a non-error value; a
  non-`P` code is dropped.

### Integration: `test/admin-users.integration.ts`

Own users created with `randomUUID()` subjects and IDs and deleted in
`afterAll` (moderation actions targeting them first, then reports,
restrictions, identities and users, as `feature-restrictions.integration.ts`
does). Display names carry a per-run marker (`AUS-<uuid8>`) so name searches
only see this file's users even with other data in the database.

Accounts: admin, moderator, ordinary user, suspended moderator,
pending-deletion moderator, and targets: two sharing one `createdAt`, one
with no profile row, one with a photo, one suspended, one deleted, names
containing `%`, `_` and `\`, an email identity and a phone identity.

Fixtures for counts: restrictions on one target (active open-ended, active
with end date, two active on the same feature, lifted, expired, starting
tomorrow) and reports against it (one each of `SUBMITTED`, `UNDER_REVIEW`,
`ACTIONED`, `DISMISSED`).

Covered, matching the spec's acceptance criteria:

- Access on both routes: no token, an invalid token, and a revoked token
  (the test verifier accepts it for the rate limiter's local check but rejects
  it when called with `checkRevoked: true`) all give `401 UNAUTHENTICATED`
  (review P1-1); ordinary user
  (`STAFF_ONLY`), role removed between two requests (`STAFF_ONLY`), suspended
  staff (`ACCOUNT_SUSPENDED`), pending-deletion staff
  (`ACCOUNT_DELETION_PENDING`), moderator and admin (`200`).
- Search: default listing excludes deleted and orders the tied pair by `id`
  descending; page past the end; UUID hit and miss; case-insensitive name;
  literal `%`, `_`, `\` (a name with `50%` is not matched by `5%` style
  wildcard input, and so on); `status`, `staffRole`, both together and with
  `query`; `status=DELETED`; validation errors (`INVALID_USER_SEARCH`,
  `USE_CONTACT_LOOKUP`, `REQUEST_ERROR` for 101 characters, `page=0`,
  `pageSize=101`); exact key set per item; `hasProfilePhoto`;
  `activeRestrictions` and `openReportCount` against the fixtures.
- Lookup: email in another case with spaces, phone, unstored email (`null`),
  suspended account found, deleted account (identities removed) not found;
  one `USER_LOOKED_UP` row with `actorId`, `targetId` and a reason without the
  value on a hit, none on a miss; `REQUEST_ERROR` for bad `type`, missing and
  321-character `value`.
- Failure and logs: a second app built with `logger: { level: 'info', stream }`
  (capture pattern from `test/error-logging.test.ts`) and
  `adminUsers.repository` overrides:
  - a repository whose `lookup` throws an error whose message contains the
    contact (as a Prisma validation error would) gives `500` with no account
    in the body;
  - a real audit-write failure: the override calls the real
    `prismaAdminUserRepository.lookup` with `actorId` replaced by a random
    UUID of no account, so the `moderation_actions.actor_id` foreign key
    rejects the insert (a genuine Prisma error, inside the real transaction).
    The test asserts `500`, no account in the body, no `USER_LOOKED_UP` row
    for that target, the `admin_user_lookup` line with `outcome: failed`, and
    an `admin_user_query_failed` line with only `errorName` and `prismaCode`;
  - a `search` stub that throws an error containing the searched name;
  - for every captured request (hit, miss, invalid body, unauthorised, 429,
    failing read, failing lookup, failing name search) the joined log text
    does not contain the raw value, `encodeURIComponent(value)` or the
    searched name;
  - exactly one `admin_user_lookup` line per authorised, valid lookup with
    the right `outcome`, and none for rejected requests;
  - the "incoming request" line for both routes still carries `reqId` and the
    path, without the query string (review P1-2).
- `Cache-Control: no-store` on `200`, `400`, `403`, `429` and `500`.
- Rate limits: in the logging app (fresh store) with a stub repository that
  returns empty results, a dedicated moderator makes 60 `GET`s then gets `429`
  on the 61st; a second dedicated moderator makes 20 lookups then gets `429`.
  Own users keep these limits away from the other tests' accounts.

Timing: the 81 rate-limit requests each do a fresh auth and a staff check
against the database. If that pushes a test body past the 15 s limit, the
loop moves into its own `it` with the requests split per route; any timeout
is reported, not retried away.

## Docs

- `README.md`: new subsection "Finding accounts" under "Staff moderation" with
  both routes, filters, response fields, errors, rate limits, the audit and
  logging behaviour, and the stored-contact limits from the spec.
- `docs/backend-remaining-work.md`: "Already implemented" entry; current
  milestone line.
- `docs/roadmap.md`: row "Admin user search (first admin panel step)" in
  "Found later", status set when merged.
- `review.md`: plan rounds, then the code round with checks.

## Risks

- **Enum migration on a live database.** `ALTER TYPE ... ADD VALUE` is safe
  and fast, but it cannot be rolled back by a later migration without
  rebuilding the type. Acceptable: the value is additive and unused by old
  code.
- **Name search speed.** Sequential scan on `users`; fine at beta size. No
  index added (spec "Data").
- **Wildcard escaping depends on PostgreSQL's default `\` escape.** Pinned by
  the integration test with `%`, `_` and `\` names, so a change in Prisma's
  behaviour fails CI rather than silently matching too much.
- **Prisma error shape.** `safeFailure` reads only `constructor.name` and a
  `P`-code; if Prisma renames classes, logs lose detail but never gain
  personal data.
- **Breaking changes:** none. Two new routes and a new enum value; existing
  responses unchanged. `GET /admin/moderation-actions` may now return
  `USER_LOOKED_UP`; it has no response schema (checked in
  `moderation.routes.ts`), so the new value passes through unchanged.

Notes from plan review round 1 (no change of design): the audit-failure test
uses a target with no earlier lookup actions; default-listing assertions only
check this file's marked users and their order, because the shared database
holds other accounts; the `failed` outcome line wraps the guarded repository
call so each failure is counted once; the two rate-limit loops are separate
`it` blocks from the start.

## Changes from the plan

- **Route options moved to a plugin scope.** Fastify 5's TypeScript types do
  not allow `logSerializers` on route options (it works at runtime). Both
  routes are therefore registered inside one `app.register` scope that takes
  `logSerializers` (typed in `register.d.ts`, with a cast because those types
  expect string results), and `Cache-Control: no-store` is a scope-level
  `onSend` hook instead of a route option. The behaviour is the same and is
  limited to these two routes; the tests for `reqId`, the bare path, and
  `no-store` on `200`, `400`, `403`, `429` and `500` pass.
- **Summary queries run one after another**, not with `Promise.all`, because
  the lookup reuses them inside an interactive transaction.
- **Deleted-account lookup test.** The fixture deleted account has no
  identity row, as after erasure; the test checks that its former email
  returns `null` rather than running the erasure worker.
- **Mutation check.** Removing `escapeLike` or the URL stripping made the
  wildcard and log tests fail (3 failures), then the code was restored.
- **Migration renamed** from `20261106120000_user_lookup_audit` to
  `20261107180000_user_lookup_audit`, with the SQL unchanged. PR #62's
  `20261107120000_custom_trip_destinations` merged first, so the old name
  sorted before a migration production already has. The two are independent,
  but the folder order now matches the order they will be applied.
