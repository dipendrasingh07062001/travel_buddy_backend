# Admin account detail

- **Roadmap:** found later (not in the original 39); fourth admin panel step,
  after admin user search (PR #64), staff role management (PR #65) and admin
  actions on data requests (PR #66).
- **PRD sections:** §6.4 (moderators remove content, restrict features,
  suspend accounts and keep an internal audit record), §14 FR-15 (authorised
  staff manage reports, content and account states with audit logging), §15.1
  (moderation console and audit logs).
- **Branch:** `feature/admin-account-detail`, from `main` at `0b08020`.

## Problem

Staff can find an account (`GET /admin/users`, `POST /admin/users/lookup`)
and act on it (suspend, restore, restrict, remove the profile photo, change
the staff role). There is no single place to look at an account before
acting. Today the admin panel would have to piece the picture together, and
some of it cannot be read at all:

- **Search summary only.** A search row has status, role, active restriction
  features and an open report count. It has no deletion details, no
  verification state, no report history and no content counts.
- **Reports cannot be filtered by account.** `GET /admin/reports` filters
  only by status. `reportedUserId` is set only for `USER` and `PROFILE_PHOTO`
  reports (`safety.repository.ts`). Reports on a trip, post, comment, message
  or connection request do not record whose it is, so staff cannot list
  what was reported about one person.
- **The audit trail cannot be filtered.** `GET /admin/moderation-actions`
  (administrators only) pages through every action ever taken.

What exists and is reused:

- `staffIdentity` (fresh Firebase check plus `requireStaff`) and
  `requireAdmin`.
- The admin user routes' scope (PR #64): `Cache-Control: no-store`, a log
  serializer that drops the query string, and `guard`, which replaces database
  errors with a fixed `500` before logging.
- `GET /admin/users/:userId/restrictions`: the full restriction history,
  with reasons. The detail does not repeat it.
- The search summary's `openReportCount`: `SUBMITTED` or `UNDER_REVIEW`
  reports with `reportedUserId` = the account.

## Proposed behaviour

### Which reports are linked to the account

Only reports whose row already names the account are linked to it here:

- `reportedUserId` = the account: `USER` and `PROFILE_PHOTO` reports, "about
  the account";
- `reporterId` = the account: reports it filed;
- `reviewerId` = the account: reports it claimed.

The staff report list already returns all three fields on every row today,
so these counts and the filter only save paging.

Reports on content (`TRIP`, `COMMUNITY_POST`, `COMMUNITY_COMMENT`,
`MESSAGE`, `CONNECTION_REQUEST`) carry only the content ID. Today staff link
such a report to a person only through `GET /admin/reports/:reportId`, which
first writes a `REPORT_INSPECTED` audit row. This item keeps it that way, and
neither lists nor counts content reports per account (D5).

- **Even a count would leak.** If the report list holds one open message
  report and the detail shows account A with one open content report, staff
  learn that A sent that message. A change in a count over time reveals the
  same thing.
- **"Public" content is not always public:** a trip may be member-only, and a
  post or comment may be removed, hidden by the author's activity setting, in
  an inactive community, or written by an erased author.

### `GET /api/v1/admin/users/:userId`

Staff only (moderators and administrators, D4). Callers are checked with
`staffIdentity`, as on every staff route; a suspended, pending-deletion or
deleted caller is refused by the existing rules. 60 requests a minute per
account, as for search. Every response, including `401`, `429` and the
guarded `500`, has `Cache-Control: no-store`.

- `userId` must be a UUID (`400 REQUEST_ERROR`).
- An unknown ID gives `404 USER_NOT_FOUND`.
- Any account can be viewed, read-only: every status (including `DELETED`,
  which search hides unless asked), every staff role, and the caller's own
  account.

Response `data`:

- **`account`:**
  - `id`, `displayName`, `status`, `staffRole`, `createdAt`;
  - `deletedAt` and `recordsPurgedAt` (each a date or `null`);
  - `statusBeforeDeletion`: the status a `PENDING_DELETION` account returns
    to if the user cancels (or `null`);
  - `hasProfilePhoto`;
  - `hasVerifiedEmail` and `hasVerifiedPhone`: whether the account has an
    `EMAIL` or `PHONE` identity with `verifiedAt` set. Identities are
    stored when the account is created (`verifiedContacts`: an email only
    when Firebase marks it verified, a Firebase phone number always) and
    replaced only by the explicit profile-signal refresh. A later sign-in
    does not update them. So the flags show the last recorded state, not a
    live check. Never the contact value.
- **`activeRestrictions`:** each active restriction's `id`, `feature`,
  `startsAt` and `endsAt` (or `null`). Active means not lifted, already
  started, and not yet ended, the rule used for the search summary. No
  reasons. The `id` is what `POST /admin/restrictions/:restrictionId/lift`
  needs.
- **`reports`:** two groups, each with counts by status: `submitted`,
  `underReview`, `actioned`, `dismissed` (see "Which reports are linked to
  the account").
  - `aboutAccount`: `reportedUserId` = the account. Its
    `submitted + underReview` equals the search summary's `openReportCount`;
  - `filed`: reports the account submitted. Helps spot misuse of reporting.

  There is no count of reports on the account's content (D5).

- **`claimedReportCount`:** reports `UNDER_REVIEW` with this account as
  reviewer, whatever its current role. A former moderator keeps claimed
  reports after the role is removed (PR #65), so the count can be non-zero
  for an ordinary user, as in the staff role response.
- **`content`:** counts only, never the content. Each group's buckets are
  separate (no overlap):
  - `trips`: trips owned, any status;
  - `communityPosts`: `draft`, `published`, `removed`;
  - `communityComments`: `visible` (`ACTIVE` or `EDITED`), `removed`;
  - `blockedByCount`: how many accounts have blocked this one. Not who.
- **`openDataRequests`** (D2): for administrators, the account's `OPEN` data
  requests, oldest first, each with `id`, `type`, `createdAt` and
  `scheduledFor`, or `[]` if there are none. For moderators it is `null`:
  they cannot see data requests today (PR #66).

**All counts are of the rows that exist now, not lifetime totals.**

- Erasure deletes the profile, identities and blocks, marks the account's
  community posts and comments `REMOVED`, and keeps trips and reports. So a
  `DELETED` account shows `hasProfilePhoto`, `hasVerifiedEmail` and
  `hasVerifiedPhone` as `false` and `blockedByCount: 0`. Its posts and
  comments count as `removed`, and its trips and reports still count.
- The later purge (`recordsPurgedAt` set) only blanks text and evidence. It
  deletes no rows and changes no count.

The view is not audited (D3). It shows no contacts, content, reasons or
other people's identities, the same level as the name search, which is not
audited either.

### `GET /api/v1/admin/reports?userId=...` (D1, D5)

A new optional `userId` (UUID) filter on the staff report list, combined with
`status`. It returns only the account's `aboutAccount` reports: those whose
`reportedUserId` is the account. That field is already in every list row, so
the filter reveals nothing staff cannot see today; it only saves paging.

Content reports are left out (D5), whatever the content's visibility.
Linking a trip, post, comment, message or connection request to its owner
still needs the audited report detail.

- An unknown but valid `userId` gives an empty page.
- Order (oldest first), paging and response fields are unchanged.
- `pagination.totalItems` counts the filtered reports.
- The route is open to staff, as today.

### `GET /api/v1/admin/moderation-actions?targetType=...&targetId=...` (D1)

New optional filters on the audit trail, still administrators only:

- `targetType` (a `ReportTargetType`) and `targetId` (a UUID) must be sent
  together. One without the other gives `400`. Requiring both lets the query
  use the existing `(target_type, target_id, created_at)` index.
- `targetType=USER&targetId=<account>` lists the actions on an account.
- Order (newest first), paging and response fields are unchanged.
- `pagination.totalItems` counts the filtered rows.
- Unknown IDs give an empty page.

## Data

No migration is expected:

- reports have indexes on `reportedUserId`, `reporterId` and `reviewerId`;
- trips have one on `ownerId`;
- posts and comments have one on their author;
- blocks have one on `blockedId`; restrictions are found through `userId`;
- audit rows have one on `(targetType, targetId, createdAt)`, which the
  paired filter matches.

The plan checks each query with `EXPLAIN` and judges the access path
against realistic table sizes and selectivity, not tiny fixtures. A
sequential scan is fine where PostgreSQL rightly prefers it, such as a small
table or a low-selectivity count. The plan proposes an index migration, for
owner approval, only where the evidence shows that a query would scan a large
table to find a few rows.

## Privacy, safety and abuse

- **No contacts:** only `hasVerifiedEmail` and `hasVerifiedPhone`. Values
  stay with `POST /admin/users/lookup`, which audits each match. The test
  checks that the body has no stored contact value.
- **No content and no reasons:** counts only. Restriction reasons, report
  details and audit notes stay on their routes, with their current access
  rules.
- **Content ownership stays behind inspection (D5).** Neither the detail
  nor the filter links a content report to an account, not even as a count.
  Every report count and filter result uses a field already on every list
  row: `reportedUserId`, `reporterId` or `reviewerId`. Linking any reported
  trip, post, comment, message or connection request to its owner still
  needs the audited report detail, including for member-only, removed or
  hidden content.
- **No identities of others:** `blockedByCount` is a number, and report
  counts name no reporter.
- **Data requests stay administrator-only**, as decided in PR #66.
- **Logging:** the detail's path holds only an account ID, already logged by
  other staff routes. The filters' IDs sit in query strings. The report and
  audit routes keep their current logging; these are account IDs, not
  contacts. Database errors on the detail go through `guard`.
- **Rate limit:** 60 a minute per account bounds scraping by a compromised
  staff token.

## Out of scope

- The admin web app itself (separate item, after the backend steps).
- Lists of an account's trips, posts, comments or messages for staff.
- Filtering the audit trail by actor, action or date.
- Editing an account's profile, name or contacts.
- Community cover images (next backend admin item).

## Acceptance criteria

- [ ] `GET /admin/users/:userId` callers:
  - [ ] no token, an invalid token or a revoked token gives `401` with
        `no-store`;
  - [ ] an ordinary user gives `403 STAFF_ONLY`;
  - [ ] a suspended moderator gives `403 ACCOUNT_SUSPENDED`;
  - [ ] a pending-deletion moderator is refused, as by the other staff
        routes;
  - [ ] a moderator and an administrator get `200`.
- [ ] Targets:
  - [ ] a non-UUID ID gives `400`, and an unknown ID gives
        `404 USER_NOT_FOUND`;
  - [ ] the caller's own account, an administrator, a moderator and a former
        moderator can all be viewed.
- [ ] `account` matches the database for `ACTIVE`, `SUSPENDED`,
      `PENDING_DELETION` (with `statusBeforeDeletion`) and `DELETED` (with
      `deletedAt`). A purged account also has `recordsPurgedAt`.
- [ ] `hasVerifiedEmail` and `hasVerifiedPhone`:
  - [ ] no identity gives `false`;
  - [ ] an identity with `verifiedAt` null gives `false`;
  - [ ] a verified identity gives `true`;
  - [ ] each type is tested, including an account with both types and one
        with an unverified email and a verified phone;
  - [ ] the body never contains a stored contact value.
- [ ] `activeRestrictions` lists only active ones (lifted, expired and
      future ones are left out), with no `reason`.
- [ ] Report counts, with fixtures covering:
  - `aboutAccount` and `filed` in every status;
  - `aboutAccount.submitted + underReview` equal to the search summary's
    `openReportCount`;
  - reports on the account's content, of every content type: they change
    no count. In particular, an account whose only report is one open report
    on its private message shows all zeros, and the body has no field about
    content reports.
- [ ] `claimedReportCount` counts only `UNDER_REVIEW` reports with this
      reviewer, including for a former moderator whose role is `USER`.
- [ ] `content` counts each bucket: trips of several statuses, posts in each
      status, comments in each status, and blockers. The body names no
      blocker.
- [ ] A `DELETED` account before and after the purge has the same counts.
      Removed community content counts as `removed`, retained trips and
      reports still count, and the verification flags and `blockedByCount`
      read `false` and `0`.
- [ ] `openDataRequests` for an administrator:
  - lists only that account's `OPEN` requests;
  - is `[]` when there are none.

  For a moderator it is `null`.

- [ ] Response schemas have `additionalProperties: false`, and no field
      outside this spec appears.
- [ ] A database failure in the detail gives the fixed `500` with
      `no-store`, and the error is logged without the raw database message.
- [ ] `GET /admin/reports?userId=`:
  - [ ] returns the account's `USER` and `PROFILE_PHOTO` reports, in the
        current order;
  - [ ] returns none of the reports on its content, for every content
        type, including a member-only trip, a removed post and a comment by
        an erased author;
  - [ ] writes no audit row;
  - [ ] combines with `status`;
  - [ ] `totalItems` is the filtered count; an unknown valid ID gives an
        empty page;
  - [ ] a non-UUID gives `400`;
  - [ ] without `userId` it behaves as before (existing tests pass).
- [ ] `GET /admin/moderation-actions?targetType=&targetId=`:
  - [ ] returns only rows with that target, newest first, with filtered
        `totalItems`;
  - [ ] `targetId` without `targetType`, or the reverse, gives `400`, and so
        does a non-UUID `targetId`;
  - [ ] it is still administrators only (`403 ADMIN_ONLY` for a moderator);
  - [ ] without the filters it behaves as before.
- [ ] `no-store` on the detail's `200`, `400`, `401`, `403`, `404`, `429` and
      `500`; the 61st detail request in a minute gives `429`.
- [ ] README "Finding accounts" documents the detail and both filters; the
      roadmap and remaining-work docs are updated.

## Decisions for the owner

- **D1. Add the two list filters in this item?** Recommended: yes. Without
  them the detail shows counts the panel cannot open. Both are small
  additions to existing routes, with no change for current callers. The
  alternative is the detail only, with the filters as a later item.
- **D2. Show open data requests in the detail?** Recommended: yes, for
  administrators only (`null` for moderators), matching PR #66. A pending
  deletion or access request matters before suspending or restoring an
  account. The alternative leaves them out; administrators would use
  `GET /admin/data-requests`.
- **D3. Audit each detail view?** Recommended: no. The detail shows no
  contacts, content, reasons, other people's identities or links between the
  account and a reported item, not even as a count (D5). Every report number
  comes from fields the report list already shows. That is the same level
  as the name search, which is not audited. Contact lookups and report inspections stay audited. The alternative writes a `USER_VIEWED` action per
  view, which needs an enum migration and fills the trail that D1 makes
  filterable.
- **D4. Who can open the detail?** Recommended: moderators and
  administrators, like search, because moderators act on accounts. The
  alternative is administrators only.
- **D5. Reports on the account's content: list or count them?**
  Recommended: neither. The filter returns, and the detail counts, only
  reports that already name the account on the list row (about the account,
  filed by it, claimed by it). Linking a reported trip, post, comment, message
  or connection request to its owner still needs the audited report detail.
  Even an exact count can give the link away when only one report is open
  (round 3, S3-1). The cost: the detail does not warn that the account's
  content has open reports. Moderators still find them in the report queue.
  The alternatives:
  - show a content-report count anyway, accepting that it can sometimes link
    a report to the account without an audit row;
  - list or count them, and write a new audit row for each view that does.
    That needs a migration and is a bigger change.
