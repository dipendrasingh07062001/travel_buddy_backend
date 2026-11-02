## Spec review, round 1

Verdict: CHANGES REQUESTED

- S1-1 [blocking] `spec.md`, Proposed behaviour 2 / D2 and acceptance criteria 3-4: define the startup validation boundary. "Set but invalid" currently promises startup failure, while criterion 4 leaves SDK key rejection at request time. PR #44 validates nonempty key text but `cert()` can reject malformed PEM during initialization; a structurally valid but revoked key can only fail when contacting Firebase. Require offline JSON/shape/project and SDK key validation before the server listens or starts workers, with fixed sanitized messages and no retained raw cause; explicitly leave remote credential validity to the owner's live checklist. Add a testable startup criterion: malformed JSON, wrong fields/project, and SDK key rejection exit nonzero before listening, while unset and valid synthetic credentials pass validation. Capture actual startup stdout/stderr (including the existing environment-error and fatal-error paths), and assert synthetic secret markers are absent; checking only the thrown error does not verify the stated output guarantee.
- S1-2 [suggestion] `spec.md`, Problem: the sign-in claim is correct (`auth.routes.ts:47-51` requests a fresh check, propagated as `checkRevoked` by `auth.service.ts:45-47`). However, separate the HTTP routes that return `503 AUTHENTICATION_UNAVAILABLE` from background Firebase account erasure and push delivery: those propagate/log worker failures rather than return an HTTP 503 (`firebase-sign-in-accounts.ts`, `account-erasure.ts`, `fcm-push-sender.ts`, `push-delivery.ts`). Qualify the "deployment would look healthy" statement for the intended push-disabled deployment; `server.ts` also initializes the push sender when push is enabled.
- S1-3 [suggestion] `spec.md`, Proposed behaviour 3 and acceptance criteria 6-7: include the required `docs/backend-remaining-work.md` update, and change the log destination from `logs/` to repository-root `*.log` files as required by AGENTS.md.

D1 assessment: cherry-picking the single commit `14aa101` onto the current item branch is sound and avoids importing its older branch history. Its parent version of `firebase-app.ts` matches current main; the intervening `env.ts` changes export the schema and add the profile-photo setting/validation, which must be preserved. No checkout, cherry-pick, merge, commit, or push was performed during this review.

Verification: read AGENTS.md, the spec, all six requested current source files, commit `14aa101` (including its tests and ignore rules), and the relevant worker paths; compared the commit's parent with HEAD for the credential helper and environment configuration. HEAD is `e95be53` on `feature/item-28-firebase-hosted-credentials`. This is a spec review only; no tests or CI checks were run.

Builder reply:

- S1-1 accepted. Proposed behaviour 2 now defines the boundary: an offline
  check before listening or starting workers (JSON, fields and `type`, project
  match, and `private_key` parsing as a PEM private key), exiting non-zero with
  one fixed message. Remote validity (a revoked or deleted key) is stated as a
  limit and left to the owner's live checklist. Criteria 3 and 4 now require a
  child-process test of the real server entry point with a synthetic marker,
  asserting the exit code, no listening, the message, and the marker absent
  from stdout and stderr, plus a pass for unset and valid synthetic
  credentials.
- S1-2 accepted. "Problem" now separates the HTTP routes that return 503 from
  the account-erasure and push-delivery jobs, which log and retry; push is
  noted as running only when enabled. The "looks healthy" wording now says a
  malformed secret passes the health check.
- S1-3 accepted. Docs now include `docs/backend-remaining-work.md`, and logs go
  to root `*.log` files, following `AGENTS.md` on `main`. (A newer rule using
  `logs/` exists only on the unmerged `chore/repo-cleanup` branch.)

## Spec review, round 2

Verdict: APPROVED

- S2-1 [suggestion] `spec.md`, acceptance criterion 3: when writing the plan/tests, give the environment-error and fatal-startup output paths explicit child-process cases rather than assuming the listed malformed-secret cases exercise both. For example, PR #44's empty/oversized setting fails in `env.ts`, while a sanitized credential initialization failure can exercise `server.ts`'s fatal logger. Assert the synthetic marker is absent from both output streams in each case. The spec already requires both paths; this is a test-design clarification, not a blocker.

Round 1 resolution:

- S1-1 resolved. Proposed behaviour 2 now requires offline JSON/shape/project/key validation before listening or starting workers, fixed messages without the underlying error, and explicitly leaves remote key validity to the owner's live sign-in check. Acceptance criteria 3-4 require the real server entry point in a child process, nonzero failure before listening, output marker checks, and unset/valid synthetic success cases. This addresses the gap in main's `server.ts` (listens before any explicit Firebase validation) and PR #44 (lazy parsing with mocked SDK tests only). Key parsing should use the SDK-compatible validation during implementation.
- S1-2 resolved. The Problem section distinguishes HTTP 503 responses from worker logging/retries and qualifies push delivery as enabled-only. This matches the auth service, account-erasure and push-delivery paths. Main initializes the push sender after listening when push is enabled; the revised startup requirement supersedes that ordering for configured-secret validation.
- S1-3 resolved. Proposed behaviour 3 includes `docs/backend-remaining-work.md`; acceptance criterion 8 saves full check output to repository-root `*.log` files.

Verification: read AGENTS.md, the Builder's round 1 reply and updated spec; inspected main's `src/server.ts`, `src/config/env.ts` and `src/modules/auth/firebase-app.ts`; inspected commit `14aa101`'s credential/environment changes and `test/firebase-app.test.ts`; checked the current auth and relevant worker/sender paths. Confirmed the commit's parent credential helper matches main. HEAD remains `e95be53` on `feature/item-28-firebase-hosted-credentials`. This is a spec review only; no tests or CI checks were run. Only this review file was edited; no commit, branch switch, cherry-pick or push was performed.

Builder reply: S2-1 accepted for the plan: the tests will have separate child-process cases for the environment-error path (`env.ts`, for example an empty or oversized setting) and the fatal-startup path (`server.ts`), each asserting the marker is absent from both stdout and stderr.

## Plan review, round 1

Verdict: CHANGES REQUESTED

- P1-1 [blocking] `plan.md`, Tests / `test/server-startup.test.ts`: `PORT=0` is rejected by `envSchema` (`src/config/env.ts`, minimum 1). All five intended fatal-startup cases therefore exit in environment validation before reaching the credential check or `server.ts` logger. Use a schema-valid port; these negative cases must fail before binding it. Specify a controlled child environment (including `NODE_ENV=test`, enabled fatal logging, a synthetic valid `DATABASE_URL`, disabled optional services, and no inherited credential/configuration settings), and prevent `dotenv/config` from loading the checkout's `.env` (for example `DOTENV_CONFIG_PATH` pointing to an empty file outside the repository, with override/debug disabled). Otherwise unrelated developer settings can mask the intended path or suppress its output. Assert the expected credential message plus `API failed to start` for fatal cases, and the environment diagnostic without the fatal message for the oversized case. Set a child deadline below the 30 s hook limit, reject spawn errors/signals/timeouts, and kill/reap outstanding children on failure; `beforeAll` timing out alone does not clean up children. Keep parallel launches asynchronous and test bodies limited to assertions. A cold real-entry-point run here took 13.1 s, so the hook arrangement is reasonable but needs that bounded lifecycle.
- P1-2 [blocking] `plan.md`, Steps/Tests: add the verification step covering acceptance criterion 8. The plan currently has no commitment to run the complete ordered AGENTS.md checks after building, start the database first, save complete output in repository-root `*.log` files, and handle timeouts as failures with the required isolated rerun/investigation. State that `npm ci` is conditional on manifest/lock changes. This is required even though no integration test changes are planned.
- P1-3 [suggestion] `plan.md`, Step 4: explicitly name both the current milestone and "Already implemented" sections of `docs/backend-remaining-work.md` so the build does not update only one. The docs file list itself is complete, and cherry-picking `14aa101` also carries the required ignore rules.

Design and acceptance coverage:

- Criteria 1, 2, 4, 5 and 6 are covered by the retained/adapted Firebase tests and new helper tests; retain the SDK-thrown-error and fresh-token sanitization assertions. Criterion 3 needs P1-1; criterion 7 is covered by the cherry-pick and docs step; criterion 8 needs P1-2.
- The proposed first statement inside main's existing startup `try` is the correct location: it runs before `app.listen`, the realtime connection and all workers. Current `buildApp` registers readiness checks rather than executing them, and Prisma client construction is lazy; the negative credential cases can stop without a database connection. Environment errors exit during module evaluation even earlier. Do not run valid/unset credentials through the full server expecting no database use: their success belongs in the helper tests as planned.
- `createPrivateKey()` is a sound offline parse check for Google's normal RSA PEM service-account keys. Installed `firebase-admin` also calls `createPrivateKey(this.privateKey)` in its service-account constructor. A generated RSA PKCS#8 PEM passed both implementations. This proves syntax compatibility, not remote acceptance; the plan documents that limit correctly. Fixed errors without a retained cause fit the existing fatal serializer.
- D1/D2 match the approved decisions. No migration is needed. Closing PR #44 remains subject to the owner's authorization for the eventual PR work; no Git/PR mutation was performed in this review.

Checks run (plan review only):

- Read `AGENTS.md`, the approved spec, plan and existing review; inspected current/main `server.ts`, `env.ts`, `firebase-app.ts`, `app.ts`, database construction/settings, Vitest configuration, and commit `14aa101`'s source/file list. Confirmed the checkout starts at `e95be53` with only the work directory untracked.
- Inspected installed tsx (4.23.15), dotenv's configuration options and Firebase Admin's private-key parser.
- Ran the real entry point with tsx and synthetic configuration, `.env` loading redirected to `NUL`, and `PORT=0`: exit 1 after approximately 13,116 ms; environment/PORT error present, fatal-startup message absent. No raw output or credentials were printed.
- Spawned a trivial Node child with a synthetic environment value longer than 65,536 characters: exit 0 on this Windows environment. The proposed oversized-value case is feasible here.
- Generated an ephemeral RSA-2048 PKCS#8 PEM in memory: Node private-key parsing and Firebase `cert()` both succeeded. No key was printed or saved.
- These were small diagnostic experiments, not project test suites; no CI checks or full-test logs were produced at this plan stage. Only `review.md` was edited; no commit, branch switch, cherry-pick or push was performed.

Builder reply:

- P1-1 accepted. The startup test now builds each child's environment from
  scratch (no inherited settings), uses the valid `PORT=3999`, a synthetic
  `DATABASE_URL`, push off, `LOG_LEVEL=info`, and `DOTENV_CONFIG_PATH` pointing
  to an empty file outside the repository so `.env` is never loaded. Fatal cases
  assert their fixed message plus `API failed to start`; the oversized case
  asserts the environment diagnostic and no fatal message. Each child has a
  45 s deadline; spawn errors, signals and timeouts fail the case; `afterAll`
  kills and waits for any remaining child. Because of your 13 s cold-start
  measurement with six parallel starts on 4 cores, this one `beforeAll` sets an
  explicit, commented 60 s limit instead of the 30 s default.
- P1-2 accepted. New step 5 covers the database start, the dev-server check,
  every check in `AGENTS.md` order with root `item28-*.log` files, `npm ci` only
  on manifest changes, and timeouts as failures with an isolated rerun.
- P1-3 accepted. Step 4 now names both sections of
  `docs/backend-remaining-work.md` and the roadmap's "Status recorded".

One more change while editing: step 6 now records the commit layout. The
cherry-pick keeps PR #44's commit and its author, and this item's work is a
second commit on top, so the branch has two commits rather than one.

## Plan review, round 2

Verdict: APPROVED

- P2-1 [suggestion] Owner plan-approval gate: explicitly approve the two narrow workflow exceptions described below (the single 60 s startup-test hook and retaining the cherry-picked commit plus one new implementation commit). Both are technically reasonable; this review recommends them but does not itself waive AGENTS.md on the owner's behalf.
- P2-2 [suggestion] `plan.md`, Tests / Controlled environment: spawn `process.execPath` directly with an argument array and no shell, and read the parent's Windows PATH case-insensitively (commonly exposed as `Path`). This avoids executable lookup and shell dependencies while keeping the environment allowlist. Do not inherit NODE_OPTIONS, dotenv overrides/debug options, or unrelated service settings.

Round 1 resolution:

- P1-1 resolved. `PORT=3999` satisfies `env.ts`'s 1-65535 range. The fresh environment supplies the required synthetic configuration, enables fatal logging and disables push; the external empty dotenv file prevents checkout configuration from masking cases. Because no dotenv override/debug settings are inherited, their defaults suffice. The five fatal cases assert both their credential diagnostic and `API failed to start`; the oversized case asserts the environment diagnostic without the fatal message. This matches module-time environment validation versus the existing startup catch. Putting the credential check first inside the startup try precedes listening and workers. Each child has a 45 s deadline, spawn errors/signals/timeouts fail, and outstanding children are killed and awaited. The per-file 60 s hook gives those deadlines time to complete; assertion-only test bodies keep their 5 s default.
- P1-2 resolved. Step 5 starts the database, checks for a dev server, lists all required checks in order, makes npm ci conditional on manifest/lock changes, saves full output in repository-root item28-*.log files, and requires an isolated rerun plus investigation for timeouts. Full verification still applies even without integration-test changes.
- P1-3 resolved. Step 4 explicitly updates Current milestone and Already implemented, together with the roadmap status/date and the other required docs.

Assessments requested by the Builder:

- **60 s beforeAll:** recommend accepting this documented, file-local exception to AGENTS.md's 30 s unit-hook rule. The earlier 13.1 s cold-start measurement and six parallel processes on four cores justify headroom, although they do not prove a particular worst-case runtime. The 45 s child deadlines leave 15 s within the hook for coordination and cleanup. Keep vitest.config.ts's global 30 s hook limit and the 5 s test-body limit unchanged. A timeout still fails and requires the prescribed rerun/investigation; increasing the hook does not classify it as flakiness. Actual timing and cleanup must be checked at code review.
- **Two commits:** recommend accepting the explicit layout in step 6. One preserved-author cherry-pick plus one new item commit is consistent with approved D1 and preserves attribution, but the branch does literally contain two commits rather than AGENTS.md's one-local-commit wording. Record the owner's exception at plan approval; do not silently squash or rewrite the imported author's commit. No commit, cherry-pick or push is authorized by this review.
- **Minimal child environment:** sufficient for the planned direct Node/tsx invocation on this Windows checkout, verified below. Installed tsx derives its temporary/cache location from node:os (and the OS user), and esbuild resolves its installed native binary without requiring npm, a shell, HOME or inherited application credentials. Windows SystemRoot plus PATH worked without TEMP/TMP or USERPROFILE. On ubuntu-latest CI, Node's temporary-directory fallback is /tmp and tsx uses the effective uid; no HOME/TMPDIR addition is indicated for this invocation. This Linux conclusion is source/platform reasoning, not a Linux execution result. Use the explicit external empty file in the actual tests and create/remove it through Node filesystem APIs.

Checks run:

- Read AGENTS.md, the Builder's Plan round 1 reply, the full updated plan and approved spec; checked src/config/env.ts, src/server.ts and vitest.config.ts against the planned validation order, logging paths and timeout configuration.
- Read package.json and .github/workflows/ci.yml; confirmed Node 24 on ubuntu-latest and the ordered check list. Inspected installed tsx temporary-directory logic and esbuild executable resolution.
- Ran a bounded Windows diagnostic using spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', ...]) with only PATH/SystemRoot and the plan's synthetic settings. Imported src/config/env.ts and performed an esbuild TypeScript transform: exit 0, no signal, no spawn error, empty stderr, expected success marker. Used Node's empty null device for DOTENV_CONFIG_PATH in this diagnostic, avoiding any file creation or checkout .env access. This checks environment/loader feasibility, not the unimplemented startup cases or a cold six-process workload.
- Confirmed branch feature/item-28-firebase-hosted-credentials at e95be53; initial git status showed only the untracked item work directory. No project test suites, full CI checks or Linux runtime checks were run at this plan stage; no test logs were created. Only review.md was edited; no branch switch, cherry-pick, commit or push was performed.

Builder reply: P2-2 applied in plan.md "Tests": `spawn(process.execPath, [...])` with no shell, the path variable read case-insensitively, and nothing else inherited (including `NODE_OPTIONS` and `DOTENV_*`). P2-1 is for the owner, who is asked to approve both exceptions at the plan gate.

## Code review, round 1

Verdict: APPROVED

No blocking findings or suggestions.

Reviewed 2026-10-29 through 2026-10-30 on
`feature/item-28-firebase-hosted-credentials`, HEAD `b91712b`. Read AGENTS.md,
the approved spec and plan, and `git diff main...HEAD`, including both
`92cbd2f` (PR #44 cherry-pick) and `b91712b` (item implementation).

Review evidence:

- `firebase-app.ts` replaces JSON, schema, project and crypto failures with
  fixed credential messages, without retaining raw errors or a `cause`.
  `firebaseApp()` catches initialization failures and throws a fixed
  `503 AUTHENTICATION_UNAVAILABLE`; a configured hosted secret never falls
  back to ADC. Only the three allowlisted credential fields reach `cert()`;
  unset credentials preserve ADC and an initialized app is reused.
- The offline key check uses `createPrivateKey()`, matching the installed
  Firebase Admin SDK's service-account key validation. Remote rejection is
  still translated to a generic 503 by the token verifier. Existing Firebase
  error and fresh-authentication tests remain in place.
- `server.ts` calls the check first inside the startup try, before listen,
  the realtime listener and all workers. App construction does not start
  those workers. The startup catch logs only the sanitized credential error.
- All six real-entry-point child cases passed, including fatal-startup and
  oversized environment-error output checks. The children use direct Node
  invocation without a shell, a fresh environment with only PATH/SystemRoot
  inherited, synthetic settings and an external empty dotenv file. Both
  output streams are collected and checked for the synthetic secret marker.
  Deadlines fail cases; remaining children are killed and awaited in cleanup.
  No folder Node processes remained after unit tests. The single commented
  60 s beforeAll and two-commit layout match the owner's approved exceptions;
  global unit/integration timeout settings are unchanged.
- Inspected `item28-startup-mutation.log`: removing the startup call caused
  five credential cases to fail and the oversized case to pass. Four failures
  showed EADDRINUSE from the parallel children's shared port; one child hit
  its deadline. This is negative mutation evidence, not a passing check or
  proof of independent port isolation. No source mutation was performed by
  this Reviewer; the startup call is present in the reviewed source.
- README, hosting guide, environment example, setup checklist, remaining-work
  and roadmap updates match the implementation and distinguish offline
  validation from the owner's live Firebase/deployment checks. Ignore rules
  cover the added credential-file locations. No real key was sought or used.

Checks run by this Reviewer (full output in ignored repository-root logs):

| Check                                                                                     | Result                                                                                                   | Log                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `npm ci`                                                                                  | Not required: neither package manifest nor lockfile changed against main                                 | none                                                        |
| `docker start travel-buddy-postgres`                                                      | Exit 0; container running                                                                                | command output; readiness also checked during investigation |
| `npm run format:check`                                                                    | PASS, exit 0                                                                                             | `review-item28-format-check.log`                            |
| `npm run lint`                                                                            | PASS, exit 0                                                                                             | `review-item28-lint.log`                                    |
| `npm run db:validate`                                                                     | PASS, exit 0                                                                                             | `review-item28-db-validate.log`                             |
| `npm run db:migrate:deploy`                                                               | PASS, exit 0; 40 migrations, none pending                                                                | `review-item28-db-migrate-deploy.log`                       |
| `npm run typecheck`                                                                       | PASS, exit 0                                                                                             | `review-item28-typecheck.log`                               |
| `npm test -- --reporter=verbose`                                                          | PASS, exit 0; 31 files, 489 tests                                                                        | `review-item28-unit.log`                                    |
| Pre-integration process/database scans                                                    | No dev server; final scan found no folder Node processes and no other PostgreSQL client sessions         | `review-item28-preintegration.log`                          |
| `npm run test:integration` (first run)                                                    | FAIL, exit 1; 41 files passed, 1 failed; 333 tests passed, 5 skipped; auth-freshness beforeAll timed out | `review-item28-integration.log`                             |
| `npm run build`                                                                           | PASS, exit 0                                                                                             | `review-item28-build.log`                                   |
| `npm audit --audit-level=high`                                                            | PASS, exit 0; zero vulnerabilities                                                                       | `review-item28-audit.log`                                   |
| `npx vitest run --config vitest.integration.config.ts test/auth-freshness.integration.ts` | PASS, exit 0; 1 file, 5 tests, 12.72 s                                                                   | `review-item28-auth-freshness-rerun.log`                    |
| Pre-integration rerun scan                                                                | No dev server or other PostgreSQL clients; only this review's build compiler was observed                | `review-item28-preintegration-rerun.log`                    |
| `npm run test:integration` (full rerun)                                                   | PASS, exit 0; 42 files, 338 tests                                                                        | `review-item28-integration-rerun.log`                       |
| Windows power-event investigation                                                         | Sleep/hibernate events occurred during the first integration run                                         | `review-item28-interruption.log`                            |
| `git diff --check main...HEAD`, `git diff --check`                                        | PASS, exit 0                                                                                             | command output (empty)                                      |

Timeout investigation: the first integration run reported a 60,000 ms
beforeAll timeout at `test/auth-freshness.integration.ts:95`, with that file
showing 10,816,109 ms and the entire run 59,178.79 s across the overnight
interruption. Windows System events include Kernel-Power 42 (Button or Lid)
at 2026-10-29 16:55:22 and a later hibernate event at 19:55:28. This supports
an interrupted host run rather than an established code defect; it does not
prove which awaited setup operation was pending. The required isolated rerun
passed, and a subsequent full integration run passed without another timeout.
The original failure is retained, not classified as known flakiness.
Integration logs also contain pg client.query deprecation warnings.

Only this review.md was edited (besides the requested ignored review logs and
generated build outputs). No source edits, commit, branch switch or push.

Builder reply: no findings to answer. The first integration failure (auth-freshness `beforeAll` timeout during the laptop sleep and hibernate events) is noted as recorded: the isolated rerun and the full rerun both passed, so nothing in the code changes. The `pg` deprecation warnings remain a separate suggestion from item 39.
