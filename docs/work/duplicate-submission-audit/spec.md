# Duplicate-submission audit

- **Roadmap:** "Found later" table, "Duplicate-submission audit of the other
  `upsert` calls" (follow-up from PR #47).
- **PRD sections:** none. Reliability fix; the API contract does not change.
- **Branch:** `fix/duplicate-submission-audit`.

## Problem

PR #47 found that a Prisma `upsert` can read before it inserts. Two identical
requests at the same moment (a double-tap or a client retry) both see "no
row", both insert, and the second fails with a unique-key error (`P2002`),
which the API returns as `500`. PR #47 fixed policy acceptance only and listed
the other `upsert` calls for checking.

### What I checked (2026-11-04, `main` at `193cb24`, local database)

1. **Which `upsert` calls read first.** I logged the SQL Prisma 7 sent for five
   of the call shapes (follow, block, push device, profile, mark-read) inside
   rolled-back transactions. Follow and block, both with `update: {}`, sent
   `SELECT`, then `INSERT`, which can race. Push device, profile and mark-read,
   with scalar data in `update`, sent one `INSERT ... ON CONFLICT DO UPDATE`.
   Profile photo and mute have the same scalar shape, so I infer the same; I did
   not log them. A nonempty `update` is not a general guarantee (Prisma's
   native-upsert rules also exclude nested reads and writes); it holds for these
   call shapes.
2. **Whether the race really happens.** Four identical calls at once, 10 rounds,
   on pairs with no existing row; every row created was deleted afterwards.

Evidence: `duplicate-audit-probes.log` in the repository root (the SQL lines
are shortened; scripts were outside the repo). Future evidence should keep the
full SQL.

| Call                                                                             | SQL           | Race test                     | Verdict                        |
| -------------------------------------------------------------------------------- | ------------- | ----------------------------- | ------------------------------ |
| Community follow, `community.repository.ts:220`                                  | read first    | **27 of 40 failed (`P2002`)** | **Broken: returns 500**        |
| Block a user, `safety.repository.ts:73`                                          | read first    | **30 of 40 failed (`P2002`)** | **Broken: returns 500**        |
| Push device, `push-device.repository.ts:29`                                      | atomic insert | not needed                    | Safe                           |
| Profile update, `profile.repository.ts:41`                                       | atomic insert | 0 of 20 failed                | Safe                           |
| Profile photo, `profile-photo.repository.ts:23`                                  | inferred      | not needed                    | Safe (also locks the user row) |
| Mark read, `messaging.repository.ts:243`                                         | atomic insert | not needed                    | Safe                           |
| Mute, `messaging.repository.ts:262`                                              | inferred      | not needed                    | Safe                           |
| Trip room and its participants on accept, `connection.repository.ts:137`, `:144` | read first    | not run                       | Low risk, see below            |

**Accepting a request** reads first too (inferred from its `update: {}`; not
logged). It runs in a `SERIALIZABLE` transaction with three attempts in total.
Two separate paths keep it from returning `500`:

- PostgreSQL usually reports this kind of clash in `SERIALIZABLE` as a
  serialization failure (`P2034`), and the next attempt runs. It can still
  report a unique violation in some cases.
- A unique violation (`P2002`), or running out of attempts, returns a `409`
  conflict, not `500`.

The clash needs two different requests for the same trip, usually both accepted
by the trip owner at the same moment, while the trip has no room yet. I have
not tested this.

The follow API is documented as idempotent (README "Destination communities"),
so a `500` on a double-tap breaks a promise the Flutter app relies on.

## Proposed behaviour

Follow and block use the same fix as PR #47: insert with
`INSERT ... ON CONFLICT DO NOTHING` (`createMany` with `skipDuplicates`), then
read the row.

- `POST /api/v1/communities/:communityId/follow`: every simultaneous duplicate
  returns `200` with the same `followedAt`, the first follow's time.
- `POST /api/v1/users/:userId/block`: every duplicate returns `200` with the
  same `blockedAt`. Pending requests between the two users are still marked
  `BLOCKED` in the same transaction.
- Existing checks are unchanged: archived community `404`, self-block `409`,
  inactive user `404`, rate limits.

No other call changes.

## Data

No migration. The unique keys already exist: `(community_id, user_id)` on
follows and `(blocker_id, blocked_id)` on blocks.

## Privacy, safety and abuse

No change to who sees what. A block still takes effect at once; a duplicate
block keeps the original `blockedAt`.

## Out of scope

- Changing the accept flow (D2).
- Non-`upsert` double submissions, such as tapping "create trip" twice.
  These create two separate records, not an error, and need an idempotency key
  design of their own.

## Acceptance criteria

- [ ] Follow and block no longer use a read-first `upsert`.
- [ ] Follow race test: 20 rounds, each with a fresh `randomUUID()` user and no
      follow row beforehand; four simultaneous follows of one active community
      all return `200` with the same `followedAt`, and exactly one row exists.
      Created rows are deleted in `afterAll`. Fails on the current code.
- [ ] Block race test: 20 rounds, each with a fresh blocker and target (so the
      30-per-hour block limit is never reached) and no block row beforehand,
      plus one pending connection request in each direction between them.
      Four simultaneous blocks all return `200` with the same `blockedAt` and
      the same `data.user`; exactly one row exists; both requests are
      `BLOCKED`. Cleanup in `afterAll`. Fails on the current code.
- [ ] D2 accept test (see below), on a fresh trip with room for both requesters
      and no trip room yet; successful accepts leave active memberships and
      participant rows.
- [ ] Existing follow, unfollow, block and unblock tests still pass.
- [ ] A short comment at each fix says why (as in `policy.repository.ts`).
- [ ] Docs: the README "Destination communities" and blocking sections say a
      duplicate follow or block returns the original; the roadmap row and
      `docs/backend-remaining-work.md` record the fix. The roadmap also gets
      PR #60 for item 28, because the roadmap says merged items' PR numbers
      are added in the next item's branch.
- [ ] All checks in `AGENTS.md` pass, with complete output in root `*.log`
      files.

## Decisions for the owner

- **D1. Fix pattern.** Recommended: the PR #47 pattern (insert-or-ignore, then
  read), so all such fixes look the same. Alternative: catch `P2002` and read
  the row; this works but leaves an error in the database log for every
  double-tap.
- **D2. Accept flow.** Recommended: no code change; add one integration test
  that accepts two different requests for the same trip at once and checks both
  succeed (or one gets a clean `409`), never `500`. If that test fails, I stop
  and report before fixing anything.
