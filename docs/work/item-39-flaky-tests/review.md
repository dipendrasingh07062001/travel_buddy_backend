## Spec review, round 1

Verdict: CHANGES REQUESTED

- S1-1 [blocking] Acceptance criterion 3 assigns the Reviewer a temporary edit to `src/app.ts`, but `AGENTS.md` Roles permits the Reviewer to edit only this item's `review.md`. The mutation check is useful, but the specified verification cannot be performed under the repository rules. Assign the temporary mutation, failing test run, restoration and clean-diff evidence to the Builder; the Reviewer can inspect that evidence and run the restored tests without editing production code.
- S1-2 [blocking] Acceptance criterion 4 and Proposed behaviour 1 conflate the timed test body with Vitest's verbose test duration. In the installed Vitest runner (`node_modules/vitest/dist/chunks/run.BPv-BBRv.js`, lines 3871-3989), the reported duration includes `beforeEach` and `afterEach`. Moving startup into a per-test hook fixes the timeout budget but does not remove startup from that reported duration, so a valid implementation can still fail the under-1000-ms criterion. Specify a measurement that actually excludes setup/cleanup, or explicitly require separate `beforeAll` scopes with one fresh app per test. Treat the absolute timing target as an observation under stated load rather than an unconditional reliability guarantee.
- S1-3 [suggestion] Acceptance criterion 9 requires repeated passes but no post-change run under the busy-machine conditions that motivate the item. The cited integration load run already passes before any change, and the integration hook timeout was not reproduced. Add a bounded, repeatable post-change load run with the load recipe and setup-hook timings recorded; keep the integration cause described as a hypothesis unless evidence establishes it. Passing idle runs alone cannot establish that the busy-machine failure is fixed.
- S1-4 [suggestion] Proposed behaviour 5 and acceptance criterion 10 omit the relevant `README.md` testing section (around lines 1377-1385), although `AGENTS.md` requires a relevant README update for every item. Include a short explanation of setup-hook budgets and unchanged test-body budgets there, or explicitly justify why no README change is needed.

Review evidence: read `AGENTS.md`, the spec, both Vitest configs, `test/rate-limit.test.ts`, `test/health.test.ts`, `src/app.ts`, integration hook locations and representative setup in `test/trip-alerts.integration.ts` and `test/trip-room.integration.ts`, `docs/ai-workflow.md`, `docs/roadmap.md`, `docs/backend-remaining-work.md`, the README testing section, CI configuration and the installed Vitest runner. Read all five cited saved logs; their pass counts and cited test timings agree with the spec. The initial cold failure and throwaway timing script have no saved evidence and were not independently reproduced. No PRD section applies to this test-only item, as specified by the owner. No tests or full CI checks were rerun for this spec review; the saved logs are Builder evidence, not Reviewer test results. Only `review.md` was edited.

Builder reply:

- S1-1 accepted. Acceptance criterion 3 now gives the temporary mutation
  (`max` 100 to 101), the saved failing log, the restore and the empty
  `git diff main -- src/` to the Builder. The Reviewer only checks that evidence
  and runs the restored tests.
- S1-2 accepted. "Proposed behaviour" step 1 and criterion 1 now require one
  `describe` block per test, each with its own `beforeAll`/`afterAll` (one fresh
  app per test) and no `beforeEach`/`afterEach`, so startup is outside both the
  test timeout and the reported duration. Criterion 4 is now an observation on
  an idle machine, recorded and explained if above 1000 ms, not a guarantee.
- S1-3 accepted. New criterion 10 adds a post-change run under a stated load
  recipe (one Node.js busy loop per logical core for the whole run) for both
  suites, with setup-hook times recorded; the plan must name the measuring
  method and show it on `main` first. Cause 2 is now headed "likely, not proven"
  and the spec says plainly that the load run shows no regression and the
  headroom, not that the original failure is gone.
- S1-4 accepted. Step 5 and criterion 11 now include a short note in the
  `README.md` "Quality checks" section on hook budgets versus test-body budgets.

## Spec review, round 2

Verdict: APPROVED

No new findings. All four round-1 findings are resolved in the revised spec:

- S1-1: Acceptance criterion 3 assigns the temporary `src/app.ts` mutation, failing log, restoration and empty production diff to the Builder. The Reviewer only inspects the evidence and runs restored tests, consistent with `AGENTS.md` Roles. The current global rate-limit setting is `max: 100` in `src/app.ts`.
- S1-2: Proposed behaviour 1 and acceptance criterion 1 require a separate `describe` scope with `beforeAll`/`afterAll` and a fresh app for each test. This preserves the three existing tests' isolated rate-limit stores and follow-up assertions while excluding startup and cleanup from their reported test durations. The installed Vitest runner executes these suite hooks outside individual test execution. Criterion 4 now explicitly treats the timing target as an idle-machine observation and requires reporting and explaining any excess.
- S1-3: Acceptance criterion 10 adds full post-change unit and integration runs under a stated CPU-load recipe, saved output and integration setup-hook measurements. The measurement method and baseline demonstration are explicitly deferred to the plan. The integration cause remains a hypothesis, and the spec correctly limits what passing load runs establish.
- S1-4: Proposed behaviour 5 and acceptance criterion 11 include the existing README "Quality checks" section, with the intended hook budgets and unchanged test-body budgets. Both configs currently match the baseline described in the spec: no explicit unit timeouts, and integration `testTimeout: 15_000`, `hookTimeout: 15_000`, `fileParallelism: false`.

Review evidence: read `AGENTS.md`, the updated spec and Builder replies, `test/rate-limit.test.ts`, both Vitest configs and README "Quality checks". Also checked `src/app.ts`, `test/health.test.ts`, the installed Vitest runner's test-duration and suite-hook execution, and the relevant `docs/ai-workflow.md` guidance. No new blocking issue or suggestion was identified. Owner decisions D1-D4 remain for the spec approval gate; this verdict does not approve implementation or resolve those decisions. No PRD section applies. No tests or full CI checks were run for this spec-only review. Only this item's `review.md` was edited; no commit or branch change was made.

## Plan review, round 1

Verdict: CHANGES REQUESTED

- P1-1 [blocking] `plan.md` Build step 2 and its helper sketch construct the app during collection (`const app = createApp(...)`), whereas approved spec acceptance criterion 1 requires each scope's `beforeAll` to build and start its app. The plan explicitly acknowledges this deviation but does not identify it as a change to the approved requirement. Move construction into `beforeAll` as well as `ready()`, keep a separately scoped app reference per test, and close that app in `afterAll` with appropriate handling if construction fails. The collection-time precedent in `test/health.test.ts` does not override this item's approved criterion.
- P1-2 [suggestion] `plan.md` Build step 7 names three unit logs and two integration logs but should explicitly require consecutive passes and a verbose full idle unit run, recording all three rate-limit durations and explaining any over 1000 ms (spec criteria 4 and 9). Plain `npm test` does not reliably display every fast test's individual duration. Use `npm test -- --reporter=verbose` for at least one full idle run and name where those observations will be recorded.
- P1-3 [suggestion] `plan.md` "Measuring setup-hook times" correctly calls the reporter approximate, but "within a few hundred ms" is not an established error bound, especially under CPU saturation. Installed Vitest batches worker events with a 100 ms throttle and sends no worker timestamps (`run.BPv-BBRv.js:3780-3828`); the main process replays those events into reporters (`cli-api.De07GUeT.js:11852-11867`). Main-process scheduling and event batching can compress or stretch the measured interval (the supplied log includes 0 ms cleanup intervals). Describe the results as coarse event-arrival estimates without a fixed bound, not precise hook durations; use worker-side timestamps if conclusions depend on proximity to a timeout. This method is useful for the current broad headroom comparison, but a passing baseline alone does not calibrate its accuracy.
- P1-4 [suggestion] `plan.md` "Load recipe" gives each busy loop a fixed 25-minute lifetime, whereas criterion 10 requires load throughout each run. Ensure a separate set of workers covers each full suite, verify none expired before completion, and stop only those worker processes in cleanup even if the test command fails. The Bash example also needs an explicit shell or a PowerShell equivalent for this checkout. In "Risks", remove the claim that 43 hooks cannot exceed the 15-minute CI limit unless several hang: total CI time includes installation, imports, tests and other checks, so even one additional delay can cross the remaining budget.

Coverage and code review: decisions D1-D4 are reflected correctly. Apart from P1-1, the proposed restructuring preserves the current three scenarios, `exhaust` assertions and independent in-memory stores; `test/health.test.ts` confirms the existing suite-hook pattern. The mutation targets the actual global `max: 100` in `src/app.ts`, belongs to the Builder, and includes restoration evidence. Config changes retain unit test-body defaults, integration `testTimeout: 15_000` and `fileParallelism: false`, and no retries. The files list, no-migration conclusion, production-change exclusion and five documentation updates match the codebase and approved scope. Moving the previous milestone to "Already implemented" matches the current engineering checklist. No new production helper or integration-test rewrite is needed. No PRD section applies.

Checks run and results:

- Read `AGENTS.md`, the approved spec, plan, existing review, both Vitest configs, both named unit test files, `src/app.ts`, package scripts, CI workflow and the relevant sections of all five documentation files: completed. CI has the stated 15-minute limit and check order.
- Inspected the external `%TEMP%\item39-tools\hook-timing-reporter.mjs` and installed Vitest runner/reporter event implementation: the external reporter matches the plan's algorithm; events identify the intended suite/module and hook, with the timing limitations in P1-3. No reporter or tests were executed.
- Read Builder evidence `integration-main-idle-hooks.log`: 42 files / 338 tests passed, duration 566.72 s. Recomputed `hook-timings-main-idle.log` statistics: 43 beforeAll records, mean 3179.51 ms, maximum 9168 ms, 15 above 3000 ms; the six slowest values agree with the plan. These are inspected Builder logs, not Reviewer test results.
- `git branch --show-current`: `fix/item-39-flaky-tests`; `git status --short` before review edit: only untracked `docs/work/`; `git rev-parse --short main`: `98a432f`; `git diff main -- src/`: empty. No branch switch, commit or production mutation performed.
- Full CI checks and test suites were not run for this plan-only review. No new log files were created. Only this item's `review.md` was edited.

Builder reply:

- P1-1 accepted. Build step 2 now builds the app inside each block's
  `beforeAll` and awaits `ready()` there; `afterAll` closes it only if it was
  built, so a failed `ready()` still closes the app. The helper returns a
  getter (`app()`) per block that throws a clear error if startup failed.
  Nothing calls `buildApp()` at collection time. The collection-time risk in
  "Risks" is replaced.
- P1-2 accepted. Build step 7 now requires consecutive passes (a failure resets
  the count and is reported), three `npm test -- --reporter=verbose` runs, and
  a table in "Changes from the plan" with all three rate-limit durations from
  every run, explaining any over 1000 ms. The load run in step 8 is verbose too.
- P1-3 accepted. "Measuring setup-hook times" now calls the figures coarse
  estimates of event arrival with no fixed error bound, explains the 100 ms
  batching and main-process replay, and says they suit the broad before/after
  comparison but not a claim about how close one hook came to a limit (that
  would need worker-side timestamps, not added in this item).
- P1-4 accepted. The load recipe is now PowerShell, starts a fresh set of loops
  for each suite with a 60-minute lifetime, records how many loops were still
  running when the suite ended (a run with a stopped loop is repeated), and
  stops only those process IDs in a `finally` block. The reporter command says
  which shell it is for. The CI-limit claim in "Risks" is replaced with the
  correct statement that one extra delay can push a slow CI run past 15
  minutes, which still fails the run.

## Plan review, round 2

Verdict: APPROVED

- P2-1 [suggestion] `plan.md` "Load recipe" starts the workers before entering `try`, so a terminating error while starting a later worker can bypass cleanup of workers already started. For a more robust recipe, initialize an array first, enter `try`, and append each successfully started process to that array inside it (with `-ErrorAction Stop`); keep the existing owned-process cleanup in `finally`. The normal suite-failure path is already covered, and this does not block the planned verification.
- P2-2 [suggestion] `plan.md` Build step 2 and "Risks" overstate the getter's startup-failure reporting. Vitest skips the block's tests after a failing `beforeAll`, so the getter normally never runs on that path; if `ready()` fails, the app reference is already assigned anyway. Say that Vitest reports the hook failure, skips the test and still runs `afterAll`; the getter guards accidental access before construction. The helper itself is sound.

All four round-1 findings are resolved:

- P1-1: The helper now constructs and readies a separate app inside each block's `beforeAll`; collection only registers hooks and returns a getter. `afterAll` safely handles an absent app and closes an assigned app after `ready()` fails. The current synchronous `createApp` signature accepts the optional proxy argument, and the getter narrows `App | undefined` to `App`. The existing conditional spread avoids passing an explicitly undefined optional property to `buildApp`. The sketch type-checks with the actual application types and strict compiler settings. Each test retains its own rate-limit store and existing request/assertion sequence.
- P1-2: Step 7 explicitly requires consecutive passes, three verbose full idle unit runs, two full integration runs, saved logs, and all nine rate-limit duration observations in "Changes from the plan", explaining any above 1000 ms.
- P1-3: The measurement section now describes coarse event-arrival estimates without a fixed error bound and explains worker batching and main-process scheduling. It explicitly requires worker-side timestamps for conclusions about proximity to a timeout. No precision claim remains.
- P1-4: The recipe is explicitly PowerShell, uses fresh workers per suite, checks all workers remain alive at completion, rejects incomplete-load runs and cleans up owned processes in `finally` after suite failures. The Node argument quoting works in this checkout. The CI risk now correctly includes the whole job budget and acknowledges that one additional delay can exhaust it. P2-1 is an optional improvement to the worker-start failure path.

The plan still matches owner decisions D1-D4: unit hooks 30 s, integration hooks 60 s, `AGENTS.md` updated in this item, and no retries. Current configs confirm that unit test-body defaults and integration `testTimeout: 15_000` / `fileParallelism: false` will be preserved. The mutation still targets the actual global `max: 100` in `src/app.ts`, is assigned to the Builder, and requires restoration evidence. No new blocking issue was found. No PRD section applies.

Checks run and results:

- Read `AGENTS.md`, the approved spec, revised plan, Builder replies, `test/rate-limit.test.ts`, both Vitest configs, `src/app.ts`, `tsconfig.json` and package scripts; inspected installed Vitest suite-hook failure handling: completed. Its runner skips children after a failed `beforeAll` and still executes `afterAll`.
- Compiled the plan's TypeScript sketch in memory using installed TypeScript 6.0.3 and the repository's full `tsconfig.json` file list, with the existing rate-limit helper/import context and added `beforeAll`/`afterAll` imports. `noEmit: true`, `strict: true`, `exactOptionalPropertyTypes: true`: zero diagnostics, exit 0. No source or temporary file was written. The first stdin-based invocation returned no output, so it was not counted as evidence; a subsequent direct invocation failed because PowerShell stripped quotes, then the encoded in-memory invocation above succeeded.
- Exercised the PowerShell worker recipe with one worker and a shortened 1500 ms lifetime: 1 of 1 workers alive after 150 ms; owned worker stopped in `finally` and `WaitForExit()` confirmed termination. Exit 0. This validates quoting/process handling, not sustained full-core load or suite performance; no full load run was performed.
- `git status --short --branch`: `fix/item-39-flaky-tests`, only untracked `docs/work/`; `git diff --stat` and `git diff main -- src/`: empty before this review addition. No branch switch, commit or production mutation performed.
- Full CI checks and test suites were not run for this plan-only review. No log files were created. Only this item's `review.md` was edited. This approval completes the plan review; the owner's plan approval gate still applies before implementation.

Builder reply: P2-1 applied: the load recipe now starts an empty `$load` array,
starts each loop inside `try` with `-ErrorAction Stop`, and keeps the
owned-process cleanup in `finally`. P2-2 applied: build step 2 and "Risks" now
say vitest reports the `beforeAll` failure, skips the test and still runs
`afterAll`; the getter only guards against using the app before it is built.

## Code review, round 1

Verdict: APPROVED

No blocking findings. Reviewed commit `418ef7c` on `fix/item-39-flaky-tests`
(`git diff main...HEAD`) against the approved spec and plan. No PRD section
applies.

- C1-1 [suggestion] The integration run emits `pg` deprecation warnings about
  calling `client.query()` while another query is executing
  (`review-item39-integration.log`). Track this separately before upgrading to
  pg 9; no production or integration-test changes are requested in item 39.

Acceptance evidence:

- Each rate-limit test has its own nested describe and app reference. The
  helper registers beforeAll/afterAll; construction and ready() occur only in
  beforeAll, and cleanup handles an absent app. There is no beforeEach,
  afterEach or collection-time buildApp call. All requests and assertions,
  including 100 allowed requests, the 101st 429 and follow-up key checks, are
  preserved.
- Unit hookTimeout is 30_000 with no testTimeout override; integration
  hookTimeout is 60_000, testTimeout remains 15_000 and fileParallelism remains
  false. No retry was introduced. Both the committed diff and current
  `git diff main -- src/ prisma/ .github/` are empty for those directories.
  The five planned documentation files are updated.
- Inspected Builder `rate-limit-mutation.log`: all three tests fail with
  expected 200 to be 429 after the stated max mutation, exit 1, followed by
  empty restore-diff markers. Independently confirmed the current production
  diff is empty (`review-item39-production-diff.log`); did not mutate src.
- My verbose full unit run reports rate-limit durations of 201 ms, 203 ms and
  121 ms, all below the observational 1000 ms target.
- Inspected Builder full logs: unit-item39-run1/run2/run3.log each has 451
  passes; integration-item39-run1/run2.log each has 338 passes after the
  recorded dev-server failure and standalone rerun. unit-item39-load.log and
  integration-item39-load.log pass with 4 of 4 load workers alive at completion.
  Rate-limit timings agree with the plan's table. Inspected baseline/load
  integration logs and recomputed the 43 beforeAll records in each timing log:
  maxima 5658 ms (main load), 3613 ms (branch run 1), 11735 ms (run 2), and
  4995 ms (branch load), matching the plan. These are Builder evidence, not
  independently repeated load or consecutive runs. The coarse timing limits
  and unproven integration cause are documented; the original dev-server
  interference is not treated as cured by a larger timeout.

Checks run by Reviewer, in AGENTS.md order (all executed commands exited 0):

| Check                          | Result                                                                | Full output log                     |
| ------------------------------ | --------------------------------------------------------------------- | ----------------------------------- |
| npm ci                         | Not required: neither package file changed                            | None (conditional skip)             |
| npm run format:check           | PASS                                                                  | review-item39-format.log            |
| npm run lint                   | PASS                                                                  | review-item39-lint.log              |
| npm run db:validate            | PASS                                                                  | review-item39-db-validate.log       |
| npm run db:migrate:deploy      | PASS; no pending migrations                                           | review-item39-db-migrate-deploy.log |
| npm run typecheck              | PASS                                                                  | review-item39-typecheck.log         |
| npm test -- --reporter=verbose | PASS; 29 files, 451 tests, 49.27 s                                    | review-item39-unit.log              |
| npm run test:integration       | PASS; 42 files, 338 tests, 350.18 s; deprecation warnings noted above | review-item39-integration.log       |
| npm run build                  | PASS                                                                  | review-item39-build.log             |
| npm audit --audit-level=high   | PASS; 0 vulnerabilities                                               | review-item39-audit.log             |

Environment/scope checks: Docker inspect confirmed travel-buddy-postgres was
already running, so no start was needed. Immediately before integration, checked
Node processes whose command line contains travel_buddy_backend: none
(review-item39-processes.log); queried pg_stat_activity excluding the checking
session: zero other travel_buddy sessions (review-item39-db-sessions.log).
No dev server was stopped. The earlier process check saw only my own Prettier
check. `git diff main...HEAD --check` passed. An initial rg invocation using a
Windows wildcard path failed; rerunning with explicit config paths succeeded
and found no retry. No test/hook timeout or failed check required a rerun.

Only this item's review.md was edited; root review-item39-*.log files are ignored
check artifacts. No branch switch, commit, push or PR action was performed.

Review-entry formatting: the initial targeted Prettier check failed
(review-item39-review-format.log). Formatted only review.md
(review-item39-review-format-fix.log); the targeted recheck passed
(review-item39-review-format-recheck.log).

Appending these notes introduced an extra EOF blank line, so the next targeted check also failed (review-item39-review-format-final.log). Formatted the review again and verified it with review-item39-review-format-verified.log.

Builder reply: C1-1 noted and not changed in this item (rule 1: one item at a time). I will list the `pg` "client.query() while another query is executing" deprecation warnings in my report as a suggestion for a separate item before any pg 9 upgrade.
