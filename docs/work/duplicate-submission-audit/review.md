## Spec review, round 1

Verdict: CHANGES REQUESTED

- S1-1 [blocking] `spec.md:83-86` (Acceptance criteria): 20 rounds of four block requests with one caller exceed the unchanged 30/hour limit (`safety.routes.ts:142`); reusing an existing row also stops exercising the insert race. Require a fresh UUID caller/pair per round, an absent follow/block row before each burst, and cleanup in `afterAll`. Scope “all 200” to eligible requests within rate limits, and assert the existing block response's `data.user` as well as `blockedAt`, plus pending requests in both directions becoming `BLOCKED`. This makes the proposed regression test exercise the real transaction and preserve its include and side effects.
- S1-2 [suggestion] `spec.md`, “What I checked” and accept paragraph: distinguish observations from inference. The supplied log has five shape samples with truncated SQL, not every exact call shape; the profile/push samples do not retain the conflict clause, and photo, mute and accept samples are absent. The safe verdicts are consistent with the current scalar queries (profile's guard guarantees a nonempty update), but nonempty `update` alone is not a general native-upsert guarantee: nested writes/reads and other criteria matter. Qualify the statement to these call shapes and retain full SQL when collecting future evidence. SERIALIZABLE can still produce unique violations; describe P2034 retries and the P2002-to-409 fallback separately. There are three total attempts, not three retries, and two requests for one trip normally share one recipient/owner. D2's test-only default remains reasonable.
- S1-3 [suggestion] `spec.md:89-90` (Acceptance criteria): remove the unrelated “PR #60 recorded for item 28”; name the relevant README, backend-remaining-work and roadmap updates required by AGENTS.md. Save complete check output to root `*.log` files as AGENTS.md requires, rather than `logs/`.

### Review evidence and conclusions

- Read AGENTS.md first; confirmed branch `fix/duplicate-submission-audit`. Only this review file was edited.
- `rg -n 'upsert' src` finds nine actual calls, all present in the spec table, plus the policy comment. Read all nine implementations, their unique keys, community lock, policy fix, block service/response include and rate limit, acceptance transaction/retries and API error handling. Follow/block P2002 errors propagate to 500; the other scalar nonempty-update sites are safe against this particular duplicate-insert race. “Safe” is scoped to that race, not all concurrent application actions.
- D1 is correct in the existing default READ COMMITTED transactions: a competing insert-or-ignore waits for the conflicting transaction, and a separate following SELECT obtains a fresh statement snapshot that sees its committed row. Keep both operations on the transaction client, retain the follow community lock, read blocks with `blockInclude`, and keep pending-request updates in the same transaction. The shared community lock permits concurrent follows; it does not serialize them. This reasoning assumes duplicate submissions without a concurrent unfollow/unblock or user deletion.
- D2 is reasonable because acceptance explicitly uses SERIALIZABLE, retries P2034/RetryAcceptance, and returns a conflict for P2002 or exhausted attempts. Use a fresh trip with room for both requesters and no existing conversation so its test actually exercises room/participant creation; verify committed membership/participant state for successful responses. No accept code change is warranted by the supplied evidence.
- Consulted [Prisma v7 native-upsert criteria](https://docs.prisma.io/docs/orm/v7/reference/prisma-client-reference#database-upsert-query-criteria), the [Prisma empty-update issue](https://github.com/prisma/orm/issues/20229), and [PostgreSQL 17 isolation semantics](https://www.postgresql.org/docs/17/transaction-iso.html), including its explicit SERIALIZABLE unique-violation caveat.
- Reviewed the Builder's probe log; did not independently rerun its probes. No tests, CI checks or database mutations were run for this spec-only review. A few initial file searches used nonexistent paths (`tests`, `src/errors/error-handler.ts`, `src/plugins/*`); corrected to `test`, `src/app.ts` and the actual module files. No check is claimed passed.

Builder reply: S1-1 fixed in spec.md "Acceptance criteria": fresh users per
round (block limit never reached), no row before each burst, cleanup in
`afterAll`, `data.user` and both-direction `BLOCKED` checks, and fixture rules
for the D2 test. S1-2 fixed in "What I checked": observed and inferred shapes
are separated, the scalar-shape limit is stated, and the accept paragraph now
describes the `P2034` retry and the `P2002`/exhausted-attempts `409` fallback
separately, with three attempts in total. S1-3 partly accepted: logs now go to
root `*.log` files (the evidence log moved there) and the README,
`backend-remaining-work.md` and roadmap updates are named. The PR #60 line
stays, because `docs/roadmap.md` says a merged item's PR number is added in the
next item's branch; it is housekeeping, not part of the fix.

## Spec review, round 2

Verdict: APPROVED

No new findings.

- S1-1 resolved: fresh fixtures and absent rows exercise insertion each round
  without exhausting the block limit; cleanup, response user, both-direction
  request side effects and D2 committed-state checks are specified.
- S1-2 resolved: observations and inferences are distinguished, native-upsert
  claims are scoped to the current scalar shapes, and acceptance retries and
  conflict fallbacks are described separately with three total attempts.
  The truncated evidence limitation is explicit; full SQL remains appropriate
  for future evidence collection.
- S1-3 resolved or reasonably declined: required docs and root log files are
  named. Retaining PR #60 housekeeping follows `docs/roadmap.md:5-6`.

Read AGENTS.md first; confirmed the requested branch, reviewed the revised
spec, Builder reply and root probe log, and checked the relevant repository
code and roadmap policy. No new problem introduced by the revisions was found.
Only this review file was edited. No tests, probes, CI checks or database
changes were run for this read-only spec review.

## Plan review, round 1

Verdict: CHANGES REQUESTED

- P1-1 [blocking] `plan.md:56-63` (D2 accept test): creating a trip through the API already creates its conversation and owner participant (`src/modules/trips/trip-management.repository.ts:29-40`), so this fixture never exercises room creation in acceptance as the approved spec requires. After creating/publishing and requesting, delete the fixture's conversation (participants cascade), or create an equivalent valid trip fixture directly; assert zero conversations immediately before the concurrent accepts. Require at least one `200` in each round, since allowing two `409`s makes the success-state assertions vacuous. Then assert exactly one room, its owner participant and each successful requester's participant and active membership, plus the planned group-size count. Keep the stop-and-report rule for any `500`; no accept implementation change is authorized.
- P1-2 [suggestion] `plan.md:49-55,98-100` (fixture and timing details): briefly name the direct Trip fixture's required fields (`ownerId`, `communityId`, `originCity`, `startDate`, `endDate`, `durationDays`, `desiredGroupSize`, `description`, and `status: PUBLISHED` with `publishedAt`) and ConnectionRequest fields (`tripId`, `requesterId`, `recipientId`, `message`); use a date-consistent positive duration. State explicitly that each round is a separate test with its fixture work included in the 15 s body budget, and hooks use the configured 60 s limit. The planned totals are 63 users and 45 trips, rather than about 40 users and 40 trips; avoid relying on the unmeasured few-seconds estimate. Also compare the complete `data.user` across duplicate block responses and assert its expected target ID, matching the spec rather than comparing IDs alone.

Review evidence and conclusions:

- Read AGENTS.md first and confirmed branch `fix/duplicate-submission-audit`. Reviewed the approved spec, previous review rounds, plan, repository implementations, route configuration, auth rate-limit key, Prisma schema and relevant migration constraints, integration configuration and existing connection test patterns.
- The two proposed insert-or-ignore/read changes preserve their transaction clients, community lock, return types, original timestamps, `blockInclude`, and pending-request update. No schema migration or service/route change is needed.
- Rate-limit keys use verified token subjects (`auth.service.ts:161-174`), so unique token subjects isolate rounds. Four blocks per fresh blocker and one bootstrap per subject are within 30/hour and 20/minute. D2's reused requesters make five requests each, within both 10/hour at the route and 20/day in the repository. Follow and accept have no route override and use the global 100/minute limit; the planned users remain below it.
- Cleanup order is valid: deleting trips cascades target requests, memberships, conversations/participants, history and publication alerts before restricted user/community references are deleted. Notifications cascade on recipient deletion. Track fixtures immediately on creation so failed assertions still allow cleanup.
- The before-fix run and retained `duplicate-audit-before-fix.log` are appropriate; both race tests must demonstrate the intended 500 failure, not a fixture, rate-limit or timeout failure. Required docs and AGENTS.md check order/root log naming are covered; `npm ci` remains conditional on manifest/lock changes, and the database must be started first. Record changes from the plan after building. Treat any timeout as a failure and rerun the failed file alone once as AGENTS.md requires.
- The undo-race limitation and potential documentation merge conflict are appropriately scoped risks. No tests, probes, CI checks or database changes were run, as requested. One migration search used a Windows-incompatible glob path and was corrected to `rg` with `-g migration.sql`. Only this review file was edited; no commit, push or branch change was made.

Builder reply: P1-1 fixed in plan.md "Tests" item 3: the test deletes the
API-created room and checks none exists before the concurrent accepts, requires
at least one `200` per round, and checks exactly one room with the owner's
participant row plus each successful requester's membership and participant
row. The plan also notes that, because trips always get a room when created,
the accept clash only applies to trips without one. P1-2 fixed: trip and
request fixture fields named with consistent dates, each round is its own test
within the 15 s limit with shared setup in the 60 s hook, totals corrected to
63 users and 45 trips with no time estimate, and the block test compares the
complete `data.user` and checks its `id` is the target.

## Plan review, round 2

Verdict: APPROVED

No new findings.

- P1-1 resolved: D2 deletes the API-created conversation and asserts zero
  rooms before the burst, requires at least one `200`, and checks exactly one
  room, its owner participant, successful requesters' active memberships and
  participants, and the resulting group size. The stop-and-report rule for
  any `500` remains; no accept implementation change is planned.
- P1-2 resolved: direct fixture fields are named; start +30 days through end
  +34 days with `durationDays: 5` satisfies the inclusive date constraint.
  Each round includes fixtures within its 15 s test budget, shared hooks use
  60 s, totals are corrected to 63 users and 45 trips, and duplicate block
  responses compare complete `data.user` values and the expected target ID.

Read AGENTS.md first and confirmed branch `fix/duplicate-submission-audit`.
Reviewed the revised plan and Builder reply against the acceptance service,
repository, trip creation, Prisma schema and relevant migrations. Deleting
this fresh fixture's conversation is valid: its participants cascade, and
the trip, owner membership and pending requests remain intact. No messages or
reports are created by this fixture. Acceptance has no prerequisite that a
conversation already exist and recreates the room and owner participant in
its transaction. This is a deliberate test of the missing-room path; the
room migration also backfilled existing trips, so it does not establish that
legacy production trips currently lack rooms.

Only this review file was edited. No tests, probes, CI checks or database
changes were run, as requested; no commit, push or branch change was made.

## Code review, round 1

Verdict: APPROVED

- C1-1 [suggestion] `docs/backend-remaining-work.md:13-15` and `docs/roadmap.md:76`: qualify the claim that all other upserts already send one atomic insert. The unchanged conversation and participant upserts in `connection.repository.ts:137-151` still use empty updates; acceptance relies on SERIALIZABLE retries and clean conflict handling, as the approved spec explains. Say the other scalar update shapes are atomic and acceptance remains protected by its existing retry/conflict handling. Also describe the five passing missing-room accept rounds as observed evidence rather than the absolute claim "never returns 500". This does not block the implementation.

### Review evidence

- Read AGENTS.md first. Confirmed branch `fix/duplicate-submission-audit`, HEAD `3fd629a99480c8a9b31b129372665fce86d54655`, and initially clean tracked worktree. Reviewed `git diff 193cb24..3fd629a`, approved spec and plan, Changes from the plan, earlier review rounds, relevant transactions, constraints, rate-limit keys and test configuration. No branch change, commit or push.
- Both fixes use the existing transaction client for insert-or-ignore and the separate unique read. The follow shared community lock, original timestamps, blockInclude, pending-request update in both directions, and return types are preserved. Under READ COMMITTED the losing insert waits for the winner, and the following statement can read its committed row. The approved simultaneous undo limitation remains unchanged. No blocking code finding.
- Regression coverage matches the approved plan: 20 independent follow rounds and 20 independent block rounds, four concurrent requests each, fresh UUID subjects/users, absent rows before bursts, exactly one row afterwards, equal timestamps, complete duplicate block user comparisons and expected target ID, plus both pending requests becoming BLOCKED. The block fixtures contain the required published-trip/request fields and consistent inclusive duration. Fresh subjects isolate bootstrap/global/block limits; the reused accept users remain within request limits.
- Five accept rounds create fresh trips with capacity for both requesters; complete profiles include displayName. Each removes the API-created room and asserts zero rooms before acceptance, permits only 200/409 with at least one 200, then checks exactly one room, the owner participant, successful requesters' participants and ACTIVE memberships, and group size. Room uniqueness is also enforced by the schema. No accept implementation change.
- Fixture IDs are recorded as created; cleanup deletes trips before follows/blocks, community and users, respecting cascades and restricted references. Each round is a separate test with fixtures inside the configured 15 s body limit; shared hooks use 60 s. Unit hooks use 30 s. No timeout or isolated rerun occurred in this review.
- Read the Builder's retained `duplicate-audit-before-fix.log`: 39 failures / 6 passes, comprising 19 of 20 follow rounds and all 20 block rounds failing on status arrays containing 500, with all five accept rounds passing. This supports regression sensitivity to the original bug rather than fixture/rate-limit failures. I did not restore old code or rerun the before-fix experiment.
- README changes describe original follow/block timestamps; roadmap records item 28 PR #60 and this item's completion. Backend milestone is updated. C1-1 is the only documentation suggestion.

### Independent checks (in AGENTS.md order)

All complete npm command output is saved in the root logs below. Exit codes were captured from each native command, not inferred from PowerShell stderr rendering. Prisma's informational stderr is rendered as NativeCommandError records by Windows PowerShell in some logs; those commands exited 0.

| Check                          | Result                                                                                                                                  | Root log                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Database prerequisite          | `docker start travel-buddy-postgres` succeeded before checks; later inspect confirmed running (`true`)                                  | `review-duplicate-audit-database.log` (running-state confirmation) |
| `npm ci`                       | Not needed: neither package file changed in the reviewed diff                                                                           | No log (not run)                                                   |
| `npm run format:check`         | PASS, exit 0                                                                                                                            | `review-duplicate-audit-format-check.log`                          |
| `npm run lint`                 | PASS, exit 0                                                                                                                            | `review-duplicate-audit-lint.log`                                  |
| `npm run db:validate`          | PASS, exit 0                                                                                                                            | `review-duplicate-audit-db-validate.log`                           |
| `npm run db:migrate:deploy`    | PASS, exit 0; 40 migrations, none pending                                                                                               | `review-duplicate-audit-db-migrate-deploy.log`                     |
| `npm run typecheck`            | PASS, exit 0                                                                                                                            | `review-duplicate-audit-typecheck.log`                             |
| `npm test`                     | PASS, exit 0; 489 tests, 31 files; 91.62 s                                                                                              | `review-duplicate-audit-test.log`                                  |
| Pre-integration process check  | PASS; inspected node/npm/cmd command lines immediately before integration; no project Node process or dev server found; nothing stopped | `review-duplicate-audit-process-check.log`                         |
| `npm run test:integration`     | PASS, exit 0; 383 tests, 43 files; 487.54 s; no failures/timeouts                                                                       | `review-duplicate-audit-integration.log`                           |
| `npm run build`                | PASS, exit 0, including Prisma generation                                                                                               | `review-duplicate-audit-build.log`                                 |
| `npm audit --audit-level=high` | PASS at requested threshold, exit 0; 14 moderate severity vulnerabilities                                                               | `review-duplicate-audit-audit.log`                                 |

Integration output contains pg deprecation warnings about calling client.query while another query is executing; no check failed. No unrelated changes or dependency fixes were made. Only this review.md was edited among tracked files; requested ignored root logs and normal generated build/check outputs were produced.

Supplemental review-artifact checks: `npx prettier --write docs/work/duplicate-submission-audit/review.md` passed (exit 0), log `review-duplicate-audit-review-format.log`; `git diff --check` passed (exit 0), log `review-duplicate-audit-diff-check.log`. Final tracked status showed only this review file modified.

Builder reply: C1-1 fixed in `docs/roadmap.md` and
`docs/backend-remaining-work.md`: the atomic claim now names only push device,
profile, profile photo, mark-read and mute; acceptance is described as
read-first protected by serializable retries and `409` conflict handling, with
its test result given as observed in 5 rounds.
