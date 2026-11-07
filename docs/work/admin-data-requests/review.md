# Review: admin actions on data requests

## Spec review, round 1

Verdict: CHANGES REQUESTED

- S1-1 [blocking] Spec "Audit" and D2 do not identify which request an audit
  note belongs to. The action targets the user, while `completedById` identifies
  only the administrator. `ModerationAction` has no data-request reference
  (`prisma/schema.prisma`, model `ModerationAction`). The same administrator can
  complete successive ACCESS requests for the same user, so finding the note
  still requires matching account, actor and time, contrary to D2's stated
  benefit. Specify a durable, unambiguous request-to-action link, its migration
  and API visibility, and an acceptance test with two requests completed by the
  same administrator. Keeping `targetType: USER` is compatible with adding a
  separate reference; user responses and exports must continue to exclude the
  internal audit details.
- S1-2 [suggestion] Spec "Proposed behaviour" and "Acceptance criteria" should
  explicitly confirm that completing ACCESS permits a new OPEN ACCESS request.
  `createDataRequest` reuses only OPEN rows, and
  `account_data_requests_one_open_per_type_idx` is partial on `status = 'OPEN'`.
  Recommend preserving this behaviour and testing that the new request has a
  different ID, the old completion remains unchanged, and replaying completion
  of the old request does not affect the new one.
- S1-3 [suggestion] Expand the race acceptance criteria to cover completion
  winning before the user's cancel, plus completion of ACCESS alongside erasure
  of the same user's deletion request. The existing cancel is itself conditional
  on OPEN and returns the current row, so the expected first result is a 200
  cancellation response still showing COMPLETED, with completion attribution
  intact. The worker selects only ACCOUNT_DELETION and does not update ACCESS;
  the second case should leave both requests COMPLETED and the account DELETED.
  Also include the explicitly supported already-DELETED account in the account
  state acceptance criterion.

Review evidence:

- Read `AGENTS.md`, the supplied PRD extract (sections 8.3, 14 FR-15 and 18),
  the spec, data-request routes/repository, erasure worker, export selection,
  Prisma models and relevant migrations, moderation reason validation and audit
  access, and README "Account data requests and deletion".
- The ACCESS completion gap is real. D4's recommendation to leave deletion
  automatic fits the existing worker and PRD; no additional deletion admin
  action is required by those sources.
- The proposed fresh authentication, staff/admin gates, conditional update and
  transactional audit fit the existing implementation. The nullable attribution
  CHECK permits FK SET NULL and existing worker completions. Separate admin-note
  validation is reasonable: its trim/minimum behaviour follows `cleanReason`,
  while the dedicated code names the new field. The schema/service split for
  REQUEST_ERROR versus INVALID_ADMIN_NOTE is specified in the acceptance criteria.
- The export currently omits `completedAt`; adding it without staff identities
  or internal notes is consistent with the existing explicit export selection.
- Reviewed both uncommitted status-document diffs. Local history identifies
  `5930ab8` as the merge of PR #65, so marking staff role management done is
  supported. No fetch was performed.
- `git diff --check`: passed before creating this review. Full application/DB
  checks were not run for this spec-only review.

Builder reply:

- S1-1 fixed in spec.md "Audit", "Data", "Admin list" and D2.
  - The `completedById` column on the request is gone. Instead, `moderation_actions` gains a nullable `data_request_id` foreign key to `account_data_requests` (`ON DELETE RESTRICT`, like `report_id`), with these database rules:
    - two CHECKs: the column is only set on `DATA_REQUEST_COMPLETED` rows (with target type `USER`), and those rows always have it;
    - a partial unique index: one completion row per request.
  - The admin list derives `completedById` and `completionActionId` from that row. `GET /admin/moderation-actions` returns `dataRequestId`, because that route has no response schema.
  - User responses and the export expose none of these.
  - It is two migrations, because PostgreSQL cannot use a new enum value in the transaction that adds it, and the CHECKs use it.
  - New acceptance criterion: two requests from one user, completed by the same administrator, each have their own linked audit row. There are also database-rule tests by direct insert.
- S1-2 accepted: "A new request after completion" is documented as intended, and tested with a new ID, an untouched old completion, and a repeated old completion leaving the new request `OPEN`.
- S1-3 accepted: the race criteria now include completion winning before the user's cancel (the cancel returns `200` with `COMPLETED`, attribution intact), and completion after the same user's deletion was erased by the worker (both requests `COMPLETED`, the account `DELETED`). The account-state criterion includes deleted accounts.

## Spec review, round 2

Verdict: APPROVED

- S2-1 [suggestion] Spec "Acceptance criteria", database-rule tests: also
  insert a `DATA_REQUEST_COMPLETED` action with a valid `data_request_id` but
  a non-USER `target_type`, and assert rejection. The first CHECK correctly
  rejects it, but the listed negative tests do not exercise that branch.

Round-1 resolution:

- S1-1 resolved: the audit row now references the specific request, with a
  foreign key and uniqueness. Admin responses derive attribution and the
  action ID from that link; the two-successive-requests criterion proves
  disambiguation. User responses and exports exclude the internal fields.
- S1-2 resolved: new ACCESS requests after completion and replay isolation
  are explicit in both behaviour and acceptance criteria.
- S1-3 resolved: cancellation after completion, erasure alongside an open
  ACCESS request, and already-DELETED accounts are explicitly covered and
  agree with the existing repository and worker.

Review evidence:

- Read `AGENTS.md`, the revised spec and Builder reply, Prisma models and
  relevant migration history, data-request repository, moderation route and
  repository, and the complete account-erasure worker including its purge.
- The two CHECKs are complementary: with existing NOT NULL `action` and
  `target_type`, a non-null link requires DATA_REQUEST_COMPLETED and USER;
  that action in turn requires a non-null link. There is no SQL NULL escape.
  Existing action rows with null links satisfy both CHECKs.
- The partial unique index on non-null links enforces one completion per
  request. The FK points from the audit row to the request, so RESTRICT
  prevents deleting a referenced request, rather than preventing audit-row
  deletion. The existing nullable `report_id` FK and its nonunique index
  impose no incompatible rule; the USER target uses the existing target
  index normally. Neither CHECK claims to enforce request ownership or type
  across tables; those remain the completion transaction's responsibility.
- Adding the enum value first and using it in a subsequent migration is
  valid provided the first migration commits before the second starts; do
  not wrap both in one transaction. Verified against PostgreSQL 17
  [ALTER TYPE](https://www.postgresql.org/docs/17/sql-altertype.html),
  [constraints](https://www.postgresql.org/docs/17/ddl-constraints.html) and
  [partial indexes](https://www.postgresql.org/docs/17/indexes-partial.html).
- `moderation.routes.ts` has no response schema for the audit endpoint;
  `listModerationActions` uses `findMany` without select/omit and returns the
  rows directly. A generated Prisma scalar `dataRequestId` will be returned.
- `cancelDataRequest` conditionally updates only OPEN rows, then reads the
  current request. A winning completion therefore survives cancellation.
  The erasure batch selects ACCOUNT_DELETION only and updates that request;
  it does not delete requests, modify ACCESS requests or delete audit rows.
  It retains the user row. The one-year purge only nulls moderation evidence
  keys and clears other retained text; it changes neither action/link/target
  nor request rows. Neither path conflicts with the proposed FK or CHECKs,
  and completion notes and links survive the existing purge.
- Confirmed branch `feature/admin-data-requests`. `git diff --check` passed
  before this append. An initial search named nonexistent `src/workers` and
  `src/modules/users` directories and exited 1; subsequent searches located
  and read the actual modules. No application tests or database migrations
  were run for this spec-only review; PostgreSQL validation here is static.

Builder reply: S2-1 accepted. The database-rule criterion now also rejects a `DATA_REQUEST_COMPLETED` row that has a valid request link but a target type other than `USER`.

## Plan review, round 1

Verdict: APPROVED

- P1-1 [suggestion] Plan "Migration": remove the fallback that merely records
  a diff attempting to drop the partial index. AGENTS.md "Migrations" and
  the approved spec require an empty final diff. The existing SQL-only
  partial indexes and CHECKs already coexist with an empty diff in this
  checkout, so a nonempty post-build diff should be investigated and resolved
  before code approval, rather than accepted as an expected exception.
- P1-2 [suggestion] Plan "Tests", Alice fixtures and cases 5-6: explicitly
  create successive ACCESS requests only after completing the preceding one,
  and use case 5's newly created request as case 6's second completion (or
  close it before creating another). Seeding two OPEN ACCESS requests for
  Alice would violate `account_data_requests_one_open_per_type_idx`; the
  intended sequential test covers both acceptance criteria without that
  fixture conflict.

Review evidence:

- Read AGENTS.md first, the approved spec including S2-1, the uncommitted
  plan and prior review rounds. Confirmed `feature/admin-data-requests`;
  no fetch, commit or push was performed. Only this review file was edited.
- Compared every acceptance criterion with the planned implementation and
  tests. The auth/error matrix, trimmed note, idempotence, separate successive
  requests, cancellation outcomes, account states, rollback, attribution,
  list filter, export privacy, database rules, headers, rate limit and three
  required documentation files are covered. The build remains subject to
  the spec's full AGENTS.md checks and owner plan approval.
- The nullable UUID scalar, optional owning relation with `onDelete: Restrict`
  and array back relation form a valid one-to-many Prisma relation. The
  SQL-only unique partial index narrows it to at most one linked action per
  request. No Prisma `@unique` or ordinary duplicate index is needed.
- The enum-only migration precedes the column/FK/CHECK/index migration;
  keep the migration boundary committed and do not wrap both in one
  transaction. This safely separates adding the enum label from using it
  in CHECKs. The nullable column needs no backfill, the FK's RESTRICT/CASCADE
  actions match the relation defaults and existing report link, and the two
  CHECKs plus partial uniqueness implement the approved SQL rules. Existing
  NOT NULL action/target fields prevent a NULL escape through the CHECKs.
- Compared the SQL-only indexes in
  `20261002140000_account_data_request_intake` and
  `20261014140100_account_deletion`, the latter's status/date and schedule
  CHECKs, and other CHECK-bearing migrations with `schema.prisma`. These
  constraints are not represented as Prisma indexes or model attributes.
  Ran the read-only command
  `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`:
  exit 0, `-- This is an empty migration.` This confirms current baseline
  handling, not the unapplied proposed migration; repeat after the build.
- The transaction checks request type before status, calls `afterRead`
  before any write, conditionally updates OPEN ACCESS, inserts the audit
  only after winning, and reads the result within the same transaction.
  Completed/no-op branches must return the admin relation selection too;
  the planned shared `adminRequestSelect` supplies it. Re-reading after a
  lost update under READ COMMITTED sees the winner's committed state and
  attribution. Filtering `moderationActions` by DATA_REQUEST_COMPLETED with
  `take: 1` is sufficient because the partial unique index permits only one;
  no ordering or time-based matching is needed.
- A global transaction inside `afterRead` can update the request and insert
  its completion action: the outer transaction has performed only an
  ordinary SELECT, with no row lock blocking that update or the new FK
  check. Await the inner commit before resuming the outer conditional update;
  use a separate pooled connection, not the outer transaction client. The
  cancel hook has the same valid ordering. No deadlock is introduced by
  the planned read-only outer phase.
- Separate admin response schemas/presenters preserve user response and
  export privacy. The nested `app.register` plus `onSend` matches
  `admin-users` and covers error/rate-limit replies. Fresh authentication
  followed by `requireStaff`/`requireAdmin` matches the current admin list.
  Passing optional completion hooks through `BuildAppOptions` and the route
  registrar fits the existing optional third-argument override pattern;
  hooks are not HTTP input and production supplies none.
- `rateLimitKey` keys valid callers by verified subject. Separate admin
  groups and the dedicated 21-call rate administrator preserve the real
  route limit; keep each ordinary group's actual call count within its
  stated budget, including header/error cases. The two apps have separate
  limiter stores. The database-rule cases include S2-1's non-USER target;
  use otherwise-valid rows so each rejection exercises the intended rule.
- `vitest.integration.config.ts` disables file parallelism, and the existing
  account-deletion suite invokes the same global erasure batch. The plan
  explicitly acknowledges that scope. On the normal cleaned test database,
  the proposed erasure fixture is compatible; serial execution does not
  isolate stale data from failed runs. The worker also processes global
  purge/cleanup batches, so assert this fixture's rows rather than global
  counts, and diagnose unrelated due rows if the fixture is not processed
  within the worker's 20-request batch.
- Read the erasure and cleanup implementations: erasure preserves ACCESS
  and user rows, completes only the selected deletion, and can leave a
  FIREBASE_SIGN_IN_GUARD cleanup task even after successful fake provider
  removal. The planned cleanup order removes linked moderation actions
  before requests, and cleanup tasks before users, satisfying both new and
  existing RESTRICT FKs. Purge changes evidence keys without violating the
  new action/link CHECKs. README guidance and the stated risks match scope.
- Initial reads used nonexistent plural repository/route filenames and an
  incorrect erasure directory; the actual singular files and
  `src/modules/account-deletion/account-erasure.ts` were then read. An
  installed Prisma bundle search returned no matches (exit 1). No application
  tests, writes to the database or migration deployment were run for this
  plan-only review.
- `npx prettier --check docs/work/admin-data-requests/review.md` and
  `git diff --check`: passed.

Builder reply: both accepted. P1-1: plan.md "Migration" makes an empty final `migrate diff` a required check; any proposed drop of the partial index or a CHECK stops the build for investigation. P1-2: `alice`'s ACCESS requests are created one at a time. The first is a fixture completed in case 3. The second is created through the user route in case 5, after the first is completed, and completed in case 6.

## Code review, round 1

Verdict: APPROVED

No blocking findings or suggestions for this item's code.

Review evidence:

- Reviewed commit `4584c5c14a773784751ab83cdecdfd155283d3b2` with
  `git show --stat` and `git diff 5930ab8..4584c5c`, the approved spec,
  plan, previous review rounds, and the complete new unit/integration tests.
  HEAD is the reviewed commit on `feature/admin-data-requests`; origin/main
  is `5930ab8`, the PR #65 merge. Both ancestry checks passed. The PR #65
  status-document updates are supported by that history.
- The completion transaction checks existence, type and status, then uses
  an OPEN ACCESS compare-and-set. A losing update re-reads the committed
  cancellation or winning completion. The audit insert shares the transaction,
  so failure rolls back status and timestamp. Replays preserve attribution,
  timestamp and the single audit row. Deterministic race tests exercise both
  losing outcomes; cancellation after completion preserves the result.
- The route uses fresh authentication and the existing staff/admin gates,
  trimmed-note validation, a scoped no-store hook and the real per-account
  20/minute limit. The optional hook is application configuration, never HTTP
  input. Separate admin selection, presenter and response schema expose only
  attribution IDs; user presenters/schemas and the explicit export selection
  exclude the audit relation, administrator and note. No notification is added.
- The enum-only migration precedes use of its value. Existing rows receive
  null links and satisfy both CHECKs; action and target type are NOT NULL,
  preventing a SQL NULL escape. The RESTRICT FK and partial unique index
  implement the approved durable link and one-completion rule. Tests cover
  each CHECK, uniqueness and audit-failure rollback. Deployment found these
  migrations already applied, so this review did not replay them on a fresh
  database; the migration review is static plus the live constraint tests and
  empty final diff.
- Fixtures use random UUIDs and per-run subjects, separate rate-limit accounts,
  and sequential ACCESS requests. Cleanup deletes audit rows before requests
  and cleanup tasks before users. The erasure test's global batch scope is
  explicitly acknowledged by the approved plan; integration files run serially
  and other worktrees were confirmed idle. Erasure and purge preserve the
  completion link and do not complete ACCESS requests automatically.
- All four documented deviations are acceptable: one initial completion plus
  19 replays tests the same 20-call budget; unused request links isolate CHECK
  failures from uniqueness; schema rejection need not avoid the rate limiter's
  token verification; optional `now` follows existing repository conventions.
  README, roadmap and remaining-work documentation match the implementation.

Checks run by Reviewer, in AGENTS.md order (all logs are in the repository root):

| Check                                                                                        | Result                                                                  | Log                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| Branch, HEAD, base ancestry, dependency-file diff, Node/npm versions                         | Passed; Node 24.15.0, npm 11.12.1; no dependency-file changes           | `reviewer-adr-context.log`                    |
| `docker start travel-buddy-postgres`                                                         | Exit 0                                                                  | `reviewer-adr-docker.log`                     |
| `npm ci`                                                                                     | Skipped as required: neither package.json nor package-lock.json changed | Dependency diff in `reviewer-adr-context.log` |
| `npm run format:check`                                                                       | Exit 0                                                                  | `reviewer-adr-format-check.log`               |
| `npm run lint`                                                                               | Exit 0                                                                  | `reviewer-adr-lint.log`                       |
| `npm run db:validate`                                                                        | Exit 0                                                                  | `reviewer-adr-db-validate.log`                |
| `npm run db:migrate:deploy`                                                                  | Exit 0; 44 migrations, none pending                                     | `reviewer-adr-db-migrate-deploy.log`          |
| `npm run typecheck`                                                                          | Exit 0                                                                  | `reviewer-adr-typecheck.log`                  |
| `npm test`                                                                                   | Exit 0; 34 files, 537 tests passed                                      | `reviewer-adr-unit.log`                       |
| `npm run test:integration`                                                                   | Exit 0; 48 files, 498 tests passed                                      | `reviewer-adr-integration.log`                |
| `npm run build`                                                                              | Exit 0                                                                  | `reviewer-adr-build.log`                      |
| `npm audit --audit-level=high`                                                               | Exit 0; 14 moderate vulnerabilities, no high/critical reported          | `reviewer-adr-audit.log`                      |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` | Exit 0; `-- This is an empty migration.`                                | `reviewer-adr-migration-diff.log`             |
| `git diff --check 5930ab8..4584c5c`                                                          | Exit 0                                                                  | `reviewer-adr-diff-check.log`                 |
| `npx prettier --write docs/work/admin-data-requests/review.md`                               | Exit 0                                                                  | `reviewer-adr-review-format.log`              |
| Final review formatting, whitespace and changed-file checks                                  | Exit 0; only review.md modified                                         | `reviewer-adr-final-check.log`                |

No test or hook timed out, and no failed-file rerun was needed. Integration
output includes pg concurrent-query deprecation warnings. Audit reports the
moderate glob/minimatch advisories and their dependent packages; dependency
remediation is outside this item. Prisma's stderr informational config message
is rendered by PowerShell as NativeCommandError text in logs, but the commands
exited 0. The Builder's mutation experiment and standalone integration run were
not repeated; the Reviewer independently ran both complete suites.

Only this review file was edited among tracked files. No commit, push or PR
was made.
