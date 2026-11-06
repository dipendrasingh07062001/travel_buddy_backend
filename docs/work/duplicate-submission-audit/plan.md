# Plan: duplicate-submission audit

Spec approved by the owner with D1 (PR #47 pattern) and D2 (accept flow: test
only) as recommended.

## Code changes

Two repository functions; nothing else in `src/` changes.

1. `src/modules/communities/community.repository.ts`, `follow()`: keep the
   transaction and `lockActiveCommunity()`. Replace the `upsert` with
   `transaction.communityFollow.createMany({ data: { communityId, userId },
skipDuplicates: true })`, then
   `transaction.communityFollow.findUniqueOrThrow({ where: { communityId_userId } })`.
   The return type stays the same, so `community.service.ts` and the route do
   not change.
2. `src/modules/safety/safety.repository.ts`, `blockUser()`: same change for
   `userBlock` (data `blockerId`, `blockedId`, `createdAt: now`), then
   `findUniqueOrThrow` with the existing `include: blockInclude`. The
   pending-request `updateMany` stays in the same transaction, after the insert,
   unchanged.

Each gets a two-line comment like the one in `policy.repository.ts`: Prisma's
upsert with an empty update reads before inserting, so duplicates raced into a
unique-key error; insert-or-ignore is atomic and the read returns the first row.

Both transactions use the default READ COMMITTED level. A duplicate's
`ON CONFLICT DO NOTHING` waits for the first insert to commit, and the
following read, a new statement, sees that row (Reviewer confirmed in spec
round 1).

## Tests

New file `test/duplicate-submissions.integration.ts`, following the existing
integration files: a fake `TokenVerifier` whose subject is the token itself, so
every round can bootstrap fresh users; `buildApp` plus `app.inject`; everything
created is tracked and deleted in `afterAll` (trips first, which cascades their
requests, rooms and memberships; then follows and blocks; then the community
and users).

Rate limits are counted per user, so fresh users per round stay under them:
block allows 30 per hour (4 per round), bootstrap 20 per minute (1 per user),
connection requests 10 per hour (1 per requester per round).

1. **Follow race**, 20 rounds. One active community made in `beforeAll`. Each
   round bootstraps a new user, checks no follow row exists, sends four
   `POST /communities/:id/follow` at once with `Promise.all`, and expects all
   `200`, one `followedAt` value across the four, and exactly one row.
2. **Block race**, 20 rounds. Each round bootstraps a new blocker and target and
   creates, directly in the database, one published trip owned by each and one
   pending connection request in each direction. That is faster than the API,
   and the test is about the block, not request creation. Trip fields:
   `ownerId`, `communityId`, `originCity`, `startDate` and `endDate` 30 and 34
   days ahead with `durationDays: 5`, `desiredGroupSize: 2`, `description`,
   `status: 'PUBLISHED'` and `publishedAt`. Request fields: `tripId`,
   `requesterId`, `recipientId`, `message`. It then sends four
   `POST /users/:targetId/block` at once and expects all `200`, an identical
   `blockedAt` and an identical complete `data.user` whose `id` is the target,
   exactly one block row, and both requests `BLOCKED`.
3. **Accept flow (D2)**, 5 rounds. Owner and two requesters, with complete
   profiles, made once. Each round, the owner creates and publishes a fresh trip
   through the API with room for both (`desiredGroupSize: 3`), and each
   requester sends a request through the API. Creating a trip already creates
   its room and the owner's participant row, so the test then deletes that room
   (participants cascade) and checks no room exists; this makes the accepts
   take the room-creation path the spec asks about. The owner then accepts both
   at once. Every response must be `200` or `409`, never `500`, and at least one
   must be `200`. Afterwards the trip has exactly one room, with the owner's
   participant row; each successful requester has an active membership and a
   participant row; and `currentGroupSize` is 1 plus the number of successes.

   Finding from the plan review: trips made through the API always have a room,
   so in normal use the accept code finds an existing room. The clash the spec
   describes can only happen for a trip with no room, such as one created before
   rooms existed.

**Proof the tests catch the bug.** I write the tests first and run the file on
the unchanged code; tests 1 and 2 must fail with `500`. That log is saved as
`duplicate-audit-before-fix.log`. Then I make the fix and rerun.

**If test 3 returns `500` at any point,** I stop and report to the owner before
changing the accept code (spec D2).

Existing tests are unchanged. The unit tests use fake repositories, so they do
not touch this code.

## Docs

- `README.md`: in "Destination communities", note that a repeated or
  simultaneous follow returns the existing follow with its original
  `followedAt`; in the blocking section, the same for `blockedAt`.
- `docs/backend-remaining-work.md`: current milestone, then "Already
  implemented" entry.
- `docs/roadmap.md`: mark the "Duplicate-submission audit" row done (PR number
  added after merge) and record PR #60 for item 28.

## Checks

All checks in `AGENTS.md` order, with the dev server stopped first (ask the
owner if it is running). Complete output in root logs named
`duplicate-audit-<check>.log`. One local commit:
`fix(safety): make duplicate follows and blocks idempotent`.

## Risks

- **Follow or block racing its own undo.** If an unfollow or unblock deletes
  the row between the insert and the read, `findUniqueOrThrow` fails with
  `500`. This needs the same user to tap follow and unfollow at the same
  instant; the old code had the same window. Accepted, not handled.
- **Test time.** 63 users (20 for follow, 40 for block, 3 for accept) and 45
  trips (40 for block, 5 for accept); I have not measured the run time. Each
  round is its own test, so its fixtures and burst share that test's 15 s
  limit; only the shared setup (community; accept users) is in `beforeAll`,
  with the 60 s hook limit. Fixtures are recorded for cleanup as soon as they
  are created, so a failed assertion still cleans up.
- **Merge conflict.** The unpushed `chore/repo-cleanup` branch rewrites
  `docs/roadmap.md` and deletes `docs/backend-remaining-work.md`. If it merges
  first, I rebase and move the doc changes to match.
- No API, schema or migration change, so there is nothing to break for the
  Flutter app.

## Changes from the plan

- The accept-test users also need a `displayName`: publishing a trip returned
  `409 PROFILE_INCOMPLETE` without one. Found in the first before-fix run and
  fixed before the run kept in `duplicate-audit-before-fix.log`.
- The README has no separate blocking section, so the block note went into
  "Connection requests and membership", next to the existing sentence on
  blocking.
- Before the fix, 19 of 20 follow rounds and all 20 block rounds failed with
  `500`. One follow round's burst did not collide and passed. All 5 accept
  rounds passed. After the fix, all 45 tests passed
  (`duplicate-audit-after-fix.log`).
