# Admin user search

- **Roadmap:** new item, the first backend step towards an admin panel. It is
  not in the numbered list yet; during the build it is added to the "Found
  later" table in `docs/roadmap.md`.
- **PRD sections:** §6.4 (moderators suspend accounts and restrict features),
  §14 FR-15 (authorised staff manage reports, content and account states with
  audit logging), §15.1 (moderation console), §16 (Moderator/Admin role),
  §18 (least privilege, data minimisation, auditability).
- **Branch:** `feature/admin-user-search`.

## Problem

The backend already lets staff act on an account:

- `POST /api/v1/admin/users/:userId/suspend` and `.../restore`
- `POST /api/v1/admin/users/:userId/remove-profile-photo`
- `POST /api/v1/admin/users/:userId/restrictions`,
  `GET /api/v1/admin/users/:userId/restrictions`

Every one of these needs the account's UUID. Staff can find a UUID today only
from a report (`GET /admin/reports/:reportId`) or by querying the database.
No route lists or searches accounts. Checked on `main` at `193cb24`:
`grep -rn "'/admin" src` shows no `GET /admin/users` route, and
`src/modules/moderation/` has no user listing in its repository.

So a moderator who gets a complaint by email ("user Priya on the Manali trip
is harassing people"), or who wants to see every suspended account, cannot do
it without database access. An admin panel cannot offer a "Users" page either.

## Proposed behaviour

Two routes. Name and filter searches use `GET`; contact lookups use `POST` so
that an email address or phone number never appears in a URL (revised after
review S1-1).

### Access (both routes)

Staff only: moderators and administrators (decision D1). Both routes use the
existing `staffIdentity` check: `authenticateRequest` with `fresh: true`, then
`requireStaff`. So the errors are the existing ones, in this order:

| Status | Code                       | When                                         |
| ------ | -------------------------- | -------------------------------------------- |
| 401    | `UNAUTHENTICATED`          | Missing, invalid or revoked token            |
| 403    | `ACCOUNT_NOT_PROVISIONED`  | Token is valid but has no account            |
| 403    | `ACCOUNT_DELETION_PENDING` | Caller's account is pending deletion         |
| 403    | `ACCOUNT_SUSPENDED`        | Caller's account is suspended (staff or not) |
| 403    | `ACCOUNT_DISABLED`         | Caller's account is otherwise not active     |
| 403    | `STAFF_ONLY`               | Caller is an active account with role `USER` |

A staff member whose role is removed in the database gets `STAFF_ONLY` on the
next request, because the role is read on every request.

### `GET /api/v1/admin/users`

Query parameters (all optional):

| Parameter   | Type                                                 | Meaning                                                                                                                           |
| ----------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `query`     | string, 1 to 100 characters                          | Trimmed first. If it is a UUID, an exact match on the account ID. Otherwise a case-insensitive "contains" match on `displayName`. |
| `status`    | `ACTIVE`, `SUSPENDED`, `PENDING_DELETION`, `DELETED` | Filter by account status. Without it, `DELETED` accounts are left out (they have no name and no use in a search).                 |
| `staffRole` | `USER`, `MODERATOR`, `ADMIN`                         | Filter by role, e.g. "list all staff".                                                                                            |
| `page`      | integer ≥ 1, default 1                               | Same as the other admin lists.                                                                                                    |
| `pageSize`  | integer 1 to 100, default 20                         | Same as the other admin lists.                                                                                                    |

Validation:

- Raw `query` longer than 100 characters, an empty `query`, a bad enum value,
  `page=0` or `pageSize=101`: `400 REQUEST_ERROR` (schema validation).
- `query` whose trimmed value is shorter than 2 characters (including
  whitespace only): `400 INVALID_USER_SEARCH`.
- `query` whose trimmed value contains `@` or starts with `+`:
  `400 USE_CONTACT_LOOKUP`, telling the client to use the lookup route. This
  keeps contact searches out of the name search on purpose; display names
  rarely contain either.
- Unknown parameters are dropped silently, as on every other route (Fastify's
  default `removeAdditional`). This item does not change that.

With no parameters it lists every non-deleted account. Sorting is always
`createdAt` descending, then `id` descending, so pages are stable even when two
accounts share a timestamp. A page beyond the last returns empty `data` with
the correct `pagination`.

`%`, `_` and `\` in a name search are literal characters, not wildcards (the
plan must show how they are escaped).

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "displayName": "Priya S",
      "status": "ACTIVE",
      "staffRole": "USER",
      "createdAt": "2026-10-01T09:30:00.000Z",
      "hasProfilePhoto": true,
      "activeRestrictions": ["MESSAGING"],
      "openReportCount": 2
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1 }
}
```

- `displayName` is `null` when the account has none (for example, deleted
  accounts).
- `hasProfilePhoto` is `false` when the account has no profile row or no photo.
  The storage key is not returned.
- `activeRestrictions` lists each feature with a restriction where
  `liftedAt` is null, `startsAt <= now` and `endsAt` is null or `> now`.
  Sorted, no duplicates, no reasons.
- `openReportCount` counts reports with `reportedUserId` equal to the account
  and status `SUBMITTED` or `UNDER_REVIEW`.

The response **never** contains email addresses, phone numbers, birth dates,
home city, biography, Firebase IDs, storage keys or restriction and moderation
reasons.

### `POST /api/v1/admin/users/lookup`

Exact lookup of the account that owns a stored contact.

Body (`additionalProperties: false`; unknown body fields are dropped as on
other routes):

```json
{ "type": "EMAIL", "value": "priya@example.com" }
```

- `type`: `EMAIL` or `PHONE`.
- `value`: string, 3 to 320 characters (the database column limit).
- `EMAIL` values are trimmed and lower-cased, as `verifiedContacts` does at
  storage time. `PHONE` values are trimmed only and must match the stored
  value exactly (Firebase's E.164 form, e.g. `+919876543210`).

Response `200`: `{ "data": <one item in the same shape as above> }`, or
`{ "data": null }` when nothing matches. The contact value is never echoed.
A lookup ignores status: it can find a suspended or pending-deletion account.
Deleted accounts never match, because erasure deletes their identities.

**What is searchable (review S1-3).** Only contacts stored in `auth_identities`:

- An email is stored only when Firebase reports it as verified. An unverified
  email has no row and cannot be found.
- Contacts are written when the account is created and when the user calls
  `POST /me/verification-signals/refresh`, not on every sign-in. A contact the
  user changed in Firebase is searchable only after a refresh.

These limits are documented in the README.

### Audit and monitoring

Inside one transaction, a lookup that finds an identity writes one
`ModerationAction` before returning the result:

- `action: USER_LOOKED_UP` (new enum value), `actorId` = the staff member,
  `targetType: USER`, `targetId` = the matched account.
- Fixed `reason`: `Staff looked up an account by email.` or `... by phone.`
- The searched value is **not** stored.

If the audit write fails, the request fails with `500` and the result is not
returned. A miss writes no `ModerationAction`; a target UUID is never invented
for it.

Every lookup that passes authentication, staff check and body validation
writes one application log line, `event: admin_user_lookup`, with the staff
ID, the contact type and an `outcome` of `hit`, `miss` or `failed` (the read
or audit write threw), and **never** the value. This lets item 36
(monitoring) alert on one staff account making many lookups or misses without
storing what was searched (review S2-2).

Requests rejected earlier (`401`, `403`, `400`, `429`) do not write this line.
They are already logged by the shared error handler as "Request rejected" with
only the status and code, and the rate-limit plugin logs no URL or body.

The `GET` name search is not audited. PRD §18 asks for audit logs on material
changes, not on every read. It does return private moderation metadata
(status, role, restrictions, report counts), but only to active staff who can
already see it through the report and restriction routes.

`GET /admin/moderation-actions` already returns every action type, so admins
see `USER_LOOKED_UP` entries with no further change.

### Keeping contacts and searches out of logs (review S1-1)

- Contacts go only in the `POST` body. Fastify does not log request bodies,
  and no route in this repository does.
- Both new routes log their request URL **without the query string**
  (route-level log serializer), so names searched with `GET` stay out of the
  logs too. Other routes are unchanged.
- **Unexpected errors are sanitised before the shared logger (review S2-1).**
  The shared handler in `src/app.ts` logs the full error object for every
  `5xx`, and Prisma error messages can contain query arguments (the searched
  name or contact). So on both routes, any error from the database read or the
  audit write that is not an `AppError` is caught in the route. The route logs
  one safe line (error class name and, if present, the Prisma error `code`; no
  message, stack, `cause` or `meta`) and then throws a new
  `AppError(500, 'INTERNAL_SERVER_ERROR', ...)` with a fixed message and no
  cause. The shared handler therefore logs only that fixed error. The client
  sees the same `500` body as today. Other routes are unchanged.
- Both routes send `Cache-Control: no-store` on every response, including
  errors and `429`, so the header must be set by a route hook that runs for
  every reply, not only in the handler (the plan names the hook).
- Any error message the routes return never repeats the searched value.

### Edge cases

- `query` that is a UUID of no account: empty `data`, `200`.
- `query` combines with `status` and `staffRole` (AND).
- An account that becomes deleted between pages simply drops out; the count
  can shift by one, as with the other admin lists.
- The searching staff member appears in results like any other account.
- Duplicate active restrictions on one feature appear once.

## Data

- One migration: add `USER_LOOKED_UP` to the `ModerationActionType` enum.
  Nothing else changes; no backfill.
- No new index in this item. `users` has an index on `status`; a
  case-insensitive "contains" on `display_name` is a sequential scan, which is
  fine at beta size (thousands of rows). A trigram index can come later if
  monitoring (item 36) shows slow searches. Contact lookups use the existing
  unique index on `auth_identities (type, normalized_value)`.

## Privacy, safety and abuse

- Least privilege: the response has only what a moderator needs to pick the
  right account and decide what to open next.
- Contact lookups are exact-match only, so staff cannot browse emails by
  prefix. They stay out of URLs and logs, hits are audited and every attempt
  is counted in the logs.
- Re-authentication and the current role are checked on every request, so a
  revoked token or a removed role loses access at once.
- Rate limits per account: 60 per minute for `GET /admin/users`, 20 per minute
  for the lookup (decision D4). The global default is 100.
- **Residual risk, accepted in D2 and D4:** a compromised staff account can
  still page through all accounts (about 6,000 rows a minute) or guess contacts
  at 20 a minute. Detection relies on the lookup log lines and the
  `USER_LOOKED_UP` audit trail, with alerting in item 36.

## Out of scope

- A full user detail route (`GET /admin/users/:userId` with trips, reports and
  moderation history). Suggested as the next item.
- Granting or revoking staff roles through the API (still the CLI).
- Any admin panel frontend.
- Trigram or full-text search on names.
- Refreshing a user's contacts from Firebase during a lookup.
- Searching trips, messages or posts.

## Acceptance criteria

Access:

- [ ] No token or a revoked token: `401 UNAUTHENTICATED` on both routes.
- [ ] Active ordinary user: `403 STAFF_ONLY`. Staff whose role was removed in
      the database: `403 STAFF_ONLY` on the next request.
- [ ] Suspended staff: `403 ACCOUNT_SUSPENDED`. Staff pending deletion:
      `403 ACCOUNT_DELETION_PENDING`.
- [ ] A moderator and an administrator both get `200` on both routes.

`GET /admin/users`:

- [ ] Without filters: non-deleted accounts, `createdAt` then `id`
      descending (checked with two accounts sharing a `createdAt`), standard
      `pagination`; a page past the end returns empty `data`.
- [ ] `query` with a UUID returns exactly that account (or none).
- [ ] `query` with part of a display name matches case-insensitively; `%`,
      `_` and `\` match only literally.
- [ ] `query` of `"a"`, `"  a  "` or spaces only: `400 INVALID_USER_SEARCH`.
      `query` over 100 characters, `pageSize=101` or `page=0`:
      `400 REQUEST_ERROR`.
- [ ] `query` containing `@` or starting with `+`: `400 USE_CONTACT_LOOKUP`.
- [ ] `status` and `staffRole` filters work alone and with `query`;
      `status=DELETED` returns deleted accounts.
- [ ] `hasProfilePhoto` is `false` for an account with no profile row.
- [ ] `activeRestrictions` excludes lifted, expired and future restrictions,
      includes one with no end date, and lists a doubly restricted feature
      once. `openReportCount` counts only `SUBMITTED` and `UNDER_REVIEW`
      reports against that account.
- [ ] Each item has exactly the keys listed above.

`POST /admin/users/lookup`:

- [ ] A stored email in any letter case and with surrounding spaces finds
      its owner; a stored phone finds its owner.
- [ ] An email or phone with no stored identity returns `{ "data": null }`.
- [ ] A suspended account is found; a deleted one is not.
- [ ] A hit writes one `USER_LOOKED_UP` action with the caller as `actorId`,
      the match as `targetId` and a reason without the value. A miss writes
      none.
- [ ] If the audit write fails, the response is `500` and contains no
      account (unit test with a failing repository).
- [ ] `type` other than `EMAIL` or `PHONE`, or a missing or too-long `value`:
      `400 REQUEST_ERROR`.

Logs and limits:

- [ ] With logs captured, a successful lookup, a miss, an invalid body, an
      unauthorised request, a `429`, a failing database read and a failing
      audit write never contain the contact value, raw or URL-encoded. A
      `GET` name search, including one whose database read fails, never logs
      the searched name.
- [ ] Each authorised, valid lookup writes exactly one `admin_user_lookup`
      line with `outcome` `hit`, `miss` or `failed`; rejected requests write
      none.
- [ ] Both routes send `Cache-Control: no-store` on `200`, `400`, `403`,
      `429` and `500` responses.
- [ ] The 61st `GET` and the 21st lookup in one minute from one account
      return `429`.

Docs and checks:

- [ ] README "Staff moderation" section (including the contact limits),
      `docs/backend-remaining-work.md` and `docs/roadmap.md` describe the
      routes.
- [ ] All checks in `AGENTS.md` pass.

## Decisions for the owner

Owner approved the spec on 2026-11-06 ("proceed") with every recommended
default below.

| #   | Decision                                              | Recommended default                                                                                                                                                                  |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Who may search: moderators and admins, or admins only | **Moderators and admins.** Moderators already suspend and restrict by user ID and need to find the account.                                                                          |
| D2  | Exact email and phone lookup                          | **Allowed for all staff, exact match only, by `POST`, hits audited and every attempt logged, accepting the residual guessing risk above.** Alternatives: admins only, or not at all. |
| D3  | Include `openReportCount` and `activeRestrictions`    | **Yes.** They save one request per row in a panel; they cost two grouped queries per page.                                                                                           |
| D4  | Rate limits                                           | **60 per minute for search, 20 per minute for lookup, per account.**                                                                                                                 |
