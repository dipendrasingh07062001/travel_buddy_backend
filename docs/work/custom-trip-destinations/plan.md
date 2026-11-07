# Plan: custom trip destinations

Spec: [`spec.md`](spec.md) (Reviewer APPROVED in round 2). Branch
`feature/custom-trip-destinations`. One local commit at the end, message
`feat(trips): allow custom trip destinations`.

## 1. Database

`prisma/schema.prisma`, model `Trip`:

- `communityId String? @map("community_id") @db.Uuid` and
  `community Community? @relation(..., onDelete: Restrict)`.
- New `destinationName String? @map("destination_name") @db.VarChar(120)`,
  with a short comment: the typed destination when the trip links no
  community; the CHECK keeps exactly one of the two.
- `description String?`.
- Existing indexes stay; `@@index([communityId, status, startDate])` still
  serves community pages.

Migration `prisma/migrations/20261107120000_custom_trip_destinations/migration.sql`,
generated with `prisma migrate diff` as `AGENTS.md` describes, then the CHECK
and a comment added by hand:

```sql
-- A trip names its destination either by linking an active community or by a
-- typed name (PRD 7.1). Existing trips all link a community; no backfill.
ALTER TABLE "trips" ALTER COLUMN "community_id" DROP NOT NULL,
  ALTER COLUMN "description" DROP NOT NULL,
  ADD COLUMN "destination_name" VARCHAR(120);

ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_check" CHECK (
  ("community_id" IS NOT NULL AND "destination_name" IS NULL)
  OR ("community_id" IS NULL AND "destination_name" IS NOT NULL
      AND btrim("destination_name") <> '')
);
```

If the diff also drops and re-adds `trips_community_id_fkey`, I keep what it
generates as long as the new key is still `ON DELETE RESTRICT`. Then
`npx prisma migrate deploy`, `npx prisma generate`, and the diff again must be
empty.

## 2. New helper: `src/modules/trips/trip-destination.ts`

One place for the destination shape, so the five presenters cannot drift:

- `tripDestinationSchema`: `id` (uuid or null), `slug`, `name`, `region`,
  `countryCode` (string or null; `name` always a string).
- `communityDestinationSchema`: today's non-null shape, moved here unchanged.
  Community post and comment responses (`community.routes.ts:155`,
  `profile-activity.routes.ts:23`) reuse `publicTripSchema.properties.destination`
  today; they switch to this one so their contract does not change.
- `presentTripDestination(trip, { original })`: with a community, returns
  `presentPublicDestination(trip.community)` (or the raw fields when
  `original`); without, returns `{ id: null, slug: null, name, region: null,
countryCode: null }`, where `name` is `publicText(destinationName)`, or the
  stored text when `original`.
- `destinationNameProperty`: `{ type: 'string', maxLength: 120 }`, with no
  `minLength`: an empty string must reach the service so it returns
  `INVALID_DESTINATION`, not the schema's `REQUEST_ERROR`. Like `originCity`,
  the schema checks the raw length; the service rejects a value that is blank
  after trimming.

## 3. Trips module

`trip.types.ts`: `publicTripInclude` is unchanged (`community` becomes
nullable through Prisma types; `destinationName` comes with the scalar fields).

`trip.routes.ts`:

- `publicTripSchema.properties.destination` → `tripDestinationSchema`;
  `description` → string or null.
- `tripWriteProperties` gains `destinationName`; `description` becomes
  `anyOf: [{ string, minLength 20, maxLength 2000 }, { null }]` (the same
  pattern as `profile.routes.ts:25`).
- `POST /trips` `required` drops `communityId` and `description`. The body gets
  an `examples` entry with the simple request from the spec.
- Schema descriptions: `communityId` / `destinationName` ("send exactly one"),
  budget per person in INR, approximate, not a quote.

`trip-management.service.ts`:

- `CreateTripBody` / `UpdateTripBody`: `communityId?`, `destinationName?`,
  `description?: string | null`.
- New `resolveDestination(repository, body, required)` returning
  `{ communityId, destinationName: null }`, `{ communityId: null,
destinationName }`, or `undefined` (PATCH with neither):
  - neither (create only), both, or blank after trim →
    `400 INVALID_DESTINATION`;
  - `communityId` → existing `validateCommunity`;
  - `destinationName` → `requireSafePublicText`, trim, then
    `repository.findActiveCommunityIdByName(trimmed)`; an id means linked,
    `null` means custom.
- `createTrip` / `updateTrip` use it; `updateTrip` spreads the result into
  `data`. `description`: `null` stores null, a string is trimmed, omitted keeps
  it.
- `transitionTrip` publish: also `requireSafePublicText(trip.destinationName)`.

`trip-management.types.ts`: `CreateTripInput` gets
`communityId: string | null`, `destinationName: string | null`,
`description: string | null`; the repository interface gains
`findActiveCommunityIdByName(name): Promise<string | null>`.

`trip-management.repository.ts`:

- `findActiveCommunityIdByName`: raw SQL
  `SELECT id FROM communities WHERE status = 'ACTIVE' AND lower(name) =
lower(${name}) LIMIT 2`, returning the id only when exactly one row comes
  back (D1). Raw SQL rather than Prisma's `mode: 'insensitive'`, which may
  compile `equals` to `ILIKE`, where `%` and `_` in a typed name would act as
  wildcards. A comment says why.
- `create`: lock the community only when `communityId` is set.
- `updateOwned`: the existing lock already runs only for a string
  `communityId`. Add `destinationName` to the plan-change field list that
  triggers `TRIP_UPDATED` (line 154).
- Publish: create the `trip_publication_alerts` row only when
  `trip.communityId` is set, with a comment (alerts are per community).

`trip.repository.ts`:

- Search SQL: `LEFT JOIN communities c`, and the filter
  `c."status" = 'ACTIVE'` becomes `(t."community_id" IS NULL OR c."status" =
'ACTIVE')`. The slug filter stays `c."slug" = ...`, which a custom trip never
  matches.
- `findPublicById`: `OR: [{ communityId: null }, { community: { status:
'ACTIVE' } }]`.

`trip.presenter.ts`: `presentTrip` uses `presentTripDestination`;
`presentOwnedTrip` uses it with `original: true`; `description` passes
through `publicText` (already handles null).

`trip-history.ts`: `tripHistorySelect` and `plan()` gain `destinationName`.
The description stays recorded as `{ changed: true }`.

## 4. Other modules

| File                                                                   | Change                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections/connection.types.ts`                                      | trip and `relatedTrip` selects add `destinationName`                                                                                                                                                                              |
| `connections/connection.presenter.ts`, `connection.routes.ts`          | `destination: { slug, name }` built from the community or the custom name (`publicText`); schema `slug` string or null                                                                                                            |
| `messaging/messaging.types.ts`, `messaging.presenter.ts`, `.routes.ts` | `roomSelect.trip.select` adds `destinationName`; room plan uses `presentTripDestination(..., { original: true })` (members already see `originCity` as stored); schema uses `tripDestinationSchema`; `description` string or null |
| `profiles/profile-activity.types.ts`                                   | `profileTripSelect` adds `destinationName`                                                                                                                                                                                        |
| `profiles/profile-activity.repository.ts`                              | trip filter `community: { status: 'ACTIVE' }` → the same `OR` as `findPublicById`                                                                                                                                                 |
| `profiles/profile-activity.presenter.ts`, `.routes.ts`                 | trips use `presentTripDestination` and `tripDestinationSchema`; posts and comments use `communityDestinationSchema`                                                                                                               |
| `communities/community.routes.ts`                                      | post `community` field uses `communityDestinationSchema`; the community trip list already filters by slug                                                                                                                         |
| `moderation/moderation.repository.ts`                                  | TRIP target select adds `communityId` and `destinationName` (no response schema to change)                                                                                                                                        |
| `data-export/data-export.repository.ts`                                | owned-trip select adds `destinationName`                                                                                                                                                                                          |
| `trip-alerts/trip-alert.worker.ts`                                     | no logic change; the type of `trip.community` becomes nullable, so the check reads `!trip.community \|\| trip.community.status !== 'ACTIVE'` after the existing `communityId` comparison                                          |

Unchanged on purpose: community counts (`groupBy` with `communityId: { in }`
skips nulls), admin merge and archive (by community id), account erasure (by
trip and owner), notification titles.

## 5. Tests

Integration tests follow `AGENTS.md`: their own users, communities and trips
with `randomUUID()`, deleted in `afterAll`. Community names in auto-link tests
include the UUID (for example `Kasol ${id}`) so the seed and parallel files
never match. Connection requests are rate-limited per user, so each such test
uses fresh requesters.

**Unit, `test/trip-management.test.ts`** (fake repository gains
`findActiveCommunityIdByName`; fixtures gain `destinationName: null`):

- create and PATCH: `''` and spaces-only names → `INVALID_DESTINATION`
  (asserting the code, through `app.inject`); create with neither or both →
  `INVALID_DESTINATION`; 120 accepted,
  121 and 120 plus outer spaces rejected by the schema; unsafe name →
  `PUBLIC_TEXT_PRIVACY_VIOLATION`; lookup result links or keeps custom; name
  stored trimmed.
- PATCH: both → `INVALID_DESTINATION`; neither leaves destination untouched;
  `communityId` sets `destinationName: null`; `destinationName` sets
  `communityId: null` or links.
- description: omitted and `null` on create store null; PATCH `null` clears,
  omitted keeps; 19 characters fails.
- publish rechecks an unsafe stored destination name.

**New `test/custom-trip-destinations.integration.ts`** (trip API, real
database):

- CHECK constraint matrix with raw SQL (two accepted, six rejected).
- Custom create → read, owner list, edit, publish, `GET /trips`,
  `GET /trips/:tripId`, `GET /me/trip-memberships`: shape and `null`
  description.
- Auto-link matrix on create and PATCH (spec acceptance list), against real
  communities: one match in another case, duplicates, active plus archived,
  archived alone, slug only, region only, "Manali, HP", doubled inner spaces.
- PATCH transitions, stale version `409`, non-owner `403`.
- Explicit `communityId`: an active one still works on create and PATCH; an
  absent UUID and an archived community (created by the test) return
  `400 INVALID_COMMUNITY` on create and PATCH, and a rejected PATCH leaves the
  stored destination and `version` unchanged.
- Masking: a row updated directly to an unsafe name is masked publicly, shown
  to the owner, and blocks publish.
- Excluded from `GET /communities/:slug/trips` and
  `GET /trips?destination=<slug>`; linked trips still listed.
- Members get one `TRIP_UPDATED` per destination change (linked → custom,
  custom → linked, custom → custom), fixed title; history rows show
  `communityId` and `destinationName` before and after.

**New `test/custom-trip-destinations-related.integration.ts`** (other
modules):

- Publish alerts: custom trip creates no `trip_publication_alerts` row; linked
  still does; linked published then edited to custom before the worker runs
  sends no alert (calling the worker as `trip-alerts.integration.ts` does).
- Connection request on a custom trip, and one whose `relatedTrip` is custom:
  `destination` is `{ slug: null, name }`.
- Trip room plan for a custom trip: the custom name, `id`, `slug`, `region`
  and `countryCode` `null`, and a `null` description.
- Public profile activity lists a published custom trip with the same
  destination shape.
- Data export contains `destinationName`.
- Staff report detail shows the custom name for a reported custom trip with a
  `null` description; removal through the existing moderation route works.
- Community counts, archive and merge ignore custom trips; account erasure
  cancels a custom trip and updates memberships.

**Existing tests:** run unchanged; fixture objects get the new nullable fields
where typecheck needs them, including the trip activity fixture in
`test/profile-activity-signals.test.ts`. No assertion is expected to change except where
it pins `description` or `destination` as non-null.

## 6. Checks

With `docker start travel-buddy-postgres` running and `npm run dev` stopped,
in the order of `AGENTS.md` "Checks": `npm ci` only if `package.json` or the
lock file changed (not planned), then `format:check`, `lint`, `db:validate`,
`db:migrate:deploy`, `typecheck`, `test`, `test:integration`, `build`,
`npm audit --audit-level=high`. Full output of each saved to root log files
(`custom-destinations-<check>.log`). A timeout is a failure: rerun the failed
file alone once, report both results, and investigate.

## 7. Docs

- `README.md` "Public trips API" and "Trip management": destination rules,
  auto-link, custom response shape, optional description, per-person budget,
  the simple example, `INVALID_DESTINATION`.
- `docs/backend-remaining-work.md`: current milestone and "Already
  implemented".
- `docs/roadmap.md`: new "Found later" row for this item; PR #61 on the
  duplicate-submission row.
- After the build: `docs/work/custom-trip-destinations/flutter-integration.md`,
  the step-by-step guide the owner asked for (request and response changes,
  what the Flutter app must update, examples, error codes).

## 8. Risks

- **Breaking response change (D3).** `description` and destination fields can
  be `null`. The owner tells the Flutter developer; the guide lists every
  field.
- **Auto-link race.** A community archived between the lookup and the create
  lock gives `404 COMMUNITY_NOT_FOUND`, as a `communityId` request does today.
  Rare, needs an admin action at that moment; accepted.
- **Case folding.** `lower()` follows the database collation; fine for
  English and Hindi place names in the pilot. Not normalising accents or inner
  spaces is the owner's decision D2.
- **Shared database.** Integration tests share the dev database; stop
  `npm run dev` before running them.
- **Migration on production data.** Only drops NOT NULL and adds a nullable
  column and a CHECK that every existing row satisfies; no rewrite of rows.

## Changes from the plan

- **Migration diff not empty, for a reason outside this item.** The shared
  local database has `20261106120000_user_lookup_audit` applied from an
  unmerged branch (staff account search), which added
  `ModerationActionType.USER_LOOKED_UP`. `migrate diff` therefore always
  proposes removing that enum value. This item's own changes diff to nothing,
  and the foreign key was not recreated. I left the other branch's database
  state alone. CI starts from an empty database, so it is not affected.
- **Member notices.** `destinationName` was added to the plan-change list as
  planned, but a destination edit always writes `communityId` too (set or
  `null`), and that already triggers `TRIP_UPDATED`. A mutation check that
  removed the new list entry left the notice test passing, so the test guards
  the behaviour, not that one line.
- **Connection requests.** A typed name goes through `publicText`; a linked
  community's `slug` and `name` are returned as before.
- **README.** "Trip management" gained a "Destination" subsection; the
  existing text after it is now under "Status, edits and dates". The
  moderation section notes the trip's destination in report detail.
- **Worktree setup.** This worktree had no `.env` or `node_modules`: `.env`
  was copied from the main checkout (not printed or committed) and `npm ci`
  was run (`npm-ci.log`). `package.json` and the lock file are unchanged.
- **Test run that left data.** The first run of
  `custom-trip-destinations-related.integration.ts` failed in its own setup
  (cleanup order, a typed name that auto-linked, and the
  `users_pending_deletion_state` CHECK) and its `afterAll` stopped early,
  leaving 8 users, 4 communities and 10 trips. I fixed the test and deleted
  exactly those rows, matched by the run's unique name prefixes.
- **Flutter guide** written as planned:
  [`flutter-integration.md`](flutter-integration.md).
