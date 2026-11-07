# Fix: server-startup test deadline

- **Roadmap:** found later (not in the original 39). It came up as code
  review finding C2-1 on admin user search, and the owner chose a separate
  `fix/` item.
- **PRD sections:** none. This changes test reliability only; API, data and
  product behaviour do not change.
- **Branch:** `fix/server-startup-deadline`, from `main` at `0ecb999`.

## Problem

`test/server-startup.test.ts` (item 28, PR #60) starts the real entry point,
`node --import tsx src/server.ts`, in six child processes at once, all from
one `beforeAll`. Each child gets broken hosted Firebase credentials and must
exit with code 1 and a fixed message. A child still running after
`childDeadline` (45 s) is killed and fails `expect(timedOut).toBe(false)`.
The hook itself has 60 s.

During the admin-user-search review, the full `npm test` failed three times
with the same five cases at the 45 s deadline:

- the Builder's first run (no saved log of the failure);
- the Reviewer's round 2 run, file time 45.48 s (`reviewer-r2-unit.log`);
- the Reviewer's full rerun, file time 45.73 s
  (`reviewer-r2-unit-full-rerun.log`).

The file passed when run alone each time. The sixth case (oversized secret)
passed every time.

### What I checked (2026-11-07, on `main` at `0ecb999`, 4-core Windows machine, nothing else running)

Standalone runs of the test's child command, with the test's environment and
an invalid-JSON secret. Each line records the exit code, duration and logged
message (`startup-measurements.log`). The tsx cache directory was deleted
before the cold run.

| Run                                       | Result                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| One child, cold tsx cache                 | Exit 1, "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.", **15.8 s** |
| Same, warm (twice)                        | Exit 1, same message, 7.5 s and 7.9 s                                  |
| `node --import tsx -e 1` (tsx alone)      | Exit 0, 0.9 s                                                          |
| Built `dist/server.js`, same secret       | Exit 1, same message, 3.8 s                                            |
| Six warm children at once, outside Vitest | All exit 1 with the same message, 24.7 to 25.5 s each                  |

An earlier unsaved run of the same commands gave similar times (21.1 s cold,
8.4 s warm, 26.1 s for six at once).

Inside Vitest: I ran the full `npm test` twice with a temporary 300 s deadline
and a line per child recording its duration and exit code. Both runs passed
(31 files, 489 tests), and the six children took 19.3 to 34.9 s, all with exit
code 1 (`startup-durations-probe.log`, `unit-probe-1.log`, `unit-probe-2.log`).
The timing lines carry no case labels; the passing assertions in the unit
logs show each case's message was right. The temporary change was reverted.
Neither run reproduced the failure, so whether `main` itself fails is not
shown.

### Cause (hypothesis, not proven)

In every successful run measured, a child takes about 8 s alone and 25 to
35 s when six start together, close to the 45 s deadline. The five failing
cases fail in `checkFirebaseCredentials()`, which runs only after
`server.ts` has statically imported and built the application. The oversized
case is rejected by `env.ts` before that, and it passed every time. A warm
tsx start (7.5 s) is about twice the built start (3.8 s), so tsx loading and
transforming accounts for part of the cost but not all of it. This was not
profiled further (no phase timings, CPU or memory traces).

The plausible explanation is resource contention during startup: six of these
starts share 4 cores with the other Vitest workers. Other load in the
Reviewer's environment would then push them past 45 s; the Reviewer's
snapshot recorded about 946 MiB of free memory. The failed runs killed their
children, so whether those children would have finished, and why they were
slower, is unresolved. The fix below gives headroom for slow starts; it does
not depend on the cause being exactly this.

## Proposed behaviour

Test-only change in `test/server-startup.test.ts`:

1. Raise `childDeadline` from 45 s to **120 s**: about 3.4 times the slowest
   child seen in a full run. A child still running at the deadline is killed
   and fails the same assertion, only later.
2. Set the `beforeAll` timeout to `childDeadline + 30_000` (150 s) instead of
   a fixed 60 s. The hook waits for children that may each take up to the
   deadline, and the extra 30 s is headroom for spawning and killing them.
   In the normal case a slow child then reports the clear `timedOut` assertion
   rather than a generic hook timeout (not guaranteed if killing a child
   itself stalls; the hook timeout still fails the run then).
3. Update the comment next to the hook with the measured times.

Unchanged: the six children still start together, every assertion stays,
nothing is retried, and the other files' timeouts are not touched.

### Alternatives considered

- **Fewer children at once** (a pool of 2 or 3): less contention, but the file
  passing still depends on a fixed deadline, and whether it is faster or
  slower overall was not measured. Declined.
- **Start `dist/server.js`** (3.8 s): needs `npm run build` before `npm test`,
  which CI does not do. Declined.
- **Check credentials before importing the app** in `src/server.ts`
  (dynamic import): this would make real deploys fail faster too, but it
  changes production startup order. Out of scope; listed as a suggestion.

## Data

None. No migration.

## Privacy, safety and abuse

None. The secret-leak assertions are unchanged.

## Out of scope

- `src/server.ts` and other production code.
- The unexplained notifications worker crash seen once in admin search
  review round 1 (C1-1).
- Timeouts in other test files.

## Acceptance criteria

- [ ] Only `test/server-startup.test.ts` and docs change.
- [ ] `childDeadline` is 120 s, and the hook timeout is derived from it as
      `childDeadline + 30_000`.
- [ ] All six cases and their assertions are unchanged (`timedOut` false, exit
      code 1, messages, no `Server listening`, no secret in output).
- [ ] The file passes alone.
- [ ] Full `npm test` passes, and all other checks in AGENTS.md pass.
- [ ] Forced-deadline check of the kill path: as a temporary local change,
      setting `childDeadline` to 1 ms makes all six cases fail
      on the `timedOut` assertion. This tests the timer and kill path, not a
      real hang. The value is restored before the final checks.
- [ ] Docs: `docs/roadmap.md` "Found later" row and
      `docs/backend-remaining-work.md` (current milestone and Already
      implemented). `README.md` does not mention this test or its timeouts,
      so it needs no change.

## Decisions for the owner

- **D1. Deadline value.** Recommended: 120 s. Lower values, such as 90 s, give
  less headroom; higher values only make a real hang slower to report.
