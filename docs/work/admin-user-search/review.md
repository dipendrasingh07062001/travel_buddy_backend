# Review: admin user search

## Spec review, round 1

Verdict: CHANGES REQUESTED

- S1-1 [blocking] Contact searches can leak private values through request URLs (spec "Audit" and "Privacy, safety and abuse"; `src/app.ts:105-112`). The proposed GET puts email/phone in `query`, while the current logger redacts only authorization and cookie headers. Omitting the value from `ModerationAction` does not protect ordinary request logs, upstream access logs, or browser history. PRD Â§18 requires data minimisation and privacy-aware observability. Specify how contact values are kept out of application/access logs and caches, and address URL/history exposure (for example, a body-based contact lookup with appropriate logging controls). Add an acceptance criterion capturing logs for successful, failed, invalid and unauthorized contact requests and asserting that the raw and URL-encoded contact never appears. Any necessary logging changes must be explicitly included in this item's scope.

- S1-2 [blocking] The error table and first acceptance criterion promise `403 STAFF_ONLY` for suspended staff, but the required existing auth pattern returns `403 ACCOUNT_SUSPENDED` first. `staffIdentity` calls `authenticateRequest` before `requireStaff` (`src/modules/moderation/moderation.routes.ts:102-109`); `requireActiveUser` also returns `ACCOUNT_DELETION_PENDING` for pending deletion and `ACCOUNT_DISABLED` for disabled accounts (`src/modules/auth/auth.service.ts:85-149`). Align the spec and acceptance criteria with these existing errors, retaining `STAFF_ONLY` for active ordinary users, or explicitly propose and justify changing this route's auth behavior. Test revoked credentials and role removal as well as suspended staff.

- S1-3 [suggestion] Clarify that contact lookup searches stored identities, not every current Firebase contact (spec query table and email acceptance criterion). `verifiedContacts` stores an email only when `emailVerified` is true, trims/lowercases it, and preserves the supplied phone value (`src/modules/auth/auth.repository.ts:32-55`). Existing sign-in returns the account without synchronizing identities; synchronization is a separate profile-signals flow. Thus an unverified Firebase email generally has no searchable row, and a changed contact may not be searchable until refresh. Document these limits, distinguish a stored nullable `verifiedAt` from an unverified Firebase email, and test that an unstored contact produces no match. The 100-character query cap also excludes some identities allowed by the 320-character database column; explicitly accept that limitation or provide a contact-appropriate cap.

- S1-4 [suggestion] Make validation behavior explicit (spec query parameters, errors and acceptance criteria). `additionalProperties: false` alone should not be relied upon to guarantee rejection under Fastify's default removal of additional properties; `src/app.ts` has no custom Ajv configuration. Specify route-local rejection if unknown parameters must return 400, without changing unrelated routes. Resolve raw versus trimmed length checks so a one-character query consistently yields `INVALID_USER_SEARCH`, and define whitespace-only and overlength results. Include `_`, backslash, tied timestamps, empty/out-of-range pages, missing profile, duplicate restrictions and restriction boundary times in the testable criteria.

- S1-5 [suggestion] Strengthen the audit/abuse decision (spec "Audit", D2 and D4). Successful contact lookups have a sensible target-based `ModerationAction` design, but specify that the authenticated actor is recorded and results are not disclosed if the audit write fails. Define whether "finds an account" means a contact identity exists or the account survives status/role/pagination filters. Not auditing names is a defensible choice under PRD Â§18, which requires logs for material changes rather than every read, but the justification should acknowledge that account status, role, restrictions and report counts are private moderation metadata. A 60/minute limit still permits substantial paging and contact guessing; consider privacy-safe actor-level attempt/volume monitoring (including misses, without raw contact values), or explicitly record acceptance of that residual risk in D2/D4. Do not fabricate a target UUID to fit unmatched attempts into `ModerationAction`.

Builder reply:

- S1-1 fixed. Contact lookups moved to a new `POST /api/v1/admin/users/lookup`
  (body only); `GET /admin/users` now rejects `@` and leading `+` with
  `400 USE_CONTACT_LOOKUP`. Both routes log their URL without the query string
  (route-level serializer), send `Cache-Control: no-store`, and never echo the
  value in errors. Confirmed no route logs bodies (`grep` for body in log calls
  and for serializers: none). Log-capture acceptance criteria added for hit,
  miss, invalid and unauthorised requests, raw and URL-encoded. See spec
  "Keeping contacts and searches out of logs".
- S1-2 fixed. The error table now lists the existing `authenticateRequest`
  codes in order (`UNAUTHENTICATED`, `ACCOUNT_NOT_PROVISIONED`,
  `ACCOUNT_DELETION_PENDING`, `ACCOUNT_SUSPENDED`, `ACCOUNT_DISABLED`), then
  `STAFF_ONLY` for active ordinary users. Criteria added for revoked tokens,
  role removal, suspended and pending-deletion staff.
- S1-3 fixed. Spec "What is searchable" documents that only stored identities
  match (verified emails only; contacts written at account creation and on
  `POST /me/verification-signals/refresh`). Lookup `value` cap is now 320, the
  column limit. Criterion added for an unstored contact.
- S1-4 fixed. Unknown parameters are documented as dropped (Fastify default,
  unchanged). Raw schema bounds give `REQUEST_ERROR`; trimmed length under 2,
  including whitespace only, gives `INVALID_USER_SEARCH`. Criteria added for
  `_`, `\`, tied timestamps (tie-break on `id` descending), pages past the
  end, `page=0`, missing profile rows, duplicate restrictions and restriction
  boundaries (lifted, expired, future, no end date).
- S1-5 fixed. The audit row is written with the caller as `actorId` in the
  same transaction as the read; a failed write returns `500` and no account.
  "Finds" means an identity row matched (the lookup has no filters or paging).
  Misses write no `ModerationAction`; every attempt writes one log line with
  staff ID, contact type and match result, never the value. The name-search
  justification now acknowledges the moderation metadata it returns. Residual
  paging and guessing risk is stated and accepted in D2 and D4; lookup limit
  is 20 per minute.

## Spec review, round 2

Verdict: CHANGES REQUESTED

- S1-1 not resolved (partially fixed): Moving contacts to POST removes the intended URL/history exposure. Route-level `logSerializers.req` does protect the incoming-request line: Fastify installs `context.logSerializers` before creating the request logger (`node_modules/fastify/lib/route.js:478-481`), then logs through that logger (`lib/log-controller.js:50`). An in-memory injection confirmed that the query string was absent even on a malformed-JSON 400. The remaining 5xx error-log exposure is S2-1 below.
- S1-2 resolved: The access table and acceptance criteria now agree with `authenticateRequest`, `requireActiveUser` and `staffIdentity` (`src/modules/auth/auth.service.ts:85-149`; `src/modules/moderation/moderation.routes.ts:102-109`). `requireStaff` reads the current role from the database (`moderation.repository.ts:62`); revoked credentials use the fresh check.
- S1-3 resolved: Stored-only lookup, verified-email storage, refresh timing, the 320-character cap and unstored-contact miss are documented. These match `verifiedContacts` and the existing-account bootstrap shortcut (`auth.repository.ts:32-55` and `bootstrapFirebaseUser`), the profile-signals refresh transaction, and identity deletion in `account-erasure.ts:241`.
- S1-4 resolved: Raw versus trimmed validation and unknown-field removal are explicit. The requested literal characters, timestamp tie-break, empty pages, missing profile and restriction edge cases now have acceptance criteria. No new blocking validation issue found.
- S1-5 resolved: The actor, hit/miss definition, fail-closed audit, private metadata rationale and residual-risk decisions are explicit. A callback transaction that reads the identity and writes the action before returning fits existing Prisma repository patterns (`moderation.repository.ts:229-261`, `738-795`). The moderation-action list is unfiltered by action type (`800-807`), so the added enum value can appear there. The monitoring wording needs the optional clarification in S2-2.

- S2-1 [blocking] Protect error objects as well as request serialization (spec "Keeping contacts and searches out of logs" and "Logs and limits"; `src/app.ts:260-261`). The shared handler logs the complete `err` for every 5xx. Prisma errors can render query arguments in their message, so omitting request bodies and stripping `req.url` does not fulfill the promise that lookup values never enter logs. A local probe using the installed generated Prisma client and a synthetic email produced `PrismaClientValidationError` with `messageContainsContact: true`; no database connection was needed. Specify route-scoped sanitization of lookup failures before the shared logger (or an equivalent safe error serializer), retaining only safe diagnostic fields and avoiding raw message/stack/cause/meta that can contain inputs. Add captured-log criteria for repository/read failure and audit-write failure, asserting no raw or encoded contact; keep the existing 500/no-account criterion. This is a gap in the S1-1 fix, not a failure of Fastify's route-level request serializer.
- S2-2 [suggestion] Clarify the scope of "Every lookup" / "Each lookup writes one log line" (spec lines 168-170 and 287). Invalid bodies, unauthorized requests, 429s and database failures cannot all supply an authenticated staff ID, valid contact type and boolean match result. Define the hit/miss event for authorized, valid, completed lookups, and define separate safe rejected/failed outcomes if those attempts must also be counted. Add explicit 429 log-capture and no-store checks for error responses so the plan places headers before early exits. The installed rate-limit plugin runs at `onRequest` and does not itself log the URL/body; the application's 4xx handler logs only status/code. The installed JSON parser also returns a fixed malformed-JSON message without echoing the body.

Verification: Read-only source inspection and two in-memory/runtime probes; no implementation exists yet, so the code-stage CI suite was not run. The first Prisma probe failed to parse because TypeScript syntax was used in JavaScript stdin; the corrected probe passed and confirmed the error-message exposure. No files other than this review were edited; no commit or push was made.

Builder reply:

- S2-1 fixed. Spec "Keeping contacts and searches out of logs" now requires
  both routes to catch any non-`AppError` from the database read or audit
  write, log one safe line (error class name and Prisma `code` only; no
  message, stack, `cause` or `meta`), and rethrow a fresh
  `AppError(500, 'INTERNAL_SERVER_ERROR', ...)` with a fixed message and no
  cause, so `src/app.ts` logs only that. Covers the `GET` name search too,
  since its Prisma errors could carry the searched name. Log-capture criteria
  added for a failing read and a failing audit write on the lookup and a
  failing read on the search; the 500/no-account criterion is kept.
- S2-2 fixed. The `admin_user_lookup` line is defined only for lookups that
  pass auth, staff check and body validation, with `outcome` `hit`, `miss` or
  `failed`. Earlier rejections (401/403/400/429) write none and rely on the
  shared "Request rejected" line (status and code only). `Cache-Control:
no-store` must come from a route hook that runs for every reply, with a
  criterion for 200, 400, 403, 429 and 500, and 429 added to the log-capture
  criterion.

## Spec review, round 3

Verdict: APPROVED

- S1-1 resolved: The remaining error-log exposure is addressed by the route-scoped sanitization below. The POST body, query-free request serializer, non-echoing errors and all-response no-store requirement remain explicit; captured-log criteria now cover 429 and failing reads/writes as well as the earlier cases.
- S2-1 resolved: Spec "Keeping contacts and searches out of logs" requires both routes to catch non-AppError database read/audit failures, log only the error class name and Prisma code, and throw a fresh fixed-message AppError without cause. This fits `src/errors/app-error.ts:1-10`: its constructor attaches no original error. Although `src/app.ts:260-261` logs the full replacement error, that error no longer carries the Prisma message, stack, cause or meta. GET read failures and lookup read/audit failures have explicit log-capture criteria. This approves the specified behavior; implementation verification remains for the code stage.
- S2-2 resolved: The lookup event is explicitly limited to requests that pass authentication, staff check and validation, with hit/miss/failed outcomes; earlier rejections write none. The shared 4xx handler logs status/code only (`src/app.ts:263-269`). The spec requires no-store on every response and explicitly tests 200/400/403/429/500. A route-level onSend hook is feasible: the installed rate-limit plugin defaults to onRequest (`node_modules/@fastify/rate-limit/index.js:13,116`) and throws its 429 error (`index.js:362-375`); Fastify sends the error-handler response through the route's onSend (`node_modules/fastify/lib/reply.js:565-575`). An in-memory injection with the installed packages, a custom error handler and route-level onSend returned 200 and then 429, both with Cache-Control: no-store.
- No new blocking problems introduced by this revision were found. No disagreement remains for owner adjudication; owner spec approval is still the next workflow gate.

Verification: Read-only inspection of the revised spec, earlier review, shared error handler, AppError, rate-limit configuration/key generation and installed Fastify/rate-limit sources; the in-memory 200/429 probe passed. An initial read used the nonexistent `src/common/errors.ts` path; locating and reading `src/errors/app-error.ts` corrected it. No code-stage CI checks were run for this spec-only review. Only this review file was edited; no commit or push was made.

Builder reply:

No findings to answer. Spec waiting for owner approval and decisions D1 to D4.

## Plan review, round 1

Verdict: APPROVED

- P1-1 [suggestion] Explicitly test a revoked token, rather than only an invalid token (plan "Tests / Access"; spec "Acceptance criteria / Access"). Have the verifier accept the token for the rate limiter's local check but reject it when `checkRevoked: true`, and assert `401 UNAUTHENTICATED` on both routes. This verifies that the rate-limit identity cache cannot satisfy the required fresh staff check (`src/modules/auth/auth.service.ts:56-81`). The proposed reuse of `staffIdentity` already implements the correct behavior; this is a test-coverage clarification.

- P1-2 [suggestion] Describe the request serializer as a reduced serializer, or preserve the default diagnostic fields while replacing only the URL (plan "Shared route options"). The installed default (`node_modules/fastify/lib/logger-pino.js`) includes `version`, `host`, and `remotePort`; the proposal drops these and substitutes `hostname`. Request correlation is safe: `reqId` is a separate child-logger binding (`node_modules/fastify/lib/logger-factory.js`), so the custom `req` serializer does not remove it. Consider asserting its presence in the captured-log tests.

Verification:

- Read AGENTS.md first, then the approved spec, plan, prior review rounds, application registration/error handling, admin-metrics injection pattern, moderation exports, authentication and rate-limit code, Prisma schema, restriction logic, account erasure, data export, integration configuration and existing logging/restriction tests.
- Independently exercised the installed generated Prisma client against PostgreSQL inside a deliberately rolled-back interactive transaction. Raw `contains` with `mode: 'insensitive'` matched both `ab50cd` and `ab50%cd` for `50%`, both `a_xb` and `a__b` for `a__b`, and no fixture for a lone backslash. The planned escape function matched only the literal percent, underscores and backslash respectively. The planned nullable `reportedUserId` groupBy query was accepted and returned an empty group list for these report-free fixtures. All fixture inserts rolled back; no probe file or data remains.
- The page-ID `in` filter excludes null report targets; mapping the generated nullable group key still needs ordinary TypeScript narrowing. The restriction query includes `startsAt`, strict expiry and de-duplication. The search array transaction and lookup interactive transaction fit the specified behavior; search does not promise a cross-query snapshot. Lookup writes its audit before reading the summary and returns only after transaction completion. The nonexistent non-null actor UUID is a valid way to provoke the real actor foreign-key failure despite `actorId` being nullable. Use a target with no prior lookup actions, or compare against its baseline, for the no-new-action assertion.
- Route-level serializers, onSend and config.rateLimit are supported by the installed packages. The existing staffIdentity/pagination exports and adminMetrics-style injection require no moderation-module edit. The fixed replacement AppError has no original cause; guard/safeFailure agree with the approved sanitization contract. The lookup failed-outcome line must surround the guarded repository call so failures are counted exactly once.
- The additive enum migration has no same-transaction use of the new value. Follow the full AGENTS.md procedure, including prisma format, deploy, generate and the empty follow-up diff. Erasure deletes identities and leaves the fixed, evidence-free read audit compatible with existing retention; data export does not select moderation actions or expose staff audit details, so neither module needs a change.
- Planned fixtures, cleanup dependencies, fresh logging-app rate-limit stores and dedicated rate-test users are appropriate. Default unfiltered listing assertions must accommodate pre-existing database accounts rather than assume all rows belong to the marked fixtures. Split the two rate-limit loops up front if needed to fit the configured 15-second bodies; retain the mandatory isolated rerun and investigation for any timeout. Hooks have 60 seconds. Docs cover all three AGENTS.md destinations. No blocking acceptance-criterion or implementation-fit gap remains.
- This was a plan review: no code-stage CI checks were run and no implementation pass is claimed. Initial read-only lookups used a nonexistent database path and PowerShell-incompatible glob paths; corrected reads located the actual sources. Only this review file was edited; no commit or push was made.

Builder reply:

- P1-1 accepted. plan.md "Tests / Access" now includes a revoked token on
  both routes: the test verifier accepts it for the rate limiter's local check
  and rejects it with `checkRevoked: true`; expected `401 UNAUTHENTICATED`.
- P1-2 accepted. The route `req` serializer now keeps every default field
  (`method`, `url`, `version`, `host`, `remoteAddress`, `remotePort`, checked
  in `node_modules/fastify/lib/logger-pino.js`) and only strips the query
  string from `url`. A log test asserts `reqId` and the bare path on the
  "incoming request" line.
- Verification notes taken into the plan's closing notes: audit-failure
  target with no earlier actions, default-listing assertions limited to this
  file's users, one `failed` line per failure, rate-limit loops split up
  front.

## Code review, round 1

Verdict: CHANGES REQUESTED

- C1-1 [blocking] The required full integration check failed (`reviewer-admin-integration.log`; spec "Acceptance criteria / Docs and checks"). Vitest reported 42/43 files and 359/360 tests passed, with an unhandled worker exit (code `3221226505`) while running `test/notifications.integration.ts`. The isolated rerun passed 1/1, but does not turn the full run into a pass. No timeout was reported. This file is unchanged by the item, and a Windows Application event query found no matching crash record; the cause is unproven (`reviewer-admin-worker-investigation.log`). Investigate the worker failure and obtain a successful full integration run before approval; do not classify it as known flakiness or expand this item's code scope without the owner.
- C1-2 [suggestion] `README.md:1059-1065`: the example URL sends empty `query`, `status` and `staffRole`, which produce `400 REQUEST_ERROR`; it cannot demonstrate the default listing. Show `/api/v1/admin/users?page=1&pageSize=20` and describe optional filters separately. Also clarify that the 100-character maximum applies before trimming, and an empty query is a schema error, while a nonempty query shorter than two characters after trimming gets `INVALID_USER_SEARCH`.
- C1-3 [suggestion] `docs/backend-remaining-work.md:17`: the routes are documented under "Current milestone", but the approved plan's "Already implemented" entry is absent. Add the short entry required by the plan and AGENTS.md so the capability remains discoverable when the current milestone changes.

Implementation review:

- Read AGENTS.md first, then the approved spec, plan (including "Changes from the plan"), prior reviews and the complete item diff at `e269b9b`. HEAD is `e269b9b0d46685666e0c4905714659061d3ca4bf`; the merge base with the locally recorded origin/main is `193cb2499c651ec145f1e1d423f0b9cab98d2cca`. The origin/main ref is now `0ecb999354969159b1598ea740e1047da02e67a1`, so item changes were assessed against the stated base/commit rather than treating later main-only changes as deletions by this item. No fetch, commit or push was performed.
- No blocking implementation defect found in the reviewed module, application registration, schema, additive enum migration or response schemas. Fresh staff authentication and current-role checks reuse `staffIdentity`. Search filters, default exclusion of deleted users, timestamp/UUID ordering, pagination, literal LIKE escaping, summary field minimization, photo handling, active restriction boundaries/de-duplication and open-report counts match the spec.
- Lookup normalizes stored-contact keys consistently with `verifiedContacts`. Its interactive transaction reads the identity, writes the fixed-reason audit, then reads the summary, and resolves only after transaction completion. Audit/read failure therefore returns no account and rolls back the action. Erasure removes identities; no erasure/export change is required for the fixed, evidence-free action.
- The plugin-scope serializer cast agrees with installed Fastify's registration types/runtime: `plugin-override.js` inherits serializers into the child scope, and pino accepts the returned object. The serializer preserves the default diagnostic fields while stripping the query string; request correlation remains a logger binding. The scope is encapsulated and contains only these routes. Its `onSend` hook sets no-store for successful, validation, access, rate-limit and guarded failure responses. The captured-log and header checks are included among the 359 passing tests; the only incomplete file is notifications.
- `guard` sanitizes non-AppError repository failures before the shared 5xx logger, using only `safeFailure`'s class name and validated Prisma code, then throws a new fixed-message AppError without cause. Request bodies and searched query strings are not logged. Lookup events carry only staff ID, contact type and outcome; rejected requests do not generate lookup events. Schemas expose every specified summary field and drop additional fields.
- Unit and integration tests cover the acceptance groups: access/revocation/demotion, default and filtered search, escaping, invalid inputs, ordering/pages, allowed response keys and metadata, normalized contact hits/misses, suspended/deleted targets, audit records/fail-closed behavior, captured logs and per-account rate limits. The failing-audit requirement is exercised with a real transaction/foreign-key rejection rather than only a unit stub. Fixtures use per-run UUIDs, cleanup deletes dependent audit/restriction/report records before users, and dedicated accounts/app stores isolate rate limits. The deleted-account fixture intentionally models identities already erased, as disclosed in the plan changes.

Checks run (complete output saved in repository-root logs):

| Command                                                                                                               | Result                                                                                             | Log file                                   |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `npm ci`                                                                                                              | Skipped as instructed; package files unchanged from `193cb24`                                      | Not applicable                             |
| `docker inspect --format '{{.State.Running}}' travel-buddy-postgres`                                                  | `true`; database confirmed running before database checks                                          | Tool output (read-only prerequisite check) |
| `npm run format:check`                                                                                                | PASS, exit 0                                                                                       | `reviewer-admin-format.log`                |
| `npm run lint`                                                                                                        | PASS, exit 0                                                                                       | `reviewer-admin-lint.log`                  |
| `npm run db:validate`                                                                                                 | PASS, exit 0                                                                                       | `reviewer-admin-db-validate.log`           |
| `npm run db:migrate:deploy`                                                                                           | PASS, exit 0; 41 migrations, none pending                                                          | `reviewer-admin-db-deploy.log`             |
| `npm run typecheck`                                                                                                   | PASS, exit 0                                                                                       | `reviewer-admin-typecheck.log`             |
| `npm test`                                                                                                            | PASS, exit 0; 32/32 files, 507/507 tests; 119.61 s; no reported timeout                            | `reviewer-admin-unit.log`                  |
| `npm run test:integration`                                                                                            | FAIL, exit 1; 42/43 files, 359/360 tests; one unhandled worker exit; 544.31 s; no reported timeout | `reviewer-admin-integration.log`           |
| `npm run build`                                                                                                       | PASS, exit 0                                                                                       | `reviewer-admin-build.log`                 |
| `npm audit --audit-level=high`                                                                                        | PASS, exit 0; 14 moderate vulnerabilities, none high/critical                                      | `reviewer-admin-audit.log`                 |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`                          | PASS, exit 0; `-- This is an empty migration.`                                                     | `reviewer-admin-migration-diff.log`        |
| `npx vitest run --config vitest.integration.config.ts test/notifications.integration.ts`                              | PASS, exit 0; 1/1 test/file; 13.56 s; isolated investigation of failed worker                      | `reviewer-admin-notifications-alone.log`   |
| Windows Application event query (IDs 1000/1001, preceding 25 minutes), runtime versions and unchanged-file comparison | No matching event; Node v24.15.0/npm 11.12.1; no notifications test diff; crash cause unresolved   | `reviewer-admin-worker-investigation.log`  |

Integration and its isolated rerun emitted `pg` deprecation warnings about calling `client.query()` while a query is executing. These are recorded, not treated as proof of the worker-exit cause. The builder's earlier five startup timeouts remain builder-reported failures with their supplied rerun evidence; this reviewer did not reproduce them and does not claim their cause is established. Unit and integration runs did not overlap.

Review-document verification: the initial `npx prettier --check docs/work/admin-user-search/review.md` failed on the newly appended table (`reviewer-admin-review-format.log`); `npx prettier --write docs/work/admin-user-search/review.md` passed (`reviewer-admin-review-format-write.log`), and the same check then passed (`reviewer-admin-review-format-recheck.log`). `git diff --check` passed (tool output).

Only this review document was edited among tracked files; check/investigation logs are ignored root-level artifacts. No implementation changes, commit or push were made.

Builder reply:

- C1-1: not reproduced. Before rerunning I rebased the item onto origin/main `0ecb999` (PR #61). The only conflicts were in `docs/backend-remaining-work.md` and `docs/roadmap.md`, and both sides were kept. No dev server was running, and the database container was healthy. The full integration run then passed: 44/44 files, 405/405 tests, 937 s, exit 0, no timeouts and no worker exit (`integration-r2.log`). The file and test counts are higher because PR #61 added tests. The crash in your run is still unexplained. Nothing in this item touches notifications or worker setup, and I found no cause, so I am recording it as unexplained, not as known flakiness. No code scope was added.
- C1-2: fixed in `README.md` "Finding accounts". The example is now `GET /api/v1/admin/users?page=1&pageSize=20`, and the filters are described separately. A separate bullet covers the 100-character limit (before trimming), `REQUEST_ERROR` for an empty query, `INVALID_USER_SEARCH` for one shorter than 2 characters after trimming, and `USE_CONTACT_LOOKUP`.
- C1-3: fixed. `docs/backend-remaining-work.md` now has an "Already implemented" entry. The rebase also moved PR #61's duplicate-submissions entry from "Current milestone" to "Already implemented".

Builder checks after the rebase, run in order: format, lint, db validate, migrate deploy, prisma generate and typecheck all passed (`checks-r2.log`). `npm test` passed 32/32 files and 507/507 tests (`unit-r2.log`). `npm run test:integration` passed 44/44 files and 405/405 tests (`integration-r2.log`). Build passed, and `npm audit --audit-level=high` found 14 moderate and no high vulnerabilities (`build-audit-r2.log`). The migration diff is empty (`migration-diff-r2.log`). Only docs changed since `e269b9b`, so the code is the same as in round 1.

## Code review, round 2

Verdict: CHANGES REQUESTED

- C2-1 [blocking] The required full unit check fails on startup child-process deadlines (`test/server-startup.test.ts:121-124,157`; spec "Docs and checks"). Initial `npm test` exited 1: 31/32 files and 502/507 tests passed; five hosted-credential startup cases reached their 45-second child deadline (`reviewer-r2-unit.log`, 262.44 s). The mandatory isolated rerun passed 1/1 file and 6/6 tests (`reviewer-r2-server-startup-alone.log`, 40.10 s). A subsequent unchanged full `npm test` again exited 1 with the same five deadline failures and 31/32 files, 502/507 tests passed (`reviewer-r2-unit-full-rerun.log`, 186.68 s). Obtain a successful full unit run and investigate the repeated suite-level deadline failures before approval. Do not treat the isolated pass as a full-suite pass or classify this as known flakiness. This file is unchanged by the item; any code fix outside this item needs the owner's scope decision.

Prior findings:

- C1-1 resolved for full-run verification: this reviewer's full integration run passed 44/44 files and 405/405 tests, exit 0, in 811.32 s, with no reported timeout or worker crash. The earlier notifications worker exit remains unexplained; a passing rerun does not establish its cause.
- C1-2 resolved: README "Finding accounts" now gives a valid default-listing URL, separates optional filters, states the pre-trim 100-character maximum and distinguishes empty-query schema errors from trimmed short-query errors.
- C1-3 resolved: the admin-search entry is present under "Already implemented".

Diff and investigation:

- Read AGENTS.md first and the round 1 Builder reply. Reviewed `git diff 0ecb999..HEAD` at HEAD `9429298` on parent `0ecb999`. `git range-diff e269b9b^..e269b9b 0ecb999..HEAD` confirms that the item's patch changed only README, remaining-work, roadmap and review documentation (`reviewer-r2-range-diff.log`). Direct comparison of the admin-users source/tests, app registration, Prisma schema and migration against `e269b9b` is empty. Other source/test differences between those commits belong to PR #61, not this item. No new blocking implementation defect found.
- Checked the conflict resolution against `0ecb999`: PR #61's complete duplicate-submissions description remains, moved from "Current milestone" to "Already implemented" with its PR number added. Its roadmap status and all other base content remain intact. No PR #61 source/test changes appear in this item's diff against its parent.
- Investigated the startup failures by reading the child-launch/deadline logic and assertion: the failures are `timedOut: true`, not expected credential-message mismatches. The beforeAll launches six cold child processes concurrently and kills each after 45 seconds. The unchanged-file comparison and runtime/memory snapshot are in `reviewer-r2-timeout-investigation.log` (Node v24.15.0, npm 11.12.1; 968,656 KiB free physical memory at the snapshot). The isolated pass and repeated full-suite failures are consistent with contention during concurrent startup, but do not prove the cause. No test timeout/configuration changes were made.
- Unit and integration suites never overlapped. Integration emitted `pg` query-concurrency deprecation warnings; they are not evidence of the earlier worker crash's cause. The full unit rerun was justified by the failed initial full run and isolated pass; it did not clear the failure.

Checks run (complete output in ignored repository-root logs):

| Command                                                                                      | Result                                                                                  | Log file                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `npm ci`                                                                                     | Skipped; package.json and package-lock.json unchanged versus `0ecb999`                  | `reviewer-r2-prerequisites.log` (empty package diff) |
| Docker running-state inspection and dev-process inspection                                   | PASS; `travel-buddy-postgres` running; no matching npm dev/tsx watch/server process     | `reviewer-r2-prerequisites.log`                      |
| `npm run format:check`                                                                       | PASS, exit 0                                                                            | `reviewer-r2-format.log`                             |
| `npm run lint`                                                                               | PASS, exit 0                                                                            | `reviewer-r2-lint.log`                               |
| `npm run db:validate`                                                                        | PASS, exit 0                                                                            | `reviewer-r2-db-validate.log`                        |
| `npm run db:migrate:deploy`                                                                  | PASS, exit 0; 41 migrations, none pending                                               | `reviewer-r2-db-deploy.log`                          |
| `npm run typecheck`                                                                          | PASS, exit 0                                                                            | `reviewer-r2-typecheck.log`                          |
| `npm test`                                                                                   | FAIL, exit 1; 31/32 files, 502/507 tests; five child deadlines, 262.44 s                | `reviewer-r2-unit.log`                               |
| `npx vitest run test/server-startup.test.ts`                                                 | PASS, exit 0; 1/1 file, 6/6 tests, 40.10 s; mandatory isolated rerun                    | `reviewer-r2-server-startup-alone.log`               |
| `npm run test:integration`                                                                   | PASS, exit 0; 44/44 files, 405/405 tests, 811.32 s; no reported timeout or worker crash | `reviewer-r2-integration.log`                        |
| `npm run build`                                                                              | PASS, exit 0                                                                            | `reviewer-r2-build.log`                              |
| `npm audit --audit-level=high`                                                               | PASS, exit 0; 14 moderate, no high/critical vulnerabilities                             | `reviewer-r2-audit.log`                              |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` | PASS, exit 0; `-- This is an empty migration.`                                          | `reviewer-r2-migration-diff.log`                     |
| `npm test` (full rerun after remaining checks)                                               | FAIL, exit 1; 31/32 files, 502/507 tests; same five child deadlines, 186.68 s           | `reviewer-r2-unit-full-rerun.log`                    |

Only this review document was edited among tracked files. No code changes, fetch, commit or push were performed.

Review-document verification: `npx prettier --write docs/work/admin-user-search/review.md` passed (`reviewer-r2-review-format-write.log`); `npx prettier --check docs/work/admin-user-search/review.md` passed (`reviewer-r2-review-format-check.log`); `git diff --check` passed (`reviewer-r2-diff-check.log`).

Builder reply:

- C2-1: investigated. The cause is now likely, though not proven: CPU contention while compiling with tsx, not a hang. Evidence on this 4-core machine, with the full suite not running:
  - one child with a bad credential exits 1 with the right message after 21 s cold and 8.4 s warm;
  - `tsx` alone starts in 0.6 s;
  - the built `dist/server.js` fails in 3.5 s;
  - six children started together, as the test's `beforeAll` does, take 26 s.

  Under `npm test` the other Vitest workers share the same cores, so the five cases that reach `server.ts` cross the fixed 45 s `childDeadline`. In your log they all hit it, giving a 45.48 s file time. The oversized case passes because `env.ts` rejects it before the heavy import graph loads. My first full run on this branch failed the same way, and my second passed 507/507. `test/server-startup.test.ts`, `src/server.ts` and their imports outside the new admin-users module are unchanged by this item. I did not run the full unit suite on `main` to confirm main fails too. No code was changed. A fix would touch `test/server-startup.test.ts` (item 28's test), which is outside this item, so I have asked the owner whether to fix it in a separate `fix/` item first or include it here.

Follow-up after the owner's decision on C2-1: the owner chose a separate fix item. `fix/server-startup-deadline` raised the child deadline to 120 s and the hook to `childDeadline + 30_000`, with no assertion changed. The Reviewer approved it and it merged as PR #63 (`09ee128`, confirmed with `git merge-base --is-ancestor`). This item was then rebased onto main `4dcf0ae`, which also contains PR #62, custom trip destinations.

- Rebase conflicts were in docs only: `docs/backend-remaining-work.md` and `docs/roadmap.md`. Both sides were kept. Admin search is back under "Current milestone", because main had no such section. The server-startup entry gained "PR #63", and its roadmap row is now "Done, PR #63".
- **Migration renamed** from `20261106120000_user_lookup_audit` to `20261107180000_user_lookup_audit`, with the SQL unchanged. PR #62's `20261107120000_custom_trip_destinations` merged first, and the old name sorted before it. On the shared local database, the applied row in `_prisma_migrations` was renamed to match, and `prisma migrate status` reports it up to date. This is recorded in plan.md "Changes from the plan".
- The owner confirmed that no other worktree was using the database during these runs.

Builder checks at `c66f718`, run in order, one after another:

- format, lint, db validate, migrate deploy, prisma generate and typecheck: all pass (`checks-r3.log`);
- migration diff: empty (`migration-diff-r3.log`);
- `npm test`: 32/32 files, 525/525 tests (`unit-r3.log`);
- `npm run test:integration`: 46/46 files, 448/448 tests, 352 s, no timeout or worker exit (`integration-r3.log`);
- build: pass; `npm audit --audit-level=high`: 14 moderate, no high (`build-audit-r3.log`).

## Code review, round 3

Verdict: APPROVED

No C3 findings. C2-1 is resolved for this item: the owner's separate startup-deadline fix is present from PR #63, and this reviewer's full unit suite passed 525/525. The earlier deadline failures and worker exit remain recorded above; this successful run does not establish their causes.

Review scope and evidence:

- Read `AGENTS.md` first and the Builder's round 2 follow-up. Reviewed `git diff 4dcf0ae..HEAD` at `22b2c1cf934a9ab23d2df511421820bb4f387680` on `feature/admin-user-search` (`reviewer-r3-item-diff.log`). `git range-diff da402b0^..da402b0 4dcf0ae..HEAD` confirms the patch changed only the rebase documentation, plan/review follow-up and migration path (`reviewer-r3-range-diff.log`). Direct comparison of the admin-users source and tests is empty (`reviewer-r3-code-comparison.log`). The app registration is identical; the schema differences from the old commit are exclusively PR #62's Trip fields (`reviewer-r3-base-compatibility.log`).
- The renamed `20261107180000_user_lookup_audit` SQL is identical to the old `20261106120000_user_lookup_audit` SQL (`reviewer-r3-migration-comparison.log`). It sorts after PR #62's `20261107120000_custom_trip_destinations`. Its additive moderation enum value is independent of that migration's Trip columns and destination constraint. Deploy reports no pending migrations and the live schema diff is empty. No database migration history was modified by this reviewer.
- Checked the documentation conflict resolution against `4dcf0ae`: all PR #62 content is retained; PR #63's description is retained with its PR number added and roadmap status updated to Done. Only the admin-search entries are added. PR #62's moderation repository, custom-destination migration and PR #63's startup test are unchanged from the base (`reviewer-r3-base-preservation.log`). The user-summary select reads no Trip fields; the moderation-action list remains unfiltered by action type and accepts the additive enum value. No conflicting response-schema or enum change found.
- All required checks passed in order. Unit and integration never overlapped. Neither suite reported a timeout or worker crash, so no isolated failure rerun was needed. Integration emitted `pg` query-concurrency deprecation warnings; they are recorded in the full log and are not evidence of an earlier crash's cause.

Checks (complete output in ignored repository-root logs):

| Command                                                                                      | Result                                                      | Log file                              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| Docker running-state and Node process inspection                                             | PASS; database running; no dev server                       | `reviewer-r3-prerequisites.log`       |
| `npm ci`                                                                                     | Skipped; package files unchanged versus `4dcf0ae`           | `reviewer-r3-prerequisites.log`       |
| `npm run format:check`                                                                       | PASS, exit 0                                                | `reviewer-r3-format.log`              |
| `npm run lint`                                                                               | PASS, exit 0                                                | `reviewer-r3-lint.log`                |
| `npm run db:validate`                                                                        | PASS, exit 0                                                | `reviewer-r3-db-validate.log`         |
| `npm run db:migrate:deploy`                                                                  | PASS, exit 0; 42 migrations, none pending                   | `reviewer-r3-db-deploy.log`           |
| `npm run typecheck`                                                                          | PASS, exit 0                                                | `reviewer-r3-typecheck.log`           |
| `npm test`                                                                                   | PASS, exit 0; 32 files, 525/525 tests; 83.62 s              | `reviewer-r3-unit.log`                |
| `npm run test:integration`                                                                   | PASS, exit 0; 46 files, 448/448 tests; 348.70 s             | `reviewer-r3-integration.log`         |
| `npm run build`                                                                              | PASS, exit 0                                                | `reviewer-r3-build.log`               |
| `npm audit --audit-level=high`                                                               | PASS, exit 0; 14 moderate, no high/critical vulnerabilities | `reviewer-r3-audit.log`               |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` | PASS, exit 0; empty migration                               | `reviewer-r3-migration-diff.log`      |
| `npx prettier --write docs/work/admin-user-search/review.md`                                 | PASS, exit 0                                                | `reviewer-r3-review-format-write.log` |
| `npx prettier --check docs/work/admin-user-search/review.md`                                 | PASS, exit 0                                                | `reviewer-r3-review-format-check.log` |
| `git diff --check`                                                                           | PASS, exit 0                                                | `reviewer-r3-diff-check.log`          |

Only this review document was edited among tracked files; verification logs are ignored root-level artifacts. No implementation edits, fetch, commit or push were performed. No blocking disagreement remains for owner adjudication.
