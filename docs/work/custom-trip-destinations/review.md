## Spec review, round 1

Verdict: CHANGES REQUESTED

- S1-1 [blocking] `spec.md:164-165` (Data): the proposed CHECK tests whether a custom name is nonblank, rather than requiring the unused destination column to be NULL. A linked row with `destination_name = ''` or spaces has exactly one true predicate and would pass, despite the requirement to reject rows with both columns populated. Also, translating the stated predicates directly into SQL XOR allows NULL results, which PostgreSQL CHECK constraints do not reject. Specify the invariant explicitly: `(community_id IS NOT NULL AND destination_name IS NULL) OR (community_id IS NULL AND destination_name IS NOT NULL AND btrim(destination_name) <> '')`. Extend the raw-SQL acceptance cases to cover valid linked/custom rows, both NULL, both populated, and a community ID together with an empty/space-only name.

- S1-2 [blocking] `spec.md` "Alerts, history and export" and "Acceptance criteria" omit member notices for destination edits. `src/modules/trips/trip-management.repository.ts:154-171` decides whether to emit `TRIP_UPDATED` using a fixed field list that contains `communityId` but cannot yet contain `destinationName`; `src/modules/trips/trip-history.ts:33-49` likewise snapshots only the community ID. A custom-to-custom edit such as Kasol to Tosh can leave `communityId` NULL on both sides, so relying on community changes misses the actual destination change. PRD §7.5 requires a notice for material destination changes. Require custom-name changes to participate in plan-change detection and history, define the history representation, and add acceptance cases for custom-to-custom plus linked/custom transitions that verify the recorded change and the existing fixed-title member notification without destination text in its title.

- S1-3 [blocking] `spec.md` "Privacy, safety and abuse" and "Responses" miss the staff inspection path for the new public text. `src/modules/moderation/moderation.repository.ts:160-172` returns a reported trip's description and status but no destination. With an optional description, a trip whose custom destination contains harassment or other prohibited content can therefore have no offending text visible in staff report detail. The public-text privacy guard does not replace the moderation required by PRD §6.4. Specify that the authorized staff report-detail response includes the stored custom destination name and enough destination context to distinguish a linked trip, while preserving the existing inspection audit and access controls. Add an acceptance case that reports a custom trip with a NULL description, inspects its destination as staff, and removes it through the existing moderation flow.

- S1-4 [suggestion] `spec.md:195-237` (Acceptance criteria): the listed cases are generally testable, but several decided behaviours have no explicit assertion. Add create and PATCH cases for two active case-insensitive name matches (link none), one active plus one archived match (link the active one), slug-only/region-only matches and "Manali, HP" (keep custom), preserved inner spaces, and trimmed storage. Also cover `relatedTrip` in connection responses (`src/modules/connections/connection.types.ts:45-54`), export of `destinationName`, explicit NULL description on create and omitted description on PATCH, read masking versus owner originals, and publish-time privacy rechecking. Include a queued linked publication edited to custom before worker processing; the current worker rejects a changed community snapshot before dereferencing the relation (`src/modules/trip-alerts/trip-alert.worker.ts:77-85`), and that behaviour should remain. Add focused regression expectations that community counts/merge/archive affect only linked trips and that account erasure still cancels custom trips and records membership changes; these paths currently use explicit IDs or trip state rather than requiring a community relation.

- S1-5 [suggestion] `spec.md` "Destination on create": "1–120 characters after trimming" and "over 120 characters fails schema validation" leave the padded boundary ambiguous. The existing write schemas validate string length before service-level trimming (`src/modules/trips/trip.routes.ts:168-196`, `src/modules/trips/trip-management.service.ts:287-309`). State whether a request containing a 120-character name plus outer spaces is accepted after trimming or rejected by the raw request limit, and add the corresponding boundary case so the schema and service implement the same contract.

Builder reply:

- S1-1 fixed in spec.md "Data": the CHECK is now the explicit null-safe form
  you gave, and a linked row must have `destination_name IS NULL`. The raw-SQL
  acceptance case lists every valid and invalid combination.
- S1-2 fixed in spec.md "Alerts, history and export": `destinationName` joins
  the plan-change field list for the `TRIP_UPDATED` notice and the history
  snapshot (text kept, like `originCity`). Acceptance cases cover
  linked → custom, custom → linked and custom → custom, with the fixed title.
- S1-3 fixed in new spec.md section "Moderation": staff report detail for a
  trip adds `communityId` and `destinationName`; access and audit unchanged.
  Acceptance case: reported custom trip with a null description, inspected and
  removed.
- S1-4 accepted: added the auto-link matrix (create and PATCH), explicit null
  description on create, omitted description on PATCH, masking versus owner
  original, publish-time recheck, `relatedTrip`, export, the queued-alert
  edit, community counts/merge/archive and account erasure.
- S1-5 fixed: the 120-character limit applies to the raw request value before
  trimming, like `originCity`; boundary cases for exactly 120 and for 120 plus
  outer spaces added.

## Spec review, round 2

Verdict: APPROVED

Round-1 findings S1-1 through S1-5 are resolved and there are no new findings.

- S1-1: "Data" now specifies the explicit null-safe CHECK, and acceptance
  criteria cover valid linked/custom rows and all requested invalid combinations.
- S1-2: "Alerts, history and export" includes `destinationName` in member
  plan-change notices and history, defines before/after text storage, and adds
  transition coverage with fixed notification titles, consistent with PRD §7.5.
- S1-3: "Moderation" adds stored `communityId` and `destinationName` to staff
  report detail while retaining access controls and inspection auditing; the
  acceptance case covers reporting, inspection and removal with a null description.
- S1-4: Acceptance criteria now cover the matching matrix, nullable description
  semantics, privacy masking and publish rechecking, `relatedTrip`, export,
  queued-alert invalidation, community operations and account erasure.
- S1-5: The raw request limit is explicit, with acceptance cases for exactly
  120 characters and for 120 characters plus outer spaces.

Checked the Builder's replies against the revised working-tree spec, the
relevant existing `src/` and `prisma/` paths, and the supplied PRD (particularly
§6.4, §7.1 and §7.5). The recorded owner decisions remain consistent with the
revised contract. This is spec approval only; implementation verification is
reserved for the code review stage. No tests, migrations or build checks were
run, as requested.

## Plan review, round 1

Verdict: CHANGES REQUESTED

- P1-1 [blocking] `plan.md` section 4 (profile activity) omits `src/modules/profiles/profile-activity.types.ts:12-22`. `profileTripSelect` explicitly selects the trip fields and currently does not select `destinationName`; changing the repository filter and presenter cannot supply the custom name. Passing this payload to the planned destination helper will either fail typecheck or leave custom profile cards without a name. Add this file to the plan, select `destinationName: true`, and update the trip activity fixture in `test/profile-activity-signals.test.ts:67-80`. Explicitly add `destinationName: true` to `roomSelect.trip.select` in the already-listed `messaging/messaging.types.ts` as well; its scalar fields are also explicitly selected. The planned profile and room integration cases should assert the custom destination name and nullable destination fields, not just successful inclusion or HTTP status.

- P1-2 [blocking] `plan.md:58` specifies `destinationNameProperty` with `minLength: 1`, but the approved spec's create/edit rules and acceptance criteria require a blank name to return `400 INVALID_DESTINATION`. For `destinationName: ''`, Fastify will reject the request before `resolveDestination` runs, and the existing handler (`src/app.ts:247-293`) returns `REQUEST_ERROR` for schema errors. Remove the schema minimum length so empty strings reach the service's trimmed-blank check, retaining the raw maximum of 120, or plan a narrowly scoped error translation. Add explicit HTTP assertions for both `''` and whitespace-only names on POST and PATCH, including the exact error code.

- P1-3 [blocking] `plan.md` section 5 does not assign tests for the approved acceptance case that an unknown or archived explicit `communityId` returns `400 INVALID_COMMUNITY` (`spec.md:247-252`). The archived-name auto-link cases test a different path, and the current `test/` tree has no `INVALID_COMMUNITY` assertion to inherit from the unchanged suite. Add explicit-ID tests using an absent UUID and an owned archived community fixture, covering create and PATCH while retaining the successful active-ID regression. For rejected PATCH requests, assert the stored destination and version stay unchanged.

- P1-4 [suggestion] `plan.md` section 5 and the end of the plan do not explicitly schedule the spec's final acceptance criterion: all checks in `AGENTS.md` with complete root `*.log` output. Add a short verification step with the prescribed check order, database prerequisite, conditional `npm ci`, full output capture, and the failed-file rerun/investigation rule for timeouts. This makes the build handoff and evidence expected at code review explicit.

Builder reply:

Review scope: read the uncommitted plan and approved spec against the current
`src/`, Prisma schema/migrations/seed, relevant test fixtures and integration
configuration. The proposed migration's null-safe CHECK accepts existing linked
rows, rejects all six invalid combinations, and preserves the restrictive
foreign key; application and empty-diff verification remain build-stage work.
The parameter-bound `lower(name) = lower($1)` lookup with `LIMIT 2` implements
literal case-insensitive equality and duplicate rejection without a wildcard
match. Conditional community locks preserve the existing community-before-trip
lock order, and the plan documents the lookup-to-lock archive race. Community
counts, merge/archive, membership listing, reporting and account erasure were
also traced; their existing explicit-ID/state filters do not require additional
nullable-community changes beyond the paths identified above. Planned UUID
fixtures, UUID-bearing auto-link names and fresh connection requesters follow
the repository's isolation and rate-limit rules. No code, tests, migrations,
build checks or commits were run; only this review file was edited.

Builder reply (continued after the Reviewer's scope note above):

- P1-1 fixed in plan.md section 4: `profile-activity.types.ts`
  (`profileTripSelect` adds `destinationName`) is listed, the room row now
  says `roomSelect.trip.select` adds it, and section 5 updates the
  `profile-activity-signals.test.ts` fixture. The room, profile and
  connection cases assert the name and the nullable fields.
- P1-2 fixed in plan.md section 2: `destinationNameProperty` has no
  `minLength`, only `maxLength: 120`, so `''` reaches the service and returns
  `INVALID_DESTINATION`. Section 5 asserts the code for `''` and spaces on
  POST and PATCH.
- P1-3 fixed in plan.md section 5: explicit `communityId` cases (active,
  absent UUID, test-owned archived community) on create and PATCH, with the
  stored destination and version unchanged after a rejected PATCH.
- P1-4 accepted: new plan.md section 6 "Checks" with the order, database
  prerequisite, `npm ci` rule, full log files and the timeout rule.

## Plan review, round 2

Verdict: APPROVED

Round-1 findings P1-1 through P1-4 are resolved with no new findings.

- P1-1: Section 4 explicitly adds `destinationName` to `profileTripSelect`
  and `roomSelect.trip.select`; section 5 includes the profile activity
  fixture update and asserts custom destination names and nullable fields in
  profile, room and connection responses.
- P1-2: Section 2 removes `minLength` from `destinationNameProperty`, retaining
  the raw 120-character maximum. Section 5 specifies HTTP assertions through
  `app.inject` for empty and whitespace-only names on create and PATCH with
  the exact `INVALID_DESTINATION` code, consistent with the approved spec and
  the existing schema-error handler.
- P1-3: Section 5 covers active, absent and test-owned archived explicit
  community IDs on create and PATCH, including `400 INVALID_COMMUNITY` and
  unchanged stored destination and version after rejected PATCH requests.
- P1-4: Section 6 schedules the prescribed checks in order, with the database
  prerequisite, conditional `npm ci`, complete root log files, and the timeout
  failure, isolated rerun and investigation rule.

Checked the Builder's replies against the revised working-tree plan, approved
spec, and relevant existing `src/`, `prisma/` and `test/` paths. The revisions
preserve the recorded owner decisions and introduce no new blocking issue.
This is plan approval only; implementation and runtime verification remain for
the build and code-review stages. No tests, migrations, build checks or commits
were run, as requested; only this review file was edited.

## Code review, round 1

Verdict: APPROVED

Reviewed `feature/custom-trip-destinations` at
`be003e9f792bbb0daa55eab378b0d6c550b3e173`, the sole commit above `main`,
using `git diff main...HEAD` against the approved spec and plan, including
"Changes from the plan". The working tree was clean before verification.
No blocking findings.

- C1-1 [suggestion] `package-lock.json:5046` and `package-lock.json:6092`
  (unchanged; outside this item): `npm audit --audit-level=high` reports
  14 moderate dependency vulnerabilities involving `glob`, `minimatch` and
  their dependents. The command passes its configured severity threshold,
  and this item changes neither package file. Track compatible dependency
  upgrades as a separate security item so these advisories are addressed
  without expanding this change. Evidence: `review-audit.log`.

Builder reply:

The implementation matches the approved destination contract: literal
case-insensitive matching to exactly one active community, exclusive linked
or custom storage, optional descriptions, and unchanged omitted PATCH fields.
Traced public search/detail and profile visibility, owner and membership
lists, both connection trip references, room selects/presenters/schemas,
publication and queued-alert handling, history, fixed notification titles,
staff inspection/removal, export, community administration and account
erasure. No missed null-community dereference, response-field mismatch or new
privacy exposure was found. The Flutter guide's request fields, response
shapes, defaults, errors, edit notices, discovery limits and rollout guidance
agree with the code.

The new tests cover the acceptance scenarios, including the raw-SQL CHECK
matrix, auto-link matrix on create and PATCH, invalid explicit community IDs,
unchanged state after rejected edits, privacy masking and publish rechecking,
member notices/history, and the related-module paths. UUID-bearing fixture
names isolate matching; the connection flow uses a new requester; cleanup
targets test-owned rows. The integration configuration runs files serially.
Database activity probes found no other connections before the suite, and no
other database work was run concurrently with it. Post-suite queries found
zero custom-destination test communities and auth accounts remaining.

Checks run by the Reviewer, in the prescribed order (all executed commands
below exited 0 unless explicitly noted):

| Check                                | Result                                                                   | Complete root log              |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------ |
| `docker start travel-buddy-postgres` | PASS; database running before checks                                     | `review-docker-start.log`      |
| `npm ci`                             | SKIPPED as requested; package files unchanged and dependencies installed | Not run                        |
| `npm run format:check`               | PASS                                                                     | `review-format-check.log`      |
| `npm run lint`                       | PASS                                                                     | `review-lint.log`              |
| `npm run db:validate`                | PASS                                                                     | `review-db-validate.log`       |
| `npm run db:migrate:deploy`          | PASS; 41 migrations found, no pending migrations                         | `review-db-migrate-deploy.log` |
| `npm run typecheck`                  | PASS                                                                     | `review-typecheck.log`         |
| `npm test`                           | PASS; 31 files, 507 tests, 78.85 s                                       | `review-test.log`              |
| `npm run test:integration`           | PASS; 45 files, 426 tests, 356.93 s                                      | `review-test-integration.log`  |
| `npm run build`                      | PASS; includes Prisma client generation                                  | `review-build.log`             |
| `npm audit --audit-level=high`       | PASS at the high threshold; 14 moderate vulnerabilities (C1-1)           | `review-audit.log`             |

No test or hook timed out or failed, so no isolated failed-file rerun was
needed. Integration output includes the `pg` deprecation warning about
calling `client.query()` while a query is executing; it did not fail the run.
PowerShell also wraps normal Prisma stderr messages as `NativeCommandError`
records; the Prisma commands themselves exited 0.

Additional verification:

- Database activity checks: PASS, zero other connections, in
  `review-db-activity.log` and
  `review-db-activity-before-integration.log`. An initial probe using the
  nonexistent `postgres` role failed; it was corrected to the configured
  `travel_buddy` role before proceeding. That initial probe's error is in the
  tool transcript, not a root log.
- `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`:
  exited 0; **not globally empty**. Its only SQL replaces
  `ModerationActionType` to omit `USER_LOOKED_UP`, consistent with the known
  unmerged `20261106120000_user_lookup_audit` migration. There is no trip
  column, relation or other item-specific drift: **this item's own diff is
  empty**. No diff SQL was applied. Full output:
  `review-db-migrate-diff.log`.
- Database constraint and fixture-cleanup inspection: PASS. The installed
  `trips_destination_check` matches the null-safe spec; the community foreign
  key remains `ON DELETE RESTRICT`; fixture counts above are zero. Full
  output: `review-db-constraints-cleanup.log`.
- `git diff --check main...HEAD`: PASS, `review-diff-check.log` (empty output).
- Review-file formatting after this append: the first
  `npx prettier --check docs/work/custom-trip-destinations/review.md` failed
  on formatting in the newly written review (`review-review-format.log`).
  Formatted only this permitted file with Prettier
  (`review-review-format-fix.log`); the repeated file check passed
  (`review-review-format-final.log`). This was a review-text formatting
  correction after the full check sequence, not an implementation failure.
- Final `git diff --check`: PASS, `review-final-diff-check.log` (empty output).

Only this review file was edited among tracked files. Verification generated
ignored logs, build output and the Prisma client. No code, package files or
migration SQL was changed; no commit, push or pull request was made.

Builder reply (continued after the Reviewer's notes above):

- C1-1 accepted as a follow-up, not changed here: the 14 moderate advisories
  are in unchanged dependencies and below the CI threshold. I suggest the
  owner adds a separate "dependency security update" item to the roadmap.
