# Item 39 plan: Fix flaky tests

Follows the approved `spec.md` with the owner's decisions: D1 unit
`hookTimeout` 30 s, D2 integration `hookTimeout` 60 s, D3 update `AGENTS.md`
in this item, D4 no retries.

## Measuring setup-hook times (spec criterion 10)

Vitest does not print hook durations, but vitest 5.0.5 reporters receive
`onHookStart` and `onHookEnd` events for `beforeAll`/`afterAll`. A throwaway
reporter, kept **outside the repository** (`%TEMP%\item39-tools\`) and never
committed, records the time between the two events per file and suite into a
tab-separated `*.log` file.

These are **coarse estimates of when the events arrived**, not exact hook
durations, and there is no fixed error bound. The worker sends no timestamps;
it batches events (100 ms throttle) and the main process replays them to
reporters, so main-process scheduling, especially under CPU load, can stretch
or shrink a measured interval (some `afterAll` hooks show 0 ms). The figures
are good enough for the broad comparison this item needs (a hook at about 9 s
against a 15 s or 60 s limit, before and after the change). They are not good
enough to say how close a single hook came to a limit; that would need
timestamps taken inside the worker, which this item does not add.

```js
// Throwaway measurement tool for item 39; not part of the repository.
import { appendFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const output = process.env.HOOK_TIMING_FILE ?? 'hook-timings.log';
const started = new Map();

function label(hook) {
  const entity = hook.entity;
  const file = relative(
    process.cwd(),
    entity.module?.moduleId ?? entity.moduleId ?? '',
  );
  const suite =
    entity.type === 'module' ? '(file)' : (entity.fullName ?? entity.name);
  return `${file}\t${suite}\t${hook.name}`;
}

export default class HookTimingReporter {
  onInit() {
    writeFileSync(output, 'ms\tfile\tsuite\thook\n');
  }
  onHookStart(hook) {
    if (hook.name === 'beforeAll' || hook.name === 'afterAll')
      started.set(label(hook), performance.now());
  }
  onHookEnd(hook) {
    const key = label(hook);
    const start = started.get(key);
    if (start === undefined) return;
    started.delete(key);
    appendFileSync(
      output,
      `${Math.round(performance.now() - start)}\t${key}\n`,
    );
  }
}
```

Run it alongside the normal reporter (Git Bash; in PowerShell set `$env:HOOK_TIMING_FILE` first and use `$env:TEMP`):

```sh
HOOK_TIMING_FILE=hook-timings-<name>.log npx vitest run \
  --config vitest.integration.config.ts --reporter=verbose \
  --reporter="$TEMP/item39-tools/hook-timing-reporter.mjs" > integration-<name>.log 2>&1
```

### Shown on `main` first (done while planning, 2026-10-28)

On `main` (`98a432f`, only the untracked `docs/work/` added), idle machine:
42 files and 338 tests passed in 567 s (`integration-main-idle-hooks.log`,
timings in `hook-timings-main-idle.log`). 43 `beforeAll` hooks, mean 3.2 s,
15 of them over 3 s. Slowest:

| File                                   | `beforeAll` | Share of 15 s |
| -------------------------------------- | ----------- | ------------- |
| `test/expenses.integration.ts`         | 9168 ms     | 61%           |
| `test/trip-memberships.integration.ts` | 8390 ms     | 56%           |
| `test/policy-gate.integration.ts`      | 6827 ms     | 46%           |
| `test/trip-room.integration.ts`        | 6754 ms     | 45%           |
| `test/policies.integration.ts`         | 6397 ms     | 43%           |
| `test/auth-freshness.integration.ts`   | 6369 ms     | 42%           |

The same suite took 338 s earlier the same day, so machine speed alone varied
by about 1.7 times between two idle runs. At that spread the slowest hook
(9.2 s) would pass 15 s. This supports cause 2 in the spec, but it is still not
a reproduced failure.

## Load recipe (spec criterion 10)

One Node.js busy loop per logical core (4 here). Each suite run gets its **own
fresh set** of loops, started just before the run. Each loop lives 60 minutes,
far longer than one suite (about 6 to 10 minutes), and the script checks that
every loop is still running when the suite ends, so the load covered the whole
run. Cleanup stops only those processes, by their IDs, even if the suite fails.
PowerShell, as used in this checkout:

```powershell
$load = @()
try {
  # Started inside try, so loops already running are stopped if a later start fails.
  foreach ($core in 1..[Environment]::ProcessorCount) {
    $load += Start-Process node -PassThru -WindowStyle Hidden -ErrorAction Stop `
      -ArgumentList '-e', '"const e=Date.now()+3600000; while(Date.now()<e){}"'
  }
  # ... run one suite here, output redirected to its *.log file ...
} finally {
  $alive = @($load | Where-Object { -not $_.HasExited }).Count
  "Load loops still running at the end: $alive of $($load.Count)"
  $load | Where-Object { -not $_.HasExited } | Stop-Process -Force
}
```

The "still running" line goes into the run's notes in "Changes from the plan".
A run where any loop had already stopped does not count as a load run and is
repeated.

## Build steps

1. **Baseline under load on `main` (before any edit).** Run the integration
   suite with the timing reporter under the load recipe:
   `integration-main-load-hooks.log` and `hook-timings-main-load.log`. This
   gives the before figure for the same load, so the post-change run can be
   compared like for like. If `main` fails here, that is the first reproduced
   integration hook timeout, and I record it.
2. **`test/rate-limit.test.ts`.** Add a small helper next to `createApp` that,
   for the current `describe` block, registers a `beforeAll` that **builds**
   the app and awaits `ready()`, and an `afterAll` that closes it if it was
   built. The helper returns a getter, so each block has its own app reference.
   If `beforeAll` fails, vitest reports that hook failure, skips the block's
   test and still runs `afterAll`. The getter only guards against using the app
   before it was built (for example a future test placed wrongly). Wrap each of the
   three tests in its own `describe` block that calls the helper. The test
   bodies lose their `try`/`finally` and `app.close()` but keep every request
   and assertion unchanged, including the `exhaust` helper. Sketch:

   ```ts
   type App = ReturnType<typeof createApp>;

   // Startup runs under the hook timeout, not the test's 5 s budget.
   function startApp(trustProxy?: (address: string, hop: number) => boolean) {
     let app: App | undefined;
     beforeAll(async () => {
       app = createApp(trustProxy);
       await app.ready();
     });
     afterAll(async () => {
       await app?.close();
     });
     return () => {
       if (!app) throw new Error('The test app did not start.');
       return app;
     };
   }

   describe('rate limiting', () => {
     describe('accounts sharing an IP address', () => {
       const app = startApp();
       it('keeps separate limits for accounts that share one IP address', async () => {
         await exhaust(app(), { authorization: 'Bearer alice-token' });
         // ... same follow-up requests and assertions, using app()
       });
     });
     // ... two more blocks, the last with startApp((_address, hop) => hop < 1)
   });
   ```

   Nothing calls `buildApp()` while vitest collects the file. If `ready()`
   fails after the app was built, `afterAll` still closes it. No
   `beforeEach`/`afterEach` in the file. Test names stay the same; only the
   enclosing `describe` names are new.

3. **`vitest.config.ts`.** Add `hookTimeout: 30_000` with a one-line comment
   (app startup in `beforeAll` can take several seconds on a cold or busy
   machine). No `testTimeout`.
4. **`vitest.integration.config.ts`.** Change `hookTimeout` from `15_000` to
   `60_000` with a one-line comment (setup hooks start the app and seed data,
   which slows down on a busy machine; the limit is there to catch a hang).
   `testTimeout: 15_000` and `fileParallelism: false` unchanged. No `retry`.
5. **Mutation check (spec criterion 3).** Change `max: 100` to `max: 101` in
   `src/app.ts`, run `npx vitest run test/rate-limit.test.ts --reporter=verbose`
   into `rate-limit-mutation.log` (expected: all three tests fail, because the
   101st request now returns 200), restore the file, and save
   `git diff main -- src/` (expected empty) at the end of that log.
6. **Docs.**
   - `README.md` "Quality checks": after the paragraph on integration tests,
     add two or three sentences: app startup and data setup run in `beforeAll`
     hooks with their own limit (30 s unit, 60 s integration), and each test
     body keeps 5 s (unit) or 15 s (integration), so a slow test is still
     caught.
   - `AGENTS.md`: replace the "Known flaky tests on a busy machine" paragraph
     with: a timeout is a failure like any other; re-run the failed file once
     to confirm, then investigate and report both results. Keep the rest of
     "Checks" unchanged.
   - `docs/ai-workflow.md` "When things go wrong": change the "A test fails
     once and then passes" bullet so it no longer points to "Known flaky
     tests" and says to ask the Builder to investigate.
   - `docs/roadmap.md`: item 39 status `Done` with a short note (startup moved
     out of rate-limit test bodies; setup-hook limits 30 s and 60 s). The PR
     number is added after merge, as the roadmap allows. Update "Status
     recorded" to the build date.
   - `docs/backend-remaining-work.md`: move the rounding-disclosure entry from
     "Current milestone" to the top of "Already implemented", and make item 39
     the current milestone (what changed, that no production code changed, and
     that the integration cause is likely but not reproduced). Update "Status
     recorded".
7. **Checks.** All checks from `AGENTS.md` in order (`npm ci` is not needed:
   no package changes), on an idle machine (no load loops). The unit and
   integration runs must pass **consecutively**: a failure resets the count,
   and I report it with its log rather than dropping it.
   - Unit: three back-to-back `npm test -- --reporter=verbose` runs into
     `unit-item39-run1.log` to `run3.log`. Verbose output shows each test's
     duration. The three rate-limit test durations from every run go into a
     table in "Changes from the plan", with an explanation for any over
     1000 ms (spec criterion 4).
   - Integration: two back-to-back full runs with the timing reporter into
     `integration-item39-run1.log` and `run2.log` (hook times in
     `hook-timings-item39-run1.log` and `run2.log`).
8. **Load runs after the change.** Under the load recipe, each with its own
   fresh set of loops: full `npm test -- --reporter=verbose`
   (`unit-item39-load.log`) and the full integration suite with the timing
   reporter (`integration-item39-load.log`, `hook-timings-item39-load.log`).
   Compare with step 1 in "Changes from the plan", treating the hook times as
   the coarse estimates described above.
9. **Commit** once, locally:
   `fix(tests): move app startup out of timed tests and widen setup-hook limits`.
   Includes `docs/work/item-39-flaky-tests/`. No push.

## Files

| File                                 | Change                                           |
| ------------------------------------ | ------------------------------------------------ |
| `test/rate-limit.test.ts`            | One `describe` + `beforeAll`/`afterAll` per test |
| `vitest.config.ts`                   | `hookTimeout: 30_000`                            |
| `vitest.integration.config.ts`       | `hookTimeout` 15 000 to 60 000                   |
| `README.md`                          | Timeout note in "Quality checks"                 |
| `AGENTS.md`                          | Replace "Known flaky tests" paragraph            |
| `docs/ai-workflow.md`                | Update the "fails once" bullet                   |
| `docs/roadmap.md`                    | Item 39 status                                   |
| `docs/backend-remaining-work.md`     | Current milestone                                |
| `docs/work/item-39-flaky-tests/*.md` | Spec, plan, review                               |

No new helpers outside the test file. No migration. No changes under `src/`,
`prisma/` or `.github/`.

## Tests

- No new test files. `test/rate-limit.test.ts` is restructured, with the same
  three tests and the same assertions.
- The mutation check (step 5) shows the restructured test still catches a
  broken limit.
- Rate limits and isolation: each rate-limit test keeps its own app and its own
  in-memory store, so no test can use up another's limit. Integration tests
  are untouched, so their per-user and per-trip isolation is unchanged.

## Risks

- **A real hang in an integration setup hook now takes up to 60 s to report**
  instead of 15 s. The CI job's 15-minute limit covers installing, every check
  and the full suites, so even one extra 45 s delay could push a slow CI run
  past it. Either way the run fails, so a hang is still caught; it may show as
  a job timeout rather than a named hook timeout. CI is not changed in this
  item (spec "Out of scope").
- **The integration fix is headroom, not a proven cure.** If a setup hook keeps
  growing (more seeding per file), it can still reach 60 s. The timing
  reporter recipe in this plan lets a later item measure that again.
- **App built in `beforeAll`** in the rate-limit file: if building or startup
  ever fails, vitest reports that block's `beforeAll` failure and skips its
  test, rather than showing a test timeout that looks like a rate-limit bug.
- **Test full names change** (new `describe` level). Nothing in the repository
  or CI filters tests by name.
- No breaking changes for API clients.

## Changes from the plan

Built 2026-10-28. The code and docs follow the plan. Differences and results:

- **Step order.** While the step 1 baseline was running, I edited
  `test/rate-limit.test.ts` and the docs, which the integration suite does not
  load. I changed the vitest configs only after the baseline finished, so the
  baseline ran with `main`'s config.
- **An integration run failed, caused by a running dev server.** The first
  post-change integration run (`integration-item39-failed-devserver.log`,
  `hook-timings-item39-failed-devserver.log`) had two failures:
  `test/account-deletion.integration.ts` `beforeAll` "Hook timed out in
  60000ms" (normally about 2.6 s), and `test/trip-alerts.integration.ts`
  "alerts for only the first five trips an account publishes in a day"
  (4 notifications instead of 5). Both files passed when run alone
  (`integration-item39-rerun-alone.log`, 45 tests). The cause I found: an
  `npm run dev` server (started 14:08, not by an agent in this item) was
  running from this checkout. It uses the same `travel_buddy` database as the
  integration tests and runs the account-erasure, trip-alert, push and email
  workers. `tsx watch` had restarted it at 15:02 after my temporary
  `src/app.ts` edit in step 5. Its trip-alert worker can process the test's
  alert jobs, which fits "4 instead of 5". The account-deletion hang is
  probably the same interference, but that is not proven. With the owner's OK I
  stopped the dev server and confirmed no other database sessions remained,
  then restarted the consecutive count. The 60 s limit could not have helped
  with this failure, and the 15 s limit would have failed it too.
- **Load did not slow the suite much.** On `main` under load the suite took
  445 s with the slowest hook at 5.7 s, while an idle `main` run earlier took
  567 s with the slowest hook at 9.2 s. The busy loops run at normal priority,
  so machine-wide variation (other apps, disk, the dev server) mattered more
  than this recipe.

### Results

| Run                                    | Result                    | Slowest `beforeAll` (coarse)     | Logs                                                            |
| -------------------------------------- | ------------------------- | -------------------------------- | --------------------------------------------------------------- |
| `main`, idle (planning)                | 338 passed, 567 s         | 9168 ms, `expenses`              | `integration-main-idle-hooks.log`, `hook-timings-main-idle.log` |
| `main`, under load (step 1), 4 of 4    | 338 passed, 445 s         | 5658 ms, `trip-room`             | `integration-main-load-hooks.log`, `hook-timings-main-load.log` |
| Branch, dev server running (discarded) | 2 files failed, see above | 60 s timeout (hang)              | `integration-item39-failed-devserver.log`                       |
| Branch, run 1                          | 338 passed, 316 s         | 3613 ms, `trip-integrity`        | `integration-item39-run1.log`, `hook-timings-item39-run1.log`   |
| Branch, run 2                          | 338 passed, 341 s         | 11735 ms, `feature-restrictions` | `integration-item39-run2.log`, `hook-timings-item39-run2.log`   |
| Branch, under load, 4 of 4             | 338 passed, 479 s         | 4995 ms, `public-text`           | `integration-item39-load.log`, `hook-timings-item39-load.log`   |

The `feature-restrictions` hook in run 2 (11.7 s; 1.3 s in other runs) is the
kind of one-off spike that would have used 78% of the old 15 s limit.

Rate-limit test durations from verbose `npm test` (spec criterion 4; all three
used to include app startup, today 3301, 1317 and 973 ms):

| Run                    | Accounts sharing an address | Invalid tokens | Trusted proxy | Suite      |
| ---------------------- | --------------------------- | -------------- | ------------- | ---------- |
| `unit-item39-run1.log` | 219 ms                      | 128 ms         | 163 ms        | 451 passed |
| `unit-item39-run2.log` | 198 ms                      | 202 ms         | 93 ms         | 451 passed |
| `unit-item39-run3.log` | 349 ms                      | 164 ms         | 111 ms        | 451 passed |
| `unit-item39-load.log` | 529 ms                      | 382 ms         | 380 ms        | 451 passed |

All under 1000 ms. The load run had 4 of 4 loops running at the end.

Other checks: `format:check`, `lint`, `db:validate`, `db:migrate:deploy` and
`typecheck` all exit 0 (`checks-item39-static.log`); `build` exit 0 and
`npm audit --audit-level=high` found 0 vulnerabilities
(`checks-item39-build-audit.log`). `npm ci` was not needed. Mutation check
(step 5): with `max: 101` all three rate-limit tests failed with "expected 200
to be 429"; after the restore `git diff main -- src/` was empty
(`rate-limit-mutation.log`).

Suggestion for a later item, not changed here: the integration tests use the
same database as `npm run dev`, so a running dev server's workers can break
them. A separate test database (or a rule in `AGENTS.md` "Checks" to stop the
dev server first) would prevent this.
