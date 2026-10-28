# Item 39: Fix flaky tests

- **Roadmap:** item 39, group 4 (launch setup).
- **PRD sections:** none. This is test reliability only; no API, data or
  product behaviour changes.
- **Branch:** `fix/item-39-flaky-tests`.

## Problem

`docs/roadmap.md` and `AGENTS.md` ("Known flaky tests") record two failures
that appear on a busy machine and pass when re-run:

1. `test/rate-limit.test.ts` times out.
2. An integration file fails in `beforeAll` with "Hook timed out in 15000ms".

Agents currently work around both by re-running, which costs several minutes per
check and makes a real failure easy to dismiss.

### What I checked (2026-10-28, on `main` at `98a432f`, 4-core Windows machine)

| Run                                                                   | Result                                                                                    | Log                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| `vitest run test/rate-limit.test.ts`, first run of the session (cold) | **Failed:** first test timed out at the 5 s default; the other two passed; file took 40 s | (terminal only, not saved)        |
| Same file again (warm)                                                | Passed: 2036 ms, 841 ms, 598 ms                                                           | `rate-limit-alone.log`            |
| Same file with 4 CPU busy loops running                               | Passed: 2986 ms, 1049 ms, 1066 ms                                                         | `rate-limit-under-load.log`       |
| Full `npm test` (451 tests, files in parallel)                        | Passed; rate-limit first test **3301 ms** of its 5000 ms budget                           | `unit-item39-baseline.log`        |
| Full `npm run test:integration` (338 tests, idle machine)             | Passed in 338 s; slowest single test 6165 ms of 15000 ms                                  | `integration-item39-baseline.log` |
| 4 heavy integration files with 4 CPU busy loops                       | Passed (47 tests)                                                                         | `integration-under-load.log`      |

I reproduced the rate-limit timeout once (cold start). I did **not** reproduce
the integration hook timeout today; it is known only from earlier items' runs
recorded in `AGENTS.md`. The causes below come from reading the code and from
the timings above.

### Cause 1: `rate-limit.test.ts` starts the app inside the test

Each of the three tests calls `buildApp()` and lets the first `app.inject()`
start it. Startup (loading every route plugin, compiling every JSON schema,
Swagger) therefore counts against vitest's default 5 s **test** timeout. A
throwaway timing script (outside the repository) measured:

| Step                                   | Time          |
| -------------------------------------- | ------------- |
| Importing `src/app.ts`                 | 4113 ms       |
| First `buildApp()` + `ready()`         | 2861 ms       |
| Later `buildApp()` + `ready()`         | 539 to 759 ms |
| The 101 health requests the test makes | 49 to 119 ms  |

So nearly all of the test's time is app startup, not the behaviour under test.
`vitest.config.ts` sets no timeouts, so the 5 s default applies, and a cold or
loaded machine pushes the first test past it. `test/health.test.ts` avoids this
by starting its apps in `beforeAll`.

### Cause 2 (likely, not proven): integration `beforeAll` does heavy one-time work under 15 s

This is a hypothesis from reading the code: the hook timeout has not been
reproduced, and the setup-hook times have not been measured yet.

`vitest.integration.config.ts` sets `testTimeout` and `hookTimeout` to 15 s and
runs one file at a time, each in a fresh worker (vitest reports 42 workers,
about 400 ms startup each). In 41 of 42 files, `beforeAll` calls `app.ready()`
in a freshly loaded module graph (the same cold-start cost as above) and then
seeds data: users, communities and trips, often through sequential HTTP
requests and database writes (for example `test/trip-alerts.integration.ts`
creates 8 users and 2 communities, and `test/trip-room.integration.ts` signs up
4 users through the API). This work is CPU- and database-bound. On an idle
machine the whole suite passes, but this work slows down when the machine is
busy, and nothing records how close each hook gets to 15 s.

## Proposed behaviour

No change to the API, the database or production code. Changes are to tests,
test configuration and docs only.

1. **Rate-limit test: start the app outside the timed test body.** Each of the
   three tests moves into its own `describe` block with its own `beforeAll`
   (build the app and await `ready()`) and `afterAll` (close it). Each test
   still gets its own app (so each has its own fresh in-memory rate-limit store
   and the tests stay independent), but startup is no longer in the test.
   `beforeEach`/`afterEach` are deliberately not used: vitest counts them in
   the test's timeout and in its reported duration, while `beforeAll`/`afterAll`
   run under the separate hook timeout. The assertions stay the same: 100
   requests allowed, the 101st returns `429`, and the three key rules (per
   account, invalid token falls back to IP, trusted-proxy forwarded address).
2. **Unit test config: an explicit hook timeout.** Set `hookTimeout` in
   `vitest.config.ts` so app startup in hooks has clear headroom (recommended
   30 s, see decision D1). `testTimeout` stays at the 5 s default, so a slow
   test body is still caught.
3. **Integration config: more headroom for setup hooks only.** Raise
   `hookTimeout` from 15 s to 60 s in `vitest.integration.config.ts` (decision
   D2). `testTimeout` stays 15 s. Hooks do one-time startup and seeding whose
   time scales with machine load; the timeout's job there is to catch a hang
   (for example a lost database connection), and 60 s still does that. The CI
   job's 15-minute limit is unchanged.
4. **No automatic retries.** I am not adding vitest `retry`: it would also hide
   real, intermittent failures (races, ordering bugs), which this project has
   had before (PR #47).
5. **Docs.** Remove the "Known flaky tests" workaround from `AGENTS.md` and the
   pointer to it in `docs/ai-workflow.md`, replacing it with one sentence: a
   timeout failure is now treated like any other failure (re-run once to
   confirm, then investigate). In the `README.md` "Quality checks" section, add
   a short note on the timeouts: app startup and data setup run in
   `beforeAll` hooks with their own budget (30 s unit, 60 s integration), while
   each test body keeps 5 s (unit) or 15 s (integration). Mark item 39 in
   `docs/roadmap.md` and note it in `docs/backend-remaining-work.md`. See
   decision D3 about editing `AGENTS.md` in this item.

### Edge cases

- If startup in a hook is ever slower than the hook timeout, vitest reports a
  hook timeout naming the file, which is clearer than the current test timeout
  that looks like a rate-limit bug.
- `test/admin-metrics.test.ts` "limits polling to 30 requests per minute"
  (1212 ms) is the next slowest unit test. It is well inside 5 s, so I leave it
  alone and mention it only as a suggestion.

## Data

None. No migration, no schema change, no backfill.

## Privacy, safety and abuse

None affected. The rate-limit rules themselves (100 per minute, per account or
per IP) are not changed; only how the test is timed. The test must still fail
if the limit or the key rules break (acceptance criterion 3).

## Out of scope

- Making integration setup faster (for example seeding users with direct
  database writes instead of HTTP calls, or sharing one app across files). That
  touches all 42 files and is a larger, separate change.
- vitest `isolate: false` (vitest suggests it would save about 17 s). It would
  share module state across files and break the per-file
  `vi.mock('../src/config/env.js', ...)` pattern.
- Raising any `testTimeout`, and changing CI (`.github/workflows/ci.yml`).
- Changes to production code, including app startup time.

## Acceptance criteria

1. [ ] No test body in `test/rate-limit.test.ts` calls `buildApp()` or waits for
       app startup. Each test sits in its own `describe` block whose
       `beforeAll` builds and starts a new app and whose `afterAll` closes it;
       the file has no `beforeEach` or `afterEach`.
2. [ ] The three rate-limit tests keep their current assertions (100 allowed,
       101st is `429`, plus each test's follow-up checks).
3. [ ] The rate-limit test still catches a real break. The **Builder**
       temporarily changes the global `max` in `src/app.ts` from 100 to 101,
       runs `test/rate-limit.test.ts` and saves the failing output to a
       `*.log` file, then restores the file and shows that `git diff main --
 src/` is empty. The Reviewer checks that log and the empty diff, and
       runs the restored tests, without editing production code.
4. [ ] Observation, not a guarantee: in the verbose output of a full `npm test`
       on an idle machine, each rate-limit test reports under 1000 ms (today:
       3301, 1317 and 973 ms, which include startup). The Builder records the
       numbers; a figure above 1000 ms is reported and explained, not hidden.
5. [ ] `vitest.config.ts` sets `hookTimeout` (D1); `testTimeout` is not set,
       so the 5 s default remains.
6. [ ] `vitest.integration.config.ts` has `hookTimeout: 60_000` (D2) and still
       `testTimeout: 15_000` and `fileParallelism: false`.
7. [ ] No `retry` option is added anywhere.
8. [ ] No files under `src/`, `prisma/` or `.github/` change.
9. [ ] All checks in `AGENTS.md` pass. `npm test` passes 3 runs in a row and
       `npm run test:integration` passes 2 runs in a row, each with full output
       saved to a `*.log` file.
10. [ ] A repeatable load run after the change. Load recipe: one Node.js busy
        loop per logical CPU core (4 on the owner's machine), started just
        before the run and kept running until it ends. Under that load, a full
        `npm test` and a full `npm run test:integration` both pass, with full
        output saved to `*.log` files. The setup-hook times of the integration
        files are recorded too; the plan names how they are measured (vitest
        does not report hook durations) and shows the method on `main` first.
        Honest limit: the same load did not make `main` fail today, so this run
        shows the change causes no regression and records how much headroom
        the hooks have; it does not prove the original integration failure is
        gone.
11. [ ] `README.md`, `AGENTS.md`, `docs/ai-workflow.md`, `docs/roadmap.md` and
        `docs/backend-remaining-work.md` are updated as described in
        "Proposed behaviour" step 5.

## Decisions for the owner

- **D1. Unit `hookTimeout`.** Recommended: **30 s** (the slowest measured cold
  start was about 4 s import plus 3 s startup). Alternative: leave the 10 s
  default.
- **D2. Integration `hookTimeout`.** Recommended: **60 s**, enough headroom for a
  busy machine while still catching a hang. Alternative: 30 s (less headroom) or
  speeding up the hooks instead (larger change, out of scope above).
- **D3. Editing `AGENTS.md` in this item.** `docs/ai-workflow.md` says rule
  changes to `AGENTS.md` go in their own small pull request. The "Known flaky
  tests" paragraph is a project fact that this item makes untrue, not a working
  rule, so I recommend **updating it in this item**. Alternative: leave it now
  and change it in a separate pull request after this one merges.
- **D4. No retries.** Recommended: **no vitest `retry`**, for the reason in
  step 4. Alternative: `retry: 1` for integration tests only (hides real
  failures; not recommended).
