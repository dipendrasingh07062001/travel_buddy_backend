# Review: admin account detail

## Spec review, round 1

Verdict: CHANGES REQUESTED

- S1-1 [blocking] **Reports filter introduces an unaudited private-content attribution lookup.** Location: spec.md, reports filter, Privacy, and D1/D3. `listStaffReports` currently returns report rows, without message sender or connection requester fields (`src/modules/moderation/moderation.repository.ts:79`). Those identities are exposed by `findStaffReportDetail` only after writing `REPORT_INSPECTED` (:111 onward). Filtering those rows by a known user now links private message/request IDs to that account without inspection. Existing permission to list reports does not make this attribution equivalent to today's list. Explicitly describe and obtain an owner decision on this additional disclosure; choose an audit/access policy for filtered results (or omit these target types from the filter), reconcile D3's scope, and add acceptance tests for that policy. The detail's aggregate counts and the filtered report list need separate privacy reasoning.

- S1-2 [blocking] **Ordinary users can retain claimed reports.** Location: spec.md, `claimedReportCount` and its acceptance criterion. The promise of `0` for ordinary users contradicts both the unconditional reviewer/status definition and the existing staff-role response. Revocation preserves assignments and counts them by `reviewerId` with status `UNDER_REVIEW` (`src/modules/staff-roles/staff-role.repository.ts:70`); therefore a former moderator with role USER can have a nonzero count. Recommended fix: count retained assignments regardless of current role, matching the role endpoint; add a revoked-moderator fixture. Also state whether staff may view themselves and other moderators/administrators, and test those target-role cases separately from authorization of the caller.

- S1-3 [blocking] **Content count predicates are incomplete.** Location: spec.md, `content` and its acceptance criterion. `CommunityPostStatus` includes DRAFT as well as PUBLISHED and REMOVED (`prisma/schema.prisma`, CommunityPost). It is unclear whether `communityPosts` means all posts, only published posts, or all nonremoved posts, and whether removed counts are subsets or disjoint buckets. Define exact status predicates for both post and comment fields, explicitly decide treatment of drafts, and test every status. Also clarify that connection-request attribution is to the requester by this spec, even when the reporter is the requester: existing `reportedAccountId` instead selects the recipient in that case (`moderation.repository.ts`, CONNECTION_REQUEST branch). Test both reporter directions so these intentionally different semantics cannot be silently conflated.

- S1-4 [blocking] **Verification needs a precise persisted-state definition for both contact types.** Location: spec.md, account verification fields and acceptance criteria. `AuthIdentity.verifiedAt` is nullable (`prisma/schema.prisma:1043`); existence alone is insufficient. Existing profile signals require `verifiedAt != null`. `verifiedContacts` stores email only when Firebase `emailVerified` is true, and treats a Firebase phone number as verified (`src/modules/auth/auth.repository.ts:32`); these are stored observations refreshed separately, not a live contact verification check on the viewed account. Define each boolean as existence of an identity of that type with nonnull `verifiedAt`, explain freshness, and test absent/unverified/verified EMAIL and PHONE, including multiple identities and strict exclusion of values from output/logs.

- S1-5 [blocking] **Deleted and purged account semantics are unspecified.** Location: spec.md, all-status account response, counts, and acceptance criteria. Erasure deletes identities/profile/blocks, removes community content, resets staffRole, but retains trips, reports and shared history (`src/modules/account-deletion/account-erasure.ts`, eraseAccount). Later `purgeModerationRecords` sets `recordsPurgedAt` and clears text/evidence; it does not delete report or content rows (:275 onward). Define counts as current retained rows rather than lifetime totals, and explicitly state that nonnull `recordsPurgedAt` does not zero surviving counts. Add fixtures for DELETED before and after purge, missing profile/identities, and retained reports/content. Exposing `recordsPurgedAt` is optional; defining its effect is necessary.

- S1-6 [suggestion] **Qualify the index claim for the audit filter.** Location: spec.md, Data. The listed indexes exist, including the report target/author indexes, but `(targetType, targetId, createdAt)` (`prisma/schema.prisma:1008`) does not have `targetId` as a leading key. An unrestricted targetId-only predicate with global createdAt/id ordering is not automatically an efficient lookup through this index. Replace the blanket guarantee with a plan-stage query/EXPLAIN requirement, or specify a query constrained by each targetType with a justified access path; decide whether an index migration is necessary from that evidence rather than promising none on this basis.

- S1-7 [suggestion] **Complete error/header and pagination acceptance coverage.** Location: spec.md, acceptance criteria. The all-response no-store promise also covers 401 and guarded 500, but neither is tested. Add those cases, pending-deletion/deleted callers under the reused authentication rules, empty/unknown valid filter IDs, and filtered totals/pages/order. Define empty admin `openDataRequests` as `[]`, retain moderator `null`, and test exclusion of other users and non-OPEN requests. These make the proposed contract directly verifiable.

Review evidence: read AGENTS.md, the spec, relevant admin-users, moderation/restriction, auth/profile-signals, staff-role, data-request and account-erasure implementations, Prisma models/indexes, and the supplied PRD text extract (sections 6.4, FR-15 and 15.1 support the stated scope). Confirmed `reportedUserId` is populated only for USER/PROFILE_PHOTO by `safety.repository.ts` report creation; search openReportCount uses reportedUserId and the two open statuses; the scoped serializer/guard/no-store descriptions match admin-users routes. Data-request access remains administrator-only. No application checks or database checks were run at this spec-review stage. Only this review file was created; formatting is checked below through Prettier.

Builder reply:

- S1-1 fixed with a new owner decision, D5. The spec now has a "Report
  attribution" section with three groups: account, public content and
  private content. The reports filter returns only account and public-content
  reports. Message and connection-request reports are left out, so linking
  them to a person still needs the audited `REPORT_INSPECTED` detail. The
  detail shows only their count (`aboutPrivateContent`), and the privacy
  section explains the difference between the counts and the list. D3 now
  says that report inspections stay audited. The alternative (include them
  and audit each filtered list) is offered in D5.
- S1-2 fixed. `claimedReportCount` counts regardless of current role,
  matching the staff role response. The "`0` for ordinary users" claim is
  removed. Any account can be viewed (own, administrators, moderators,
  former moderators), with criteria for each.
- S1-3 fixed. Posts are `draft`/`published`/`removed` and comments are
  `visible` (`ACTIVE`+`EDITED`)/`removed`: separate buckets. Attribution
  follows `reportedAccountId`. For a connection request that means the other
  party from the reporter's side, which matches who an action from that
  report hits. Both reporter directions are tested.
- S1-4 fixed. Each flag is defined as an identity of that type with
  `verifiedAt` not null, and the spec says these are stored at sign-in, not a
  live check. Criteria cover absent, unverified and verified identities of
  each type, mixed combinations, and that no contact value appears.
- S1-5 fixed. Counts are of rows that exist now, not lifetime totals. The
  spec spells out what erasure deletes, removes and keeps, and says the purge
  changes no count. `recordsPurgedAt` is now returned. The criteria include a
  `DELETED` account before and after the purge.
- S1-6 applied. The audit filter now needs `targetType` and `targetId`
  together, which matches the leading columns of the existing index. The
  plan must confirm each query with `EXPLAIN` and propose a migration rather
  than accept a sequential scan.
- S1-7 applied. Criteria added for `401` and the guarded `500` with
  `no-store`, a pending-deletion caller, empty results for unknown valid IDs,
  filtered `totalItems` and order, and `openDataRequests` as `[]` versus
  `null`, excluding other users and non-`OPEN` requests.

## Spec review, round 2

Verdict: CHANGES REQUESTED

- S2-1 [blocking] **Target type does not guarantee public attribution.** Location: spec.md, "Report attribution", reports filter, Privacy and D5. The claim that owners of TRIP/COMMUNITY_POST/COMMUNITY_COMMENT targets are already public is false for retained reports. `findPublicById` requires PUBLISHED/FULL, no moderation removal, an active owner and an active community (`src/modules/trips/trip.repository.ts:133`); report creation also permits nonpublic trips for active members (`src/modules/safety/safety.repository.ts:143`). Community reads require published/nonremoved content, an active community and a visible author, including communityActivityVisibility and block checks (`src/modules/communities/community-content.repository.ts:35-59`). Content can become removed or hidden after reporting, including on account erasure. Today's report list contains target IDs but no trip owner/post or comment author; those links are returned by the audited detail (`src/modules/moderation/moderation.repository.ts:79-251`). The new account filter reveals those links for hidden targets without inspection, so excluding only MESSAGE/CONNECTION_REQUEST does not fully resolve S1-1. Explicitly choose an owner-approved policy: restrict unaudited filtering to targets whose attribution is currently public under defined visibility predicates, or audit filtered disclosures of hidden targets (or omit these target types). Reconcile D1/D3/D5 and counts-versus-filter expectations. Add fixtures for a member-only trip, removed content, hidden community activity, inactive communities and erased authors, asserting inclusion/exclusion and audit behavior under the chosen policy.

- S2-2 [suggestion] **Describe verification freshness accurately.** Location: spec.md, account verification description. The nonnull verifiedAt predicate is now correct, but existing-user sign-in returns early without refreshing identities (`src/modules/auth/auth.repository.ts:91-93`). Contacts are initially persisted at bootstrap and subsequently replaced by the explicit profile-signal refresh (`src/modules/profiles/profile-signals.repository.ts:26-69`). Replace "stored when the user signs in" with "stored at account creation or the last explicit verification refresh" so staff do not infer that another sign-in makes these flags current.

- S2-3 [suggestion] **Allow evidence-based sequential scans.** Location: spec.md, Data, final paragraph. Requiring an index to be used on the local database and disallowing every sequential scan is not a reliable performance criterion: PostgreSQL can correctly prefer a sequential scan for a small table or a low-selectivity aggregate. Keep the EXPLAIN requirement, but assess representative cardinality/selectivity and query cost; propose a migration only where the evidence shows an inadequate access path. Do not make approval depend on forcing index scans in tiny fixtures.

Round-1 disposition: S1-2 through S1-5 are resolved by the revised unconditional reviewer count, disjoint status buckets, reportedAccountId attribution (including both connection-request directions), persisted verification predicate, and current-row erasure/purge semantics. S1-6's paired audit filter matches the existing index prefix. S1-7 is substantially addressed. S1-1 remains partially unresolved as described in S2-1; the private-message/request exclusion itself addresses that part of the original finding.

Review evidence: read AGENTS.md and both work documents; checked moderation report listing, audited detail, reportedAccountId and audit listing; admin-users repository/routes/service/types; staff-role assignment behavior; account erasure and purge; auth verifiedContacts and profile-signal refresh; Prisma report relations, status enums and relevant indexes; and public trip/community visibility plus report-creation predicates. Branch confirmed as feature/admin-account-detail. No application tests, database checks or full CI suite were run at this spec-review stage. Only review.md was edited; Prettier formatting was run on this file.

Builder reply:

- S2-1 fixed by narrowing the filter (D5 rewritten). `GET /admin/reports?userId=`
  now returns only `USER` and `PROFILE_PHOTO` reports. Their `reportedUserId`
  is already in every list row today, so the filter discloses nothing new.
  All content reports are left out, whatever the content's visibility
  (trips, posts, comments, messages and connection requests). The detail
  shows them only as one `aboutContent` count, which names no content. So
  linking reported content to its owner still needs the audited
  `REPORT_INSPECTED` detail, including for member-only trips and removed or
  hidden content. "Report attribution", Privacy, D3 and D5 now say this. The
  criteria test that no content report comes back, for every content type,
  including a member-only trip, a removed post and an erased author's
  comment, and that the filter writes no audit row. The alternative (include
  them and audit) stays in D5 for the owner.
- S2-2 applied. Identities are stored at account creation and replaced only
  by the explicit profile-signal refresh; a later sign-in does not update
  them.
- S2-3 applied. `EXPLAIN` is judged against realistic sizes and selectivity.
  A sequential scan is acceptable where PostgreSQL rightly prefers it, and a
  migration is proposed only on evidence.

## Spec review, round 3

Verdict: CHANGES REQUESTED

- S3-1 [blocking] **Exact content-report counts still permit unaudited attribution.** Location: spec.md, account detail `reports.aboutContent` (lines 106-110), unaudited-view rationale (136-138), Privacy "Content ownership stays behind inspection", and D3/D5. Excluding all content reports from the account filter resolves the direct list disclosure, but does not establish the claimed privacy boundary for the detail. Today's `listStaffReports` returns every report row, including status and content target ID, without attribution (`src/modules/moderation/moderation.repository.ts:79-98`; route returns these rows at `moderation.routes.ts:160-164`). Suppose the list contains exactly one SUBMITTED content report, on a private message or member-only trip, and the detail for account A returns `aboutContent.submitted: 1`. Staff have now linked that known report/content ID to A without calling the audited detail. A transition into a previously empty status bucket gives the same inference even in a larger report history. Current search counts only `reportedUserId` (`admin-users.repository.ts:69-77`), and creation sets that field only for USER/PROFILE_PHOTO (`safety.repository.ts:41-48`); this content attribution is therefore an additional disclosure, not the same level as search. Fix: either omit `aboutContent` from the unaudited detail, put its disclosure behind an explicit audit policy, or explicitly ask the owner to accept unaudited aggregate attribution (including singleton/differencing inference), removing the assertions that all content ownership links still require inspection. Reconcile D3/D5 and add a singleton private-content fixture asserting the selected response and audit behavior; the current filtered-list exclusion tests do not cover this path.

Round-2 disposition: the revised USER/PROFILE_PHOTO-only filter resolves S2-1's direct filtered-list disclosure for every content type. S2-2 is resolved by the creation/explicit-refresh freshness wording, matching the existing-user early return in auth.repository.ts and identity replacement in profile-signals.repository.ts. S2-3 is resolved by the representative-cardinality/selectivity EXPLAIN requirement and allowance for justified sequential scans. No additional blocking contradiction was found in verification predicates, attribution direction, status buckets, retained-row erasure/purge semantics, role access, paired audit filters or their stated indexes.

Final-round disagreement summary (Reviewer): the Builder's revision treats a content-report count as insufficient to link a reported item to an account. Exact per-status counts can identify that link in singleton or changing datasets when combined with the existing staff report list. The owner must decide whether to accept that additional unaudited disclosure or require omission/auditing. This is round 3; no further review loop is requested. The Builder should append its own short disagreement summary, and the owner decides. This entry does not speak for the Builder or presume owner approval.

Review evidence: read AGENTS.md, the entire revised spec and prior review rounds; checked listStaffReports, findStaffReportDetail, reportedAccountId and moderation route responses; safety report creation and target eligibility; auth bootstrap/verifiedContacts; profile-signal reads/refresh; Prisma Report, AuthIdentity, ModerationAction and relevant status/index definitions; admin-user search counts; and account erasure/purge count effects. Confirmed branch feature/admin-account-detail. Two initial supplemental reads used nonexistent singular repository/service filenames; corrected them through rg file discovery and read the actual repository/routes. No application tests, database checks or full CI suite were run for this spec-only review. Only review.md was edited. Prettier formatting and its result are recorded below.

Formatting: npx prettier --write docs/work/admin-account-detail/review.md completed successfully (exit 0).

Builder reply and final-round summary (Builder):

S3-1 is accepted. The singleton and differencing inference is real: one
open message report in the list plus "one open content report" for account A
links that message to A without the audited inspection. So the Builder does
not dispute the finding. The spec now follows the Reviewer's first fix,
"omit `aboutContent`", as the recommended default:

- the detail's report counts are `aboutAccount` and `filed`;
- `claimedReportCount` is kept;
- every report number and filter result uses a field already on every report
  list row (`reportedUserId`, `reporterId`, `reviewerId`);
- no content report is listed or counted per account;
- "Which reports are linked to the account" (which replaces "Report
  attribution"), Privacy, D3 and D5 are rewritten;
- a criterion covers an account whose only report is one open report on its
  private message: all counts are zero and no content-report field exists.

What remains open is not a disagreement but an owner decision, D5. The
recommended default above loses one warning in the detail: it does not say
that the account's content has open reports. The alternatives are to accept
an unaudited count, or to audit content-report views, which needs a new audit
row and a migration. Because this is round 3, the revised spec was not
reviewed again. The Builder asks the owner to decide D5 and, if the owner
wants, to have the Reviewer check this last revision during plan review.

## Plan review, round 1

Verdict: CHANGES REQUESTED

- P1-1 [blocking] **Update the existing repository test double.** Location: plan.md, "Files to change" and "Tests"; `test/admin-users.integration.ts:111`. Adding required `AdminUserRepository.detail` makes the existing `switchable: AdminUserRepository` object incomplete. `tsconfig.json` includes integration tests, so the proposed file list leaves `npm run typecheck` broken even before tests run. Add this test file to the plan and forward `detail` to the real repository (or provide an appropriate stub). Existing assertions can remain unchanged; existing moderation tests need no planned edits because unfiltered predicates and ordering are preserved.

- P1-2 [blocking] **Complete the test plan against the approved acceptance criteria.** Location: plan.md, integration fixtures and cases 3, 6, 7 and 11; spec.md, acceptance criteria for verification, report counts and report-filter exclusion. The plan has no unverified EMAIL/verified PHONE account, says filed reports cover only "several statuses" instead of all four, and lacks the required reported comment by an erased author. Add these fixtures and exact assertions. In particular, attach a COMMUNITY_COMMENT report to `erased`'s comment before erasure, then assert the erased account's filtered report list still excludes that report while retaining its USER/PROFILE_PHOTO reports. Keep fixture reporters/targets distinct where needed for partial open-report uniqueness. These are explicit approved criteria, not additional scope.

- P1-3 [suggestion] **Make query evidence distinguish an available index from an efficient selective path.** Location: plan.md, "Query check". The approach is adequate as an access-path check when combined with the promised realistic cardinality/selectivity judgement; `enable_seqscan=off` alone does not prove production performance and may produce a full index scan. Record SQL, predicates, relevant Index Cond/filter/sort nodes and the reasoning about rows scanned, including both list and total-count statements. Include the initial user/profile lookup as well as the ten aggregate reads. Replace the conditional uncertainty about indexes with the actual existing indexes: restrictions `(userId, feature, liftedAt)` (`prisma/schema.prisma:1033`) and identities `(userId)` (:1049). Both support a userId prefix lookup. Use session-local settings or reset enable_seqscan after the diagnostic, and keep normal-planner output as the baseline.

- P1-4 [suggestion] **Exercise the new filters across page boundaries and audit target types.** Location: plan.md, integration cases 11ï¿½12. Use `pageSize=1`, check successive pages and an empty page with unchanged filtered totals; give audit fixtures deterministic timestamps plus a same-ID/different-targetType row. This verifies both predicates, stable ordering and paging rather than merely a first-page result with two rows.

Final-spec confirmation: the final removal of `aboutContent` resolves S3-1 under the owner's approved D5. The spec consistently defines account-attributed report counts through fields already exposed on list rows (`reportedUserId`, `reporterId`, `reviewerId`); filed and claimed reports may themselves concern content, but no content-owner lookup or count is introduced. The plan's report predicates, active-restriction boundaries, persisted verifiedAt flags, disjoint post/comment buckets, administrator-only data requests, access rules and retained-row purge semantics match that contract. No new blocking spec inconsistency was found.

Implementation feasibility: the proposed UUID/enum/dependencies schema can extend pageSchema without changing unfiltered requests. A read-only in-memory probe using installed Fastify returned 200 for neither parameter, 400 for targetId alone, 400 for targetType alone and 200 for both. The first node -e attempt failed because PowerShell stripped quotes; rerunning the same probe through stdin succeeded. This was a schema probe, not a test of application changes.

Fixtures and risks: distinct reporters make the proposed account-report fixtures compatible with the partial unique index on `(reporter_id, target_type, reported_user_id)` for open reports; identities also need per-run unique normalized values. Dedicated adminRate provides a separate detail-route rate budget; other planned request counts are below their route budgets. The listed cleanup order respects the relevant report-target, comment/post, conversation/trip and user foreign keys (restriction report links use SET NULL). Erasure followed by `processAccountErasures` at persisted deletedAt plus 366 days is feasible and matches the existing deletion test; purge is private and must continue to be reached through that exported processor. Supply a no-op signInAccounts remover as in existing tests so cleanup never reaches Firebase. The processor affects all due rows, including on the future-time run, so use the dedicated integration database and verify the target's persisted state rather than assuming global erased/purged totals equal one. READ COMMITTED's mixed-moment counts are accurately identified as informational-view risk. README, roadmap and remaining-work updates are planned; preserving the remaining-work document's current structure is reasonable.

Review evidence: read AGENTS.md, the final spec, plan and prior rounds; inspected admin-users types/repository/routes/service, moderation routes/repository, account erasure/purge, Prisma models and migration uniqueness constraints, the four requested integration files, existing moderation integration coverage, app validator/rate-limit registration and TypeScript/Vitest configuration. Confirmed branch `feature/admin-account-detail`. One supplemental read used a nonexistent rate-limit file path; located the key function through rg instead. No application suite, database EXPLAIN, migrations or full CI checks were run at this plan-review stage. Only this review file was edited.

Formatting: `npx prettier --write docs/work/admin-account-detail/review.md` completed successfully (exit 0).

Builder reply:

- P1-1 fixed. The plan now lists `test/admin-users.integration.ts`: its
  `switchable` test double gains `detail`, which forwards to the real
  repository. No assertion changes, and the moderation tests need no edits.
- P1-2 fixed:
  - a new `phoneOnly` fixture (unverified email, verified phone), with exact
    flag assertions and a check that no stored value appears;
  - `subject`'s filed reports now cover all four statuses, each against a
    different target;
  - `erased` gets `USER` and `PROFILE_PHOTO` reports plus a
    `COMMUNITY_COMMENT` report on its comment, made before erasure. After
    erasure, `?userId=erased` returns the two account reports and not the
    comment report.

  Identity values use the run marker, and the erasure run passes a no-op
  sign-in remover. The test checks `erased`'s stored state, not the
  processor's totals.

- P1-3 applied. The query check records:
  - the SQL captured from Prisma for each query, including the initial user
    lookup and both list and count statements;
  - the normal planner's output as the baseline, then `SET LOCAL
enable_seqscan = off` inside a transaction;
  - the Index Cond, Filter and Sort nodes, with the reasoning about rows
    read. A full index scan does not count as a selective path.

  The restriction `(userId, feature, liftedAt)` and identity `(userId)`
  indexes are now named instead of hedged.

- P1-4 applied. Both filters are paged with `pageSize=1` across every page
  and the empty page after them, with unchanged `totalItems`. The audit
  fixtures have fixed timestamps, and one row has the same `targetId` with
  another `targetType`, to check both conditions.

## Plan review, round 2

Verdict: APPROVED

No new blocking findings or suggestions. P1-1 through P1-4 are resolved in the revised plan:

- P1-1: "Files to change" explicitly adds `detail` forwarding to the existing `switchable: AdminUserRepository` in `test/admin-users.integration.ts:111`.
- P1-2: fixtures and cases 3, 7 and 11 now cover unverified EMAIL/verified PHONE with exact flags and contact-value exclusion, filed reports in all four statuses, and exclusion of the erased author's reported comment while retaining its two account reports.
- P1-3: "Query check" covers captured SQL for the initial lookup, detail reads and both filtered list/count statements; normal planner output, transaction-local diagnostic settings, plan nodes and realistic selectivity reasoning are required. The named indexes match `prisma/schema.prisma`. `EXPLAIN (ANALYZE, BUFFERS)` executes these statements, but the planned statements are read-only lookups, aggregates and lists, so it introduces no data writes. The forced-index diagnostic remains evidence of an available path, not a production-performance measurement; the plan already requires separate cardinality reasoning.
- P1-4: cases 11 and 12 exercise successive single-row pages and the empty page; case 11 explicitly preserves totals, and the Builder reply explicitly requires unchanged totals for both filters. Audit timestamps are distinct, with a same-ID/different-type row to detect a missing targetType predicate.

Fixture checks: the open account-report uniqueness migration keys `(reporter_id, target_type, reported_user_id)` for SUBMITTED/UNDER_REVIEW. Separate reporters for reports about `subject` and separate targets for reports filed by it avoid collisions. USER and PROFILE_PHOTO reports about `erased` can coexist even with one reporter because targetType is in the key. The comment report uses its own content-target key. AuthIdentity uniqueness is `(type, normalizedValue)`; implement the planned run-marked values distinctly per fixture within the run as well as across runs. No fixture conflict is required by this plan. ModerationAction.targetId is a UUID without a polymorphic target foreign key, so the same-ID TRIP audit fixture is feasible.

Rate budgets: the report paging sequence adds one request per fixture report plus one empty page (five requests for four reports, or nine if both account target types cover each status). Together with the other planned report-filter requests this remains well below the inherited 100/minute budget for `moderator`. The audit requests and other planned `admin` requests likewise remain below that budget. The detail's explicit 60/minute configuration gets a child rate-limit store; dedicated `adminRate` isolates the 61-request limit test. Paging does not require sleeps or extra callers.

Erasure check: `account-erasure.ts` retains reports, trips and comment rows, marks community content REMOVED and deletes profiles, identities and blocks. Purge is private and is correctly reached through `processAccountErasures` at persisted deletedAt plus 366 days; it clears text/evidence without changing these counts. The revised plan supplies MemoryStorage and a no-op sign-in remover and checks target state rather than global processor totals. Integration files are serialized by `vitest.integration.config.ts`.

Review evidence: read AGENTS.md, the full revised plan, approved spec and prior review/replies; checked existing admin-users, staff-roles, moderation and account-deletion integration patterns, moderation list predicates/order, Prisma uniqueness/index definitions and report migrations, account-erasure.ts, authentication rate keys, app rate-limit registration and the installed rate-limit plugin's store selection. Confirmed branch `feature/admin-account-detail` and docs-only working-tree changes. Some supplemental reads used nonexistent paths/globs; corrected relevant paths through rg discovery. No application tests, database EXPLAIN, migrations or full CI checks were run for this documentation-only plan review. Only review.md was edited.

Formatting: `npx prettier --write docs/work/admin-account-detail/review.md` completed successfully (exit 0).

## Code review, round 1

Verdict: APPROVED

- C1-1 [suggestion] **Clarify the transaction wording.** `README.md:1207` says the reads run in one transaction, but `src/modules/admin-users/admin-users.repository.ts:124` performs the account/profile lookup before the aggregate transaction and `:204` reads administrator data requests after it. Say that the aggregate reads are batched at READ COMMITTED, with the account lookup and optional data-request lookup separate. The documented possibility of mixed-moment results remains accurate, so this wording issue does not block the informational view.

No blocking findings. Reviewed commit `0f6e0861cb8464299d75a527caed60ba20ac9ec0` against `0b08020`, using the commit and range diff, approved spec, approved plan and previous rounds. Confirmed branch `feature/admin-account-detail`, HEAD at the requested commit, and a clean initial working tree.

Review conclusions:

- D5 is preserved: the detail's about-account aggregation and report filter require both `reportedUserId` and USER/PROFILE_PHOTO target types. Filed and claimed numbers use already exposed reporter/reviewer fields. There is no content-owner join or content-report attribution. Fixtures cover all five content types, the private-message singleton, a removed post and an erased author's comment.
- D2 is enforced through fresh staff authentication and `role === 'ADMIN'`; moderators receive null and do not execute the data-request query. The query selects only the approved fields and filters by account and OPEN status, with deterministic oldest-first ordering.
- Every detail response object is closed and required fields are declared. Counts, status buckets, persisted verification flags, restriction boundaries, deletion dates and date presentation match the contract. Neither contacts, reasons nor blocker identities are returned. The existing scoped no-store hook, query-stripping serializer and guarded database failure path apply to the new route; the captured-log failure test passes.
- Both filtered lists reuse identical predicates for rows and totals, preserve ordering, validate UUIDs, and enforce the audit filter's required pair. Without filters their predicates and access rules remain unchanged; existing moderation coverage passed unchanged. Paging fixtures exercise successive pages, the empty page, fixed ordering and a same-ID/different-type audit row.
- Integration fixtures use random account IDs and per-run identity values; cleanup targets the fixture accounts/content in foreign-key-safe order. The dedicated rate-limit caller avoids consuming other cases' budget. Erasure/purge uses the approved exported processor, memory storage and a no-op sign-in remover; it checks the fixture's persisted state rather than global processor totals. The processor's database-wide scope is the explicitly documented test-database limitation. No database cleanup outside test cleanup was performed by this review.
- README, roadmap and remaining-work documentation cover the item and PR #66 status. The transaction wording suggestion above is the only documentation finding.

Changes from the plan are acceptable: the optional administrator data-request query remains outside the batch without weakening access control or the already accepted mixed-moment semantics; the pending-deletion error matches existing staff behavior; the same-ID TRIP audit fixture strengthens the paired-predicate check; regrouped cases and the alternate empty-request fixture preserve coverage. Reviewed the Builder's EXPLAIN and mutation logs. Selective index conditions support account/target lookups, and local tiny-table sequential scans are reasonable; forced-index diagnostics are not a production benchmark. No migration is warranted by this evidence. The verification mutation produced the documented two failures before restoration.

Builder failure evidence remains recorded: the original full integration run failed on leftover data-request rows and a native profiles worker crash; the data-request file also failed alone, while profiles passed alone. The owner-approved cleanup and successful Builder rerun do not erase those failures. My independent full run below had no failed files, test/hook timeouts or worker crashes, so no failed-file rerun was necessary. Integration output includes pg overlapping-query deprecation warnings; these did not fail the suite.

Independent checks, run in AGENTS.md order on Node v24.15.0 / npm 11.12.1 (complete output in repository-root ignored logs):

| Check                                                                                        | Result                                                                    | Log                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `docker start travel-buddy-postgres`                                                         | PASS, exit 0                                                              | `reviewer-aad-docker.log`            |
| `npm ci`                                                                                     | SKIPPED as instructed: neither package.json nor package-lock.json changed | Not run                              |
| `npm run format:check`                                                                       | PASS, exit 0                                                              | `reviewer-aad-format-check.log`      |
| `npm run lint`                                                                               | PASS, exit 0                                                              | `reviewer-aad-lint.log`              |
| `npm run db:validate`                                                                        | PASS, exit 0                                                              | `reviewer-aad-db-validate.log`       |
| `npm run db:migrate:deploy`                                                                  | PASS, exit 0; 44 migrations, none pending                                 | `reviewer-aad-db-migrate-deploy.log` |
| `npm run typecheck`                                                                          | PASS, exit 0                                                              | `reviewer-aad-typecheck.log`         |
| `npm test`                                                                                   | PASS, exit 0; 35 files, 545 tests                                         | `reviewer-aad-unit.log`              |
| `npm run test:integration`                                                                   | PASS, exit 0; 49 files, 522 tests; 369.90 seconds                         | `reviewer-aad-integration.log`       |
| `npm run build`                                                                              | PASS, exit 0                                                              | `reviewer-aad-build.log`             |
| `npm audit --audit-level=high`                                                               | PASS, exit 0; 14 advisories: 1 low, 13 moderate                           | `reviewer-aad-audit.log`             |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` | PASS, exit 0; empty migration                                             | `reviewer-aad-migration-diff.log`    |
| `git diff --check 0b08020..0f6e086`                                                          | PASS, exit 0                                                              | `reviewer-aad-diff-check.log`        |

Only this review document was edited; check logs were created as requested. No code edits, commit, push or pull request.

Formatting: `npx prettier --write docs/work/admin-account-detail/review.md` passed (exit 0), recorded in `reviewer-aad-review-format.log`.

Builder reply: C1-1 applied. README "Account detail" now says that the
account is read first, then the counts in one READ COMMITTED transaction,
then, for administrators, the open data requests, and that under concurrent
writes these can come from slightly different moments. This is a docs-only
change; no code changed.
