# Review: staff role management

## Spec review, round 1

Verdict: CHANGES REQUESTED

- S1-1 [blocking] **Guard the grant's active-status requirement at write time.**
  In spec.md "Rules, in order", rule 5 requires an ACTIVE target, but rule 7
  specifies a compare-and-set on only `id` and `staffRole`. A concurrent
  suspension or deletion request can commit after the read and before the
  grant, leaving a non-active account newly promoted. Require `status: ACTIVE`
  in the grant's atomic update predicate as well, with
  `409 USER_STATE_CHANGED` on a lost race. Add an acceptance criterion that
  changes status between the read and update and verifies no role change or
  audit row. The existing `suspendUser` predicate in
  `moderation.repository.ts` is a useful precedent.
- S1-2 [blocking] **Define safe concurrency for D2 before introducing report
  requeueing.** In spec.md "Revoking a moderator with reports in review", the
  proposed reset introduces a race absent from the current report lifecycle.
  `resolveReport` reads ownership, then updates using only report ID and
  `status: UNDER_REVIEW` (`moderation.repository.ts`, `resolveReport`). An old
  moderator's already-authorized resolve can pause after its read; revoke can
  release the report; another moderator can claim it; then the old resolve
  can update the new claim and enforce a decision. An already-authorized
  `startReportReview` can also commit a new claim after the revoke's release
  sweep, stranding a report again. Specify serialization or equivalent
  write-time authorization and claim-identity checks for these interleavings,
  and expand scope to the existing report operations if retaining D2. Add
  deterministic acceptance tests for revoke versus claim, revoke versus
  resolution, and release/reclaim versus a stale resolution; resolved reports
  must remain resolved and failed operations must leave no enforcement or
  audit side effects. Alternatively defer automatic release and keep the
  existing administrator override. Fresh checks do reject requests authorized
  after revocation commits; they do not cancel requests already authorized.
- S1-3 [blocking] **Audit the report releases themselves.** In spec.md "Audit",
  D2 and "Data", the sole new audit row targets the staff account and contains
  only the supplied reason; `releasedReportCount` exists only in the response.
  Preserving old `REPORT_CLAIMED` rows proves that claims happened, but does
  not record which reports were released, when, by whom, or why their state
  returned to SUBMITTED. Require durable report-linked release events in the
  same transaction, attributable to the revoking administrator and role
  revocation, or an equivalent explicit audit representation. Update the
  exactly-one-row criterion and migration decision as needed, and test
  rollback of both releases and the role change if any audit write fails.
  This is a material moderation transition under PRD §18 auditability.
- S1-4 [suggestion] **Qualify the revocation error acceptance criterion.** The
  criterion says revoking a moderator, including a suspended one, makes their
  next staff request return `403 STAFF_ONLY`. `staffIdentity` first invokes
  `authenticateRequest`, which rejects suspended accounts with
  `403 ACCOUNT_SUSPENDED` before `requireStaff` runs. Specify `STAFF_ONLY` for
  an otherwise ACTIVE revoked moderator and retain the existing account-state
  errors for suspended, pending-deletion and deleted callers. Test those
  outcomes separately.

### Other conclusions and verification

- Read AGENTS.md, the full spec, the supplied PRD text extract (including
  §14 FR-15, §15.1, §16 and §18), both staff CLI scripts, moderation routes,
  repository and shared protections, Prisma report/audit models, admin-user
  routes and repository, and the relevant README and status-document diffs.
- D1 is sound: ADMIN input rejection, protected ADMIN targets and self-change
  prevention limit escalation. D3 and D4 are reasonable owner choices. The
  rate limit limits throughput; a stolen admin token can still create many
  moderators over time. Fresh Firebase and database role checks support the
  next-request access guarantee, subject to the in-flight distinction above.
- No-op success without another audit row is reasonable for sequential
  retries. A role race may return `USER_STATE_CHANGED` before a retry observes
  the requested role; the concurrency test should explicitly force the race
  between the read and write. Existing error-code reuse is otherwise suitable.
  Existing enum values support the role-only change without a migration;
  retaining D2 requires resolving S1-3's audit representation first.
- The PR #64 status updates are accurate against this checkout: local HEAD
  `99966f1` is the merge of PR #64 and contains the admin-user implementation.
  No fetch was performed. Removing the completed milestone is reasonable;
  the next milestone can be recorded when this item's scope is approved.
- Prettier check of this review file: initial run failed on Markdown
  formatting; corrected the command's inline-code wrapping and reran: PASS.
  Application checks were not run: this is a spec-only review. Only this
  review file was created; no commit, push or fetch was performed.

Builder reply:

- S1-1 fixed in spec.md "Rules, in order", rule 7. The grant's update predicate is now `{ id, staffRole: 'USER', status: 'ACTIVE' }`; a lost race gives `409 USER_STATE_CHANGED` with no change and no audit row. The acceptance criterion now covers a status change (suspension) between the read and the update, as well as role changes.
- S1-2 and S1-3 resolved by dropping automatic release. Revoking no longer touches reports. The response reports `claimedReportCount`, the moderator's `UNDER_REVIEW` reports, read only, and administrators resolve those with the existing `ADMIN` override in `resolveReport`. This removes the new races (revoke against claim, revoke against resolve, and stale resolve after a reclaim) and the need for report-linked release events. Safe automatic release is listed as a deferred item, because it needs write-time ownership checks in the report operations and its own audit event. D2 now recommends this. The residual risk that already exists is stated in the spec: a staff request that passed its role check just before a revoke commits can still finish, on every staff route.
- S1-4 fixed. An active revoked moderator gets `403 STAFF_ONLY`; a suspended one keeps getting `403 ACCOUNT_SUSPENDED`.

## Spec review, round 2

Verdict: APPROVED

- S2-1 [suggestion] **Clarify the informational count on retries and under
  concurrency.** In spec.md "Reports a revoked moderator had claimed (D2)",
  define `claimedReportCount` for a no-op `role: USER` request explicitly
  (recommended: run the same read-only count, even when `changed: false`).
  Also say that it reflects the count query's snapshot, rather than a promise
  about the reports at transaction commit or response delivery. An in-flight
  claim or administrator resolution can change that number independently of
  the role transaction. The current informational wording and acknowledged
  in-flight risk make this nonblocking. The grant value of `0` is an explicit
  response convention, not a guarantee that no historical claims exist.

### Round 1 resolution and verification

- S1-1 resolved: rule 7 now includes `status: ACTIVE` in the grant's atomic
  predicate; the acceptance criteria cover a suspension between read and
  update, a conflict response and absence of role/audit side effects.
- S1-2 resolved by deferral: revoke performs no report writes. Proposed
  behaviour, privacy/audit text, out of scope, acceptance criteria and D2
  consistently retain claims and defer automatic release. The existing
  in-flight authorization limitation is explicit. No new report lifecycle
  race is introduced by a read-only count.
- S1-3 resolved by deferral: there is no report transition to audit. Exactly
  one actor-attributed role action, atomic with each actual role change, and
  no audit action for a no-op remain consistent throughout the spec. No new
  audit gap was found within this scope.
- S1-4 resolved: the acceptance criterion distinguishes active revoked
  moderators (`STAFF_ONLY`) from suspended ones (`ACCOUNT_SUSPENDED`). This
  matches `staffIdentity` and `authenticateRequest`; pending-deletion and
  deleted callers retain their existing account-state checks.
- Verified the administrator override in `resolveReport` in
  `src/modules/moderation/moderation.repository.ts`: the ownership rejection
  explicitly excludes `ADMIN`. Any existing `UNDER_REVIEW` report can be
  dismissed by an administrator regardless of reviewer; enforcement choices
  still have their normal target/action validations. The route passes the
  freshly checked staff role into that repository operation.
- A count filtered by `status: UNDER_REVIEW` and `reviewerId: target`, read
  after the update in the same transaction, is well defined as an
  informational observation. The database client sets no custom transaction
  isolation. Sharing the transaction does not freeze independently changing
  reports through commit; no such guarantee is needed for the revised scope.
- Read AGENTS.md, the full revised spec and round 1 Builder reply, the
  moderation repository and relevant routes, authentication checks, database
  client and package scripts. Confirmed the requested branch with a read-only
  Git command. Two `rg` searches included nonexistent service/auth paths;
  inspected the actual module paths instead. No application checks were run
  for this spec-only review. Only this review file was edited; no commit,
  push or fetch was performed.
- Prettier check of `docs/work/staff-role-management/review.md`: PASS.

Builder reply: S2-1 accepted. `claimedReportCount` is now computed on every `200`, including grants and `changed: false` repeats, by the same read-only query. The spec calls it a snapshot from that query, not a guarantee at commit or delivery. The fixed "always 0 on a grant" rule is gone, because a former moderator can still hold old claims.

## Plan review, round 1

Verdict: CHANGES REQUESTED

- P1-1 [blocking] **Make the trimmed-reason test independent of the database.**
  In plan.md "Unit", a fake role repository and token verifier do not let a
  schema-valid, whitespace-padded reason reach `cleanReason` without database
  access. The handler first calls `staffIdentity`: `authenticateRequest` uses
  the auth repository, and `requireStaff` queries the global database client
  directly (`moderation.routes.ts:102` and `moderation.repository.ts:62`).
  Keep schema-invalid requests in the database-free route tests, and move the
  trimmed-reason route case into integration tests; alternatively document
  explicit mocks for both authentication reads. A direct `cleanReason` unit
  test is also possible, but does not replace checking the route's error.
- P1-2 [blocking] **Budget all integration requests against the route limit.**
  In plan.md "Integration" and "Isolation", only the explicit limit test has
  its own administrator. The ordinary admin already makes at least eleven
  main-app POSTs across targets (3), grant (1), blocked grants (3), revokes
  (2) and repeats (2), before the claims case or additional header checks.
  Requests rejected by the handler still consume the route's limit. Later
  assertions will therefore see `429` instead of their expected results.
  Allocate distinct admin callers per group, or fresh app instances with
  separate stores, and account for every POST, including validation failures.
  Preserve the real limit and the dedicated 10-success/11th-429 case; do not
  depend on elapsed wall time or sleeps.
- P1-3 [blocking] **Exercise an actual audit-write failure.** In plan.md
  "Integration", case 8 throws from `afterUpdate` before the audit insert is
  attempted. This establishes transaction rollback after a role update, but
  does not establish the spec's audit-write-failure criterion: an implementation
  that catches an insert error and commits the role could still pass this
  test. Add a deterministic failure at `moderationAction.create`, such as a
  repository-level call using a nonexistent actor ID to violate the audit
  foreign key, then assert rejection, unchanged role and no audit row. Keep
  the hook rollback test if useful; a repository-level failure need not claim
  an HTTP `500` assertion unless it is exercised through the route.
- P1-4 [suggestion] **Cover the revised count semantics with nonzero values.**
  The repository steps correctly count on every success, but the proposed
  grant and repeat fixtures only demonstrate zero. Add a repeated revoke on
  `modWithClaims` before resolving its report, plus a grant back to that USER
  while claims remain. Both should report the remaining nonzero count;
  the repeat should write no audit row. This catches the old fixed-zero grant
  convention and no-op early returns addressed by S2-1.

### Design conclusions and verification

- The new module, dependency override, scoped `onSend` hook and app
  registration fit the existing admin-users pattern. The reused moderation
  exports exist, and the proposed response schema includes all four fields.
  The existing protected-target message and error-code conventions match.
- Repository ordering matches the approved spec: existence, self/ADMIN
  protection, no-op, grant status check, atomic predicate, audit and count.
  Grant checks both USER and ACTIVE at write time; revoke checks MODERATOR
  without restricting status. The audit insert and every success count are
  inside the transaction. No migration or report write is required.
- The `afterRead` race design is deterministic when each callback awaits the
  global-client update's commit before returning. At READ COMMITTED the
  preceding ordinary SELECT holds no row lock that conflicts with that
  update, so this sequence does not inherently deadlock. Use a separate pool
  connection, sequential cases and reset hooks after each case. Do not move
  a global update of the same row into `afterUpdate`, where the transaction
  would already hold its write lock. The production client specifies no
  custom transaction isolation or single-connection pool limit.
- Fixture cleanup order is correct: moderation actions, then reports, then
  users satisfies the actor, report, reviewer and reporter foreign keys.
  Include the reporter and all reported targets among owned fixture IDs,
  close both apps, and use DISMISS for the administrator-override check to
  avoid unrelated enforcement side effects. `resolveReport` explicitly
  permits ADMIN to resolve another reviewer's UNDER_REVIEW report.
- Docs and risks fit the approved scope. During build, add the required
  "Changes from the plan" section and record all AGENTS.md checks, complete
  test logs and the empty migration diff; the plan currently does not list
  a full verification sequence. No application checks were run for this
  plan-only review.
- Read AGENTS.md, the approved spec, plan and prior review; inspected the
  admin-users layout and tests, moderation routes/repository/protections,
  authentication, database client, Prisma foreign keys, app registration,
  package scripts and Vitest configs. Initial reads used several nonexistent
  singular/shared paths; located and inspected the actual files instead.
  Confirmed `feature/staff-role-management` using read-only Git commands.
  Only review.md was edited; no commit, push or fetch was performed.
- Prettier check of `docs/work/staff-role-management/review.md`: PASS.

Builder reply:

- P1-1 fixed in plan.md "Unit". The unit file keeps only the schema rejections, which fail before the handler and need no database. The trimmed-reason case is now an integration case, under case 2.
- P1-2 fixed in plan.md "Integration" and "Isolation". Each group of cases has its own administrator caller:
  - `adminAuth`: 4 POSTs;
  - `adminGrant`: 5;
  - `adminRevoke`: 3;
  - `adminRace`: 3;
  - `adminClaims`: 5;
  - `adminHeaders`: 4;
  - `rateAdmin`: 11, the limit case only.

  Validation failures are counted, so every group stays under 10. The real limit is kept, and nothing waits on wall-clock time. Each case's comment names its caller.

- P1-3 fixed. Case 8 is now a real audit-insert failure: a direct repository call whose `actorId` matches no account. The role update runs, `moderationAction.create` fails on the foreign key (`P2003`), and the test asserts a rejection, an unchanged role and no audit row. This is the same technique admin search used. The `afterUpdate` hook is removed; only `afterRead` remains, for the race cases.
- P1-4 accepted, in case 10:
  - a repeated revoke on `modWithClaims` gives the same nonzero count, with no audit row;
  - a grant back while its claims remain gives the nonzero count, then it is revoked again;
  - after an administrator resolves one report, a repeated revoke reports one fewer.

## Plan review, round 2

Verdict: APPROVED

No new findings. P1-1 through P1-4 are resolved.

### Round 1 resolution and verification

- P1-1: the database-free unit cases now fail schema validation before the
  handler. The trimmed-reason case moved to integration case 2, where the
  authentication and staff database reads are available.
- P1-2: independently counted every assigned POST. `adminAuth` makes four
  in case 2; case 1 uses no token, the revoked token, the ordinary user and
  the moderator, rather than that administrator. `adminGrant` makes five
  (grant, three blocked grants, repeat); `adminRevoke` makes three (two
  revokes, repeat); `adminRace` makes three; `adminHeaders` makes four.
  `adminClaims` makes five staff-role POSTs (revoke, repeat, grant, revoke,
  repeat), plus one report-resolution POST: six total. The Builder reply's
  five counts the staff-role requests only. The audit checks use GETs, and
  case 8 calls the repository directly. Every ordinary administrator stays
  below ten even counting the resolution; only the dedicated `rateAdmin`
  intentionally sends eleven. Separate callers and sequential race cases
  remove the earlier budget problem without sleeps or relaxed limits.
- P1-3: case 8 uses an existing ACTIVE USER target and a distinct nonexistent
  actor, so neither target protection nor the grant predicate prevents the
  update. The planned order awaits `updateMany` before inserting the audit
  row inside the same interactive transaction. In `prisma/schema.prisma:997`,
  `ModerationAction.actor` references `User.id` through `actorId` with
  `onDelete: Restrict`; the migration also defines
  `moderation_actions_actor_id_fkey`. Nullable actor IDs permit NULL, not a
  non-null UUID absent from users. That insert therefore exercises the real
  foreign-key failure (`P2003`) after the role update. Propagating the error
  rolls back the transaction; rejection, unchanged USER role and absence of
  an audit row are the right assertions. This is a planned test, not a test
  executed during this review.
- Removing `afterUpdate` leaves no unexplained dependency: the real insert
  failure replaces its rollback test, while the sole remaining `afterRead`
  hook supports all three deterministic compare-and-set race cases. The
  revised plan contains no remaining `afterUpdate` reference.
- P1-4: case 10 now covers a nonzero count on a no-op revoke and on a grant
  back. Its sequence is coherent: revocation leaves claims untouched; a
  repeat skips the update and audit but still counts; the ACTIVE former
  moderator can be granted back and revoked again. The administrator can
  then resolve a report despite its retained reviewer ID because
  `resolveReport` explicitly exempts ADMIN from its ownership rejection
  (`moderation.repository.ts:594`). DISMISS remains the simple resolution
  recommended in round 1. Resolution removes one report from UNDER_REVIEW,
  so the final no-op revoke returns one fewer without a new role audit row.
- Read AGENTS.md, the revised plan, approved spec and Builder replies;
  checked the Prisma relation and migration, report resolution repository
  and route, rate-limit registration/key generation, database client and
  existing admin-search audit-failure test. Confirmed the requested branch
  with read-only Git commands. An initial lookup used two nonexistent paths;
  located and read the actual files instead. No application checks were run
  for this plan-only review. Only this review file was edited; no commit,
  push or fetch was performed.
- Prettier check of `docs/work/staff-role-management/review.md`: PASS.

## Code review, round 1

Verdict: APPROVED

- C1-1 [suggestion] **Align the spec with the documented unknown-field behaviour.**
  In spec.md "Acceptance criteria" (line 183), unknown fields still promise
  `400`, whereas plan.md "Changes from the plan" correctly records that the
  app strips them. The integration grant includes `notify: true` and succeeds.
  Update that criterion to say unknown fields are ignored. This deviation is
  acceptable: it follows the existing validator configuration, the handler
  explicitly forwards only the four supported repository inputs, and neither
  extra fields nor an `ADMIN` role can expand privileges. The deviation is
  clearly documented in the required plan section; the stale original
  criterion is a nonblocking documentation inconsistency.

### Security, correctness and acceptance coverage

- Reviewed `99966f1..HEAD`, with HEAD `b70bb3f`, against the approved spec,
  plan, prior review resolutions and "Changes from the plan". No blocking
  implementation findings. README "Staff roles" matches the API, protected
  targets, errors, audit atomicity, retained claims, next-request access,
  rate limit and cache policy. Roadmap and remaining-work status are updated.
- Schema validation and rate limiting precede the handler, as elsewhere in
  the app. For schema-valid requests the handler performs fresh Firebase and
  active-account authentication, database staff authorization, then
  administrator authorization before cleaning the reason or accessing the
  target. The repository checks existence, self/ADMIN protection, no-op,
  then grant status. Protection cannot be bypassed by requesting the current
  role. The grant predicate repeats USER and ACTIVE; revoke repeats
  MODERATOR without restricting status. Both reject a lost race before audit.
- Role update, actor-attributed audit insert and report count share one
  transaction. Errors propagate and roll back the update. No-op requests
  omit audit but still count. The count filters by target reviewer and
  UNDER_REVIEW on grants, revokes and repeats; it is informational and does
  not freeze reports through commit. No report writes or notifications were
  added. Already-authorized requests retain the documented in-flight risk.
- All four response fields have explicit schemas, with a nonnegative integer
  count. The scoped onSend hook covers success and error replies including
  validation and rate-limit errors. The route sets 10 requests per minute;
  the shared key generator verifies token identity and keys by account
  subject, with IP fallback for unauthenticated requests.
- `afterRead` has no HTTP, environment or production startup configuration
  path. The production singleton calls `createStaffRoleRepository()` without
  hooks; only integration tests construct a hooked repository through code
  dependency injection. Production startup supplies no repository override.
  The exported factory permits trusted application code to inject callbacks,
  as designed; it does not expose a remotely configurable hook.
- Unit tests cover ADMIN/unknown/missing roles, missing/short reasons and
  invalid UUIDs before the repository. Integration covers authentication,
  fresh revoked-token rejection, target protections, trimmed reason, grants,
  all three blocked grant statuses, active and suspended revokes,
  next-request permissions, idempotency, cleaned attributed audits and audit
  visibility. Exact successful response assertions also check minimisation.
- Random UUID fixtures own every account and report. Cleanup deletes audit
  rows by owned actors/targets, then reports and users, and closes both apps.
  Each request group has its own administrator: ordinary staff-role POST
  budgets are 4/5/3/3/5/4; rateAdmin alone sends 11. The claims administrator
  also resolves one report on its separate route. No sleeps or relaxed limits
  are used, and race hooks reset after each case.
- All three race cases await another connection's committed role/status
  change between SELECT and update, and assert conflict, preserved competing
  state and no role audit. The audit-failure case uses a nonexistent actor to
  trigger a real P2003 foreign-key failure after the update, then checks role
  rollback and no audit. Claims fixtures include another reviewer, exercise
  nonzero revoke/repeat/grant counts, preserve status/reviewer/reviewedAt,
  and demonstrate administrator resolution followed by a reduced count.

### Checks and evidence

All required commands ran sequentially in AGENTS.md order, without overlapping
unit and integration suites. Every command below exited 0. Log paths are
repository-root relative. `npm ci` was skipped because neither package file
changed. The container was already running; no application dev server was
running (only unrelated Node host processes).

| Check                                                                                        | Result                                                       | Complete output log                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Container and Node process preflight                                                         | PASS: PostgreSQL running; no dev server                      | `reviewer-srm-20261107-173424-preflight.log`       |
| `npm run format:check`                                                                       | PASS                                                         | `reviewer-srm-20261107-173424-format.log`          |
| `npm run lint`                                                                               | PASS                                                         | `reviewer-srm-20261107-173424-lint.log`            |
| `npm run db:validate`                                                                        | PASS                                                         | `reviewer-srm-20261107-173424-db-validate.log`     |
| `npm run db:migrate:deploy`                                                                  | PASS: 42 migrations, none pending                            | `reviewer-srm-20261107-173424-db-deploy.log`       |
| `npm run typecheck`                                                                          | PASS                                                         | `reviewer-srm-20261107-173424-typecheck.log`       |
| `npm test`                                                                                   | PASS: 33/33 files, 532/532 tests                             | `reviewer-srm-20261107-173424-unit.log`            |
| `npm run test:integration`                                                                   | PASS: 47/47 files, 471/471 tests                             | `reviewer-srm-20261107-173424-integration.log`     |
| `npm run build`                                                                              | PASS                                                         | `reviewer-srm-20261107-173424-build.log`           |
| `npm audit --audit-level=high`                                                               | PASS: 14 moderate vulnerabilities, no high/critical reported | `reviewer-srm-20261107-173424-audit.log`           |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` | PASS: empty migration                                        | `reviewer-srm-20261107-173424-migration-diff.log`  |
| `git diff --check 99966f1..HEAD`                                                             | PASS                                                         | `reviewer-srm-20261107-173424-diff-check.log`      |
| Prettier formatting and check of this review                                                 | PASS                                                         | `reviewer-srm-20261107-173424-review-prettier.log` |

No test/hook timeout or worker crash occurred, so no isolated failure rerun
was required. Integration emitted PostgreSQL driver deprecation warnings
about concurrent client.query calls; all tests passed. Dependency remediation
is outside this item. Prisma informational stderr is represented by
PowerShell NativeCommandError wrappers in some logs; the Prisma commands
completed successfully with exit 0 and their success output is preserved.
The Builder's standalone and mutation results were supplied as background;
this review independently reran both full suites, not the mutation experiment.
Only this review file was edited, alongside the requested ignored root logs
and normal generated check artifacts. No commit, push or fetch was performed.

Builder reply: C1-1 accepted. The spec's acceptance criterion now says that `role: ADMIN` is rejected with `400`, and that unknown fields are dropped and have no effect, citing plan.md "Changes from the plan". No code changed.
