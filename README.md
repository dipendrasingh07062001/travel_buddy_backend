# Travel Buddy API

Node.js and TypeScript backend for the Travel Buddy platform.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Docker Desktop for local PostgreSQL

## Local setup

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate:deploy
npm run db:seed
npm run dev
```

On Windows PowerShell, copy the environment file with:

```powershell
Copy-Item .env.example .env
```

The API runs at `http://localhost:3000` by default.

- API documentation: `http://localhost:3000/docs`
- Health endpoint: `GET http://localhost:3000/api/v1/health`
- Readiness endpoint: `GET http://localhost:3000/api/v1/readiness`
- Browse public trips: `GET http://localhost:3000/api/v1/trips`
- Public trip details: `GET http://localhost:3000/api/v1/trips/:tripId`
- Firebase account bootstrap: `POST http://localhost:3000/api/v1/auth/bootstrap`
- Current user: `GET http://localhost:3000/api/v1/me`
- Update current profile: `PATCH http://localhost:3000/api/v1/me/profile`
- Public user profile: `GET http://localhost:3000/api/v1/users/:userId`
- Create a private trip draft: `POST http://localhost:3000/api/v1/trips`
- List the current user's trips: `GET http://localhost:3000/api/v1/me/trips`
- List created/joined memberships: `GET http://localhost:3000/api/v1/me/trip-memberships`
- Private trip-change history: `GET http://localhost:3000/api/v1/trips/:tripId/history`
- Administrator summary counts: `GET http://localhost:3000/api/v1/admin/metrics/overview`
- Browse destination communities: `GET http://localhost:3000/api/v1/communities`

The health endpoint reports whether the Node.js process is running. The
readiness endpoint also checks whether PostgreSQL is reachable.

## Public trips API

`GET /api/v1/trips` supports these optional query parameters:

- `origin`: case-insensitive partial city match
- `destination`: exact community slug, such as `manali`
- `departureFrom` and `departureTo`: `YYYY-MM-DD` date window
- `minBudget` and `maxBudget`: inclusive budget overlap
- `minDuration` and `maxDuration`: inclusive trip-duration bounds, from 1 to
  365 calendar days; either bound may be supplied alone
- `availableOnly`: `true` returns only `PUBLISHED` trips with
  `currentGroupSize < desiredGroupSize`; defaults to `false`, which also
  includes `FULL` trips. A trip manually marked full is excluded even if its
  recorded group count is below capacity. This is also the PRD's trip-status
  filter: only `PUBLISHED` and `FULL` trips are ever public, so there is no
  separate `status` parameter. Each result's `status` shows whether it is full.
- `transport`: `BUS`, `TRAIN`, `FLIGHT`, `CAR`, `MOTORCYCLE`, `OTHER`, or
  `UNDECIDED`
- `sort`: `newest` (default), `departure_asc`, or `date_overlap`
- `page` and `pageSize`: page-based pagination; page size is capped at 100

Only `PUBLISHED` and `FULL` trips in active communities are public. Draft,
paused, cancelled, and completed trips return `404` from the details endpoint so
their existence is not disclosed. Search and community trip lists also hide
trips whose end date has passed (UTC), and those trips no longer accept
connection requests. The details endpoint still returns them so shared links
keep working.

Joining still requires an accepted connection request; availability can change
between searching and approval.

`date_overlap` requires both `departureFrom` and `departureTo`. It orders trips
by the number of calendar days shared with that inclusive date window, highest
first, counting at most the trip's `durationDays` so a wide date window cannot
outrank an exact trip that fits. Ties use the smallest sum of start-date and end-date differences from
the requested bounds, then earliest departure, then trip UUID ascending. For
example, for 10–14 April, a 10–14 April trip sorts ahead of 9–15 April: both
overlap five days, but the first has closer boundaries. This compares the
published dates only; it does not assume the owner will move the trip within
their `flexibilityDays`, and it is not a traveller recommendation.

Sorting happens in PostgreSQL before pagination. Every sort uses the same
visibility rules and filters. Counts remain available when a requested page is
empty. Inverted date/budget/duration ranges, invalid duration/boolean values,
and overlap sorting without both dates return `400`.

The same query options are supported by
`GET /api/v1/communities/:slug/trips`; its destination comes from the community
path. The response format is unchanged. Example:

```http
GET /api/v1/trips?destination=manali&minDuration=3&maxDuration=5&availableOnly=true&departureFrom=2027-04-10&departureTo=2027-04-14&sort=date_overlap
```

Run `npm run db:seed` to load repeatable local sample data. The seed is safe to
run more than once. Open `/docs` after starting the server to explore the full
request and response schemas.

## Firebase authentication

Flutter signs users in with Firebase Authentication and sends the resulting ID
token on protected requests:

```http
Authorization: Bearer <firebase-id-token>
```

The backend verifies that token and links its Firebase UID to a local PostgreSQL
user. Tokens are checked in two ways:

- **Ordinary requests** check the token's signature and expiry locally, with
  no call to Google per request (Google's public signing keys are fetched and
  cached as needed).
- **Sensitive actions** also ask Firebase whether the account still exists,
  is enabled, and has not had its sessions revoked. These are sign-in
  (`POST /auth/bootstrap`), creating and cancelling data and deletion requests,
  `POST /me/data-export`, `POST /me/verification-signals/refresh`, and every
  `/admin/...` route. If Firebase cannot be reached or the Admin credentials
  are missing, they return `503 AUTHENTICATION_UNAVAILABLE`; they never fall
  back to the local check, and a local check earlier in the same request does
  not count.

The remaining trade-off: after a login is disabled, deleted, or revoked in
Firebase, ordinary requests keep working until that token expires, at most an
hour later; sensitive actions stop at once. Travel Buddy's own account status
(suspension, pending deletion) is checked on every request, so a ban made in
Travel Buddy applies immediately everywhere. Call
`POST /api/v1/auth/bootstrap` after the first Firebase sign-in. The
operation is idempotent and returns `201` only when it creates the local account.
Subsequent calls return `200`. `GET /api/v1/me` returns the authenticated local
profile.

Set `FIREBASE_PROJECT_ID` to the shared Firebase project ID. Firebase Admin
credentials are **required** wherever people sign in: without them, sign-in,
data requests, export, and staff routes return `503`. For local development,
set `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of a service-account
JSON file kept outside this repository. In deployed environments, use the
hosting platform's workload identity or secret manager. Never commit
service-account credentials.

Automated HTTP tests inject a fake token verifier and therefore do not need
Firebase credentials. Real Firebase requests require the project configuration.

## Policy acceptance foundation

Policy text is not stored or invented by this API. Once approved Terms, Privacy
Notice, and Community Standards are published, configure all six
`POLICY_*_VERSION` and `POLICY_*_URL` settings shown in `.env.example`. Document
links must use HTTPS. Until then, the public catalog reports
`configured: false`, and an acceptance attempt returns
`503 POLICIES_UNAVAILABLE`.
Keep each published document immutable at its version; publish a new version
when the text changes.

- `GET /api/v1/policies` lists the current approved document versions and links.
- `GET /api/v1/me/policy-acceptances` shows which current versions the signed-in
  account has accepted.
- `POST /api/v1/me/policy-acceptances` records one explicit acceptance using
  `{ "policyType": "TERMS", "version": "<current-version>", "accepted": true }`.

`PRIVACY` and `COMMUNITY_STANDARDS` use the same request shape. The backend
accepts only the server-configured current version, records its timestamp, and
makes a repeated request idempotent. A stale version returns
`409 POLICY_VERSION_CHANGED`; old acceptance records remain as history when a
new document version is published. The Flutter or web client must show the
actual linked document before asking for acceptance.

Once the policy documents are configured, actions that reach other people
require the account to have accepted the current version of all three:

- publishing a trip (`POST /trips/:tripId/publish`);
- asking to join a trip;
- sending or editing trip messages;
- creating or editing community posts and comments;
- uploading a profile photo.

Otherwise they return `409 POLICY_ACCEPTANCE_REQUIRED`, naming the documents
still to accept. Browsing, drafting trips, editing your own profile, managing
your trips and settings, exporting data and deleting the account stay
available. Publishing a new version of a document asks everyone to accept that
document again before their next such action. Without configured documents,
nothing is gated.

## User profiles

Authenticated adults can update their display name, birth date, general city or
region, biography, languages, travel interests, and activity-visibility
preferences with `PATCH /api/v1/me/profile`. Exact birth dates and privacy
settings are returned only to the authenticated account through `/me`.

`GET /api/v1/users/:userId` is public and deliberately returns an approximate
age range and account-creation month. It never returns exact birth date, email,
phone number, Firebase UID, internal photo storage key, or privacy settings.

### Profile photos

- `PUT /api/v1/me/profile-photo` uploads or replaces the photo. Send
  `multipart/form-data` with one file in the `photo` field: JPEG, PNG, or WebP,
  up to 5 MB.
- `DELETE /api/v1/me/profile-photo` removes it.

The API decodes and re-encodes every photo: it is rotated upright, cropped to
512x512, converted to WebP, and stripped of all metadata, including the GPS
location phones embed. Each upload gets a new random file name, and the
previous file is deleted. Both endpoints return the private user from `/me`.

Profile responses include `profilePhotoUrl`, a public URL on the R2 custom
domain, and `profilePhotoAvailable`. The URL never changes for a given photo,
so clients can cache it indefinitely. File storage is described under
[File storage (Cloudflare R2)](#file-storage-cloudflare-r2).

## Profile activity and factual verification signals

The basic profile, photo and privacy-setting APIs above are unchanged. These
additional endpoints provide paginated, minimal activity cards:

- `GET /api/v1/users/:userId/trips?period=upcoming&page=1&pageSize=20`
- `GET /api/v1/users/:userId/trips?period=past&page=1&pageSize=20`
- `GET /api/v1/users/:userId/community-posts?page=1&pageSize=20`
- `GET /api/v1/users/:userId/community-comments?page=1&pageSize=20`

Guests may read visible activity. An optional Bearer token applies the
identified viewer's blocks and existing trip membership. Invalid or disabled
authenticated viewers are rejected, not silently treated as guests. Missing,
inactive, pending-deletion, erased or mutually blocked target accounts return
`404` without revealing totals. Responses use `Cache-Control: private, no-store`.

Trip cards include only authored trips, never the person's private joined-trip
participation. Upcoming cards include unended, published/full trips in active
destinations. Past cards include only previously published trips marked
completed, not cancelled, draft, paused, unpublished or moderation-removed
plans. Marked completed is a user-entered status, not proof travel happened.

Past trip privacy applies per trip: `PUBLIC` permits guest cards;
`MEMBERS_ONLY` requires the viewer to still be an active accepted member of
that same trip; `PRIVATE` shows no cards on this public-profile surface,
including to the owner. Owners/current members use the existing private
My Trips/membership APIs for their private history. Cards never grant room,
message, member-list or expense access.

Community activity follows existing public feeds: only `PUBLIC` contributions
appear. `PRIVATE` and `MEMBERS_ONLY` remain hidden here even to signed-in
visitors; following a community does not grant access. Comments appear only
when their parent post, destination and author are also publicly visible to
the viewer. Removed content is excluded. Cards contain links/identifiers and
public titles/dates/destination metadata, not post/comment bodies, trip
descriptions, private contacts, member lists or financial records.

All lists use `page`/`pageSize` (defaults 1/20, maximum 100 per page) and reject
unsafe offsets. Trip cards sort by start date (upcoming ascending, past
descending), post cards by publication date descending, and comment cards by
creation date descending; UUID ascending breaks every tie. Visible totals and
cards share one database snapshot, including when a requested page is empty.

`GET /api/v1/users/:userId/verification-signals` returns one `EMAIL`/`PHONE`
signal per recorded type, with its `recordedAt`, source, explanation and
limitations. It never returns email/phone values, identity IDs, Firebase UIDs,
identity-document results, scores or an endorsement of a person. An absent
signal means **no stored verified claim**, not proof the provider currently
considers the contact unverified. `recordedAt` is when this backend observed
the claim, not the provider's original verification date or a live check.

After a Firebase contact/verification change, obtain a fresh ID token and call
`POST /api/v1/me/verification-signals/refresh` with the Bearer token and **no
request body**. The server reuses its verified Firebase claims, never
client-supplied `emailVerified` or phone values. It updates matching records,
removes contacts absent from those verified claims, and returns only dated
signals. An ordinary profile edit cannot award these signals. This endpoint
allows 10 requests per account per minute. A contact belonging to another
local account returns `409 IDENTITY_ALREADY_LINKED`; accounts are never
silently merged or contacts transferred. Refreshes recheck active account and
sign-in linkage inside the transaction and cannot recreate contacts after
account deletion/pending-deletion wins the race.

No new service, API key, schema migration or frontend change is required.

## Trip management

Authenticated users create trips as private drafts with `POST /api/v1/trips`.
They can list all of their own trips with `GET /api/v1/me/trips` and edit a
draft, published, or paused trip with `PATCH /api/v1/trips/:tripId`.

Trip status is not directly editable. Use the explicit lifecycle endpoints:

- `POST /api/v1/trips/:tripId/publish`
- `POST /api/v1/trips/:tripId/pause`
- `POST /api/v1/trips/:tripId/mark-full`
- `POST /api/v1/trips/:tripId/cancel`
- `POST /api/v1/trips/:tripId/complete`

Publishing requires a complete adult profile: display name, birth date, home
city, biography, and at least one language. An incomplete profile returns
`409 PROFILE_INCOMPLETE`. Drafts can be created before the profile is complete.
The same check applies to connection requests and community contributions.

A profile photo joins those requirements when `PROFILE_PHOTO_REQUIRED=true`
(PRD §5.4). It is off by default, and the API refuses to start with it on unless
all six `R2_*` storage settings are configured, so the photo can always be
uploaded. Browsing, reading and drafts never need a photo. If moderation removes
the photo, the account must upload a new one before those actions.

`currentGroupSize` counts travellers already committed to the trip, including
the owner and accepted members. The owner can raise it for companions who are
not on the platform, but not below the number of active members; that returns
`409 GROUP_SIZE_BELOW_ACTIVE_MEMBERS`.

Every edit or lifecycle request must include the latest version returned by the
API, for example `{ "expectedVersion": 2 }`. A stale version returns
`409 TRIP_VERSION_CONFLICT`; refresh the trip before retrying. This prevents one
device from silently overwriting a newer change from another device. Only the
owner may mutate a trip. The server validates date, budget, group-size,
community, ownership, and lifecycle rules.

Trip dates are either exact or a window (PRD §7.1), set by `dateMode`:

- `EXACT` (default): `startDate`–`endDate` are the trip, optionally flexible by
  `flexibilityDays`. The server derives `durationDays` from the dates; sending
  it returns `400`.
- `WINDOW`: a trip of the required `durationDays` somewhere between `startDate`
  and `endDate`, such as "any 3 days in December". The window spans at most 92
  days, must fit the trip length, and has no `flexibilityDays`.
- `weekendsOnly: true` (windows only): a weekend trip of at most 4 days; the
  window must include a Saturday or Sunday.

Switching `dateMode` drops settings of the old type: flexibility when moving to
a window, `weekendsOnly` when moving to exact dates. Rule violations return
`400 INVALID_TRIP_DATES`. See [date window rules](docs/trip-date-windows.md).

### My Trips and membership history

`GET /api/v1/me/trips` is unchanged: it lists only trips the caller created,
including drafts, and returns the owner's version and edit metadata.

`GET /api/v1/me/trip-memberships` provides the signed-in account's created
and joined trips, without accepting another user's ID. It supports:

- `view=active` (default): current `ACTIVE` memberships, including owner rows.
- `view=history`: only memberships the caller left or was removed from.
- `view=all`: current and former memberships together.
- `role=OWNER` or `role=MEMBER`: optionally narrow any view to created or
  joined trips.
- `tripStatus`: any trip lifecycle status, but **only with `view=active`**.
  Filtering former memberships by the current trip status could reveal changes
  made after access was revoked, so `history`/`all` with this filter returns `400`.
- `page` and `pageSize`: defaults 1 and 20, with at most 100 items per page.
  Unsafe pagination offsets return `400`.

Each item contains the caller's membership `id`, `tripId`, `role`, `status`,
`joinedAt`, `leftAt`, and `removedAt`, plus a `trip` summary for active members.
Former memberships always return `trip: null`: this endpoint does not expose
fresh trip details or restore room, message, member-list or ledger access.
The summary does not include owner write metadata, private contact details,
messages, expenses, or other memberships. Active members retain their private
trip summary even when a trip is paused, ended, cancelled, completed, hidden
from public discovery or in an archived destination.

"Active" describes membership, not whether the trip is upcoming. Completed
and cancelled trips remain in this view while the membership is active; use
`tripStatus=COMPLETED` or `tripStatus=CANCELLED` for those history screens.
Pending, declined, withdrawn and blocked connection requests are not memberships.
Re-joining after a new accepted request reuses the existing membership row;
the endpoint returns its latest state and join timestamp, not a timeline of
every previous join/leave event.

Results sort by `joinedAt` descending and membership UUID ascending. Counts,
membership state and trip summaries share one database snapshot. Empty and
out-of-range pages retain their total count. Responses are private and must
not be cached. Example requests:

```http
GET /api/v1/me/trip-memberships?role=MEMBER
GET /api/v1/me/trip-memberships?view=active&tripStatus=COMPLETED
GET /api/v1/me/trip-memberships?view=history&page=1&pageSize=20
```

## Public text privacy

Public-facing profile/trip/community text rejects supported contact and sensitive
personal-detail patterns with `400 PUBLIC_TEXT_PRIVACY_VIOLATION`, without echoing
the value. Public presenters replace matching legacy text with
`[Hidden for privacy]`; private owner profile/trip data and authorized review
originals remain stored. This is not a universal PII detector or a substitute for
reporting/moderation. See [covered fields, private-data boundaries and tests](docs/public-text-privacy.md).
No new API key, migration or production backfill is required.

## Trip-change history

Owners and current members can read recorded changes to trip plans, status and
group size. History is newest-version first, with `pageSize` and `beforeVersion`
pagination. Members see changes only from their latest join onward; leaving or
removal revokes access. Old trip changes are not backfilled. Description edits
are marked without storing old/new description text, and private staff notes
are never copied. See the [contract and privacy rules](docs/trip-change-history.md).

Track feature gaps in [remaining backend work](docs/backend-remaining-work.md)
and provider/deployment requirements in the [setup checklist](docs/backend-setup-checklist.md).

## Destination communities

Guests can browse active destination hubs and their public activity:

- `GET /api/v1/communities`
- `GET /api/v1/communities/:slug`
- `GET /api/v1/communities/:slug/trips`
- `GET /api/v1/communities/:slug/posts`
- `GET /api/v1/community-posts`

The list supports case-insensitive `search`, `sort` (`name` by default, or
`activity`), `page`, and `pageSize`. Community trip results reuse the objective
public-trip filters. Community posts can be filtered by `DISCUSSION`,
`QUESTION`, or `EXPERIENCE`; only published posts from active accounts whose
community activity is public are returned. `GET /api/v1/community-posts` lists
those posts across all active communities, newest first, with an optional
`community` slug filter. See [home discovery rules](docs/home-discovery.md).

Authenticated users follow communities with these idempotent operations:

- `POST /api/v1/communities/:communityId/follow`
- `DELETE /api/v1/communities/:communityId/follow`
- `GET /api/v1/me/followed-communities`

Archived communities are excluded from discovery and cannot be followed.

Authenticated users with a complete profile and public community-activity
visibility can participate through:

- `POST /api/v1/communities/:communityId/posts`
- `GET`, `PATCH`, or `DELETE /api/v1/community-posts/:postId`
- `GET` or `POST /api/v1/community-posts/:postId/comments`
- `PATCH` or `DELETE /api/v1/community-comments/:commentId`

Only authors may edit or remove their content. Removal is soft so moderation
evidence is retained. Public feeds exclude removed content, non-public account
activity, disabled accounts, and blocked authors for authenticated viewers.
Posts and comments can be reported through `POST /api/v1/reports` using
`COMMUNITY_POST` or `COMMUNITY_COMMENT` as the target type.

### Destination administration

Only an active `ADMIN` account can manage destination hubs; moderators cannot.
The backend provides these routes for an eventual admin interface:

- `GET /api/v1/admin/communities` and `GET /api/v1/admin/communities/:communityId`
  list or inspect active and archived hubs, including content/follower counts.
- `POST /api/v1/admin/communities` creates an active hub with a permanent slug.
- `PATCH /api/v1/admin/communities/:communityId` edits its name, region,
  country code, or description. The slug is immutable so shared links remain
  stable.
- `POST /api/v1/admin/communities/:communityId/archive` archives an **empty**
  hub; `/reactivate` restores an archived, non-merged hub.
- `POST /api/v1/admin/communities/:communityId/merge` moves trips, posts, and
  follows to another active hub. Duplicate follows are consolidated, keeping
  the earliest follow date. The old slug resolves to the canonical destination.
- `GET /api/v1/admin/community-actions` reads the audit trail; optionally
  filter by `communityId`.

Changes require an explanatory `reason` of at least 10 characters and the
latest `expectedVersion` from the detail/list response. Merge also requires
`targetCommunityId` and `expectedTargetVersion`. A stale version returns
`409 COMMUNITY_VERSION_CONFLICT`; refresh both hubs and retry deliberately.
Merge is a transaction and cannot be undone through the API. Review both hub
IDs and their content counts before submitting it. These routes are backend
capabilities only; the Flutter developer can choose how to expose them later.

## Connection requests and membership

An authenticated user with a complete minimum profile can send a short,
trip-specific request with `POST /api/v1/trips/:tripId/connection-requests`.
Requests are accepted only for published trips that have not ended and have
available group capacity.
Self-requests, duplicate requests, and more than 20 new requests in a rolling
24-hour period are rejected.

The daily quota is enforced per requester inside PostgreSQL, including when
requests reach different API instances at the same time. All request statuses
count until their creation time falls outside the rolling window; declining,
withdrawing, or blocking a request does not restore a quota slot. Quota rejection
returns `429 CONNECTION_REQUEST_LIMIT` without saving a request or notification.
See [concurrency rules and tests](docs/connection-request-limits.md). No new
database migration or client request/response change is required for this fix.

Users list their received or sent requests with
`GET /api/v1/me/connection-requests?box=received` or `box=sent`. The trip owner
can accept or decline a pending request. The requester can withdraw it.

A member who left a trip can ask to join it again with a new request, and the
owner accepts or declines it as before; accepting restores their membership.
Everyone else gets one chance per trip:

| Situation                                    | Error code                  |
| -------------------------------------------- | --------------------------- |
| Already an active member                     | `ALREADY_TRIP_MEMBER`       |
| Removed from the trip by the owner           | `REMOVED_FROM_TRIP`         |
| A request is waiting, declined, or withdrawn | `CONNECTION_REQUEST_EXISTS` |

- `POST /api/v1/connection-requests/:requestId/accept`
- `POST /api/v1/connection-requests/:requestId/decline`
- `POST /api/v1/connection-requests/:requestId/withdraw`
- `GET /api/v1/trips/:tripId/members`

Acceptance creates an active membership and updates trip capacity, version, and
automatic `FULL` status in one serializable database transaction. Only active
members can see the private member list. Reporting and blocking are enforced
across requests and private messaging.

## Private trip-room coordination

Every trip has one private group conversation. The owner joins when the trip is
created, and accepted members join in the same transaction that grants trip
membership. Active members use these endpoints:

- `GET /api/v1/trips/:tripId/room`
- `GET /api/v1/trips/:tripId/messages`
- `POST /api/v1/trips/:tripId/messages`
- `PATCH /api/v1/messages/:messageId`
- `DELETE /api/v1/messages/:messageId`
- `POST /api/v1/trips/:tripId/read`
- `PATCH /api/v1/trips/:tripId/room/preferences`
- `POST /api/v1/trips/:tripId/checklist-items`
- `PATCH` or `DELETE /api/v1/checklist-items/:itemId`
- `POST /api/v1/trips/:tripId/leave`
- `POST /api/v1/trips/:tripId/members/:memberId/remove`

Message history uses cursor pagination. Edits and soft deletions preserve an
internal revision trail, while deleted content is hidden from ordinary API
responses. Completed and cancelled trip rooms are read-only. Messages from a
blocked account are hidden from that user, and a two-person room cannot be used
to bypass a block. A member can report another member's message through
`POST /api/v1/reports` with `targetType` set to `MESSAGE`.

The room response includes the current shared trip plan and active checklist
items. Active members can create, edit, complete, and reopen checklist items;
only the item creator or trip owner can remove one. Checklist removal is soft
so internal history is retained.

Non-owner members can leave, and the trip owner can remove a non-owner member.
Both operations atomically retain membership history, revoke future room
access, reduce group capacity, increment the trip version, and reopen a `FULL`
trip as `PUBLISHED`. The owner cannot leave or be removed. New, edited, and
deleted messages reach open rooms live through the
[real-time stream](#real-time-updates).

## Shared expense ledger

Active trip members can record and review private INR expenses. Amounts are
integer **paise**: `1001` means ₹10.01. The payer and every split participant
must be an active trip member when a new expense is recorded. Existing shares
remain in the ledger after a member leaves. Former members lose ledger access,
while current members can still see their historical balances. Completed and
cancelled trips retain a readable ledger but accept no changes.

- `POST /api/v1/trips/:tripId/expenses` records an expense.
- `GET /api/v1/trips/:tripId/expenses?page=1&pageSize=20` lists expenses,
  including voided records, newest first.
- `GET /api/v1/trips/:tripId/expenses/balances` calculates paid, owed and net
  paise from active expenses.
- `GET /api/v1/expenses/:expenseId` returns one expense and its revision history.
- `PUT /api/v1/expenses/:expenseId` replaces an expense as its creator. Send the
  full expense body and `expectedVersion` from the latest response.
- `DELETE /api/v1/expenses/:expenseId` voids an expense as its creator. Send
  `{ "expectedVersion": 1 }`; the record and its shares remain available for
  audit, while balances exclude it.

Example equal split request:

```json
{
  "description": "Hotel",
  "category": "ACCOMMODATION",
  "amountPaise": 1001,
  "paidByUserId": "<owner-user-uuid>",
  "splitMethod": "EQUAL",
  "participants": [
    { "userId": "<owner-user-uuid>" },
    { "userId": "<member-a-uuid>" },
    { "userId": "<member-b-uuid>" }
  ]
}
```

For `CUSTOM`, supply a positive `amountPaise` for each participant; the shares
must sum exactly to the expense total. Equal split remainders go to members in
ascending UUID order, which makes the calculation repeatable. You may also set
`expenseDate` as a `YYYY-MM-DD` date no later than today; omission uses today's
UTC date. A stale `expectedVersion` returns `409 EXPENSE_VERSION_CONFLICT`.

The API explains that entries are member-provided and payments happen outside
the platform. The backend never processes money.

### Disputes and external settlements

Members affected by an expense can flag it with a reason. The flag is visible
to active trip members; a former member sees only their own flags. The reporter
may withdraw a flag, but the platform does not adjudicate it.

- `POST /api/v1/expenses/:expenseId/disputes` with `{ "reason": "..." }`
- `GET /api/v1/expenses/:expenseId/disputes`
- `POST /api/v1/expense-disputes/:disputeId/withdraw`

A member who owes money can record an external payment to a member with a
positive balance. The payer can cancel a pending record. Only the named receiver
can confirm or reject it. A pending or rejected record never changes balances;
confirmation rechecks the latest outstanding balance before applying it.

- `POST /api/v1/trips/:tripId/settlements` with
  `{ "receiverId": "<member-uuid>", "amountPaise": 500 }`
- `GET /api/v1/trips/:tripId/settlements` for active members
- `GET /api/v1/trips/:tripId/settlements/me` for a member's own records
- `POST /api/v1/settlements/:settlementId/confirm`
- `POST /api/v1/settlements/:settlementId/reject`
- `POST /api/v1/settlements/:settlementId/cancel`

`GET /api/v1/trips/:tripId/expenses/balances` keeps `netPaise` as the balance
from expenses alone and adds `remainingNetPaise`, `settlementsSentPaise` and
`settlementsReceivedPaise`. Confirmed payments reduce the outstanding amount;
they do not change the original expense history.

After leaving or removal, a member cannot access the full ledger or trip room.
`GET /api/v1/trips/:tripId/expenses/me` shows only their own balance and expense
lines, with no other participant shares. They can see their own settlements,
confirm or reject one addressed to them, record their own payment against an
outstanding balance, and flag an expense affecting them. These narrow actions
remain available after a trip is completed or cancelled so past obligations can
be reconciled; expense entries themselves remain read-only. A block prevents
new settlement records between the two accounts.

### Receipts

- `POST /api/v1/expenses/:expenseId/receipts` attaches a receipt. Send
  `multipart/form-data` with one file in the `receipt` field: a JPEG, PNG, or
  WebP image, or a PDF, up to 10 MB.
- `GET /api/v1/expenses/:expenseId/receipts` lists an expense's receipts.
- `DELETE /api/v1/expense-receipts/:receiptId` removes one.

Only the member who recorded or paid an expense can attach receipts, at most 5
per expense, and not to a voided expense or a read-only ledger. Any active
trip member can list them. The uploader or the expense's recorder can remove
one; the file is deleted, and a record that it existed stays in the ledger
history. Images are re-encoded like profile photos (WebP, at most 2000 px,
metadata stripped); PDFs are stored as uploaded.

Receipts are private. Each listed receipt has a `url` that is signed for that
request and stops working after 15 minutes (`urlExpiresAt`); list the receipts
again to get fresh links.

## In-app notifications

Important activity creates a durable notification in PostgreSQL in the same
transaction as the activity itself. The API provides an inbox and unread count
for the signed-in account:

- `GET /api/v1/me/notifications?page=1&pageSize=20&unreadOnly=false`
- `GET /api/v1/me/notifications/unread-count`
- `POST /api/v1/me/notifications/:notificationId/read`
- `POST /api/v1/me/notifications/read-all`

The inbox covers connection requests and decisions, trip plan/status changes,
new group messages, expense creation/edits/voiding, external settlement
requests/decisions, and [moderation actions](#moderation-notices) on the
user's own content or account. Notification
titles are generic; message text, financial
amounts and private profile details are not copied into notifications. A user
can read or mark only their own records. Muted trip rooms and blocked senders do
not produce new message notifications for that recipient. While a
[real-time stream](#real-time-updates) is open, a `notifications.changed` event
signals that the inbox changed; without one, poll the unread count modestly and
stop when the app is in the background.

### Saved matching-trip alerts

Users explicitly opt into private saved searches for **newly published trips**.
This is criteria matching, not a recommendation score or a booking guarantee.
It reuses the inbox and `notifications.changed` real-time event. This first
version is **in-app only**: matching alerts are stored with push delivery
`SKIPPED`, even when FCM is enabled. No new provider, key, or environment setting
is needed. Existing notifications keep their current push behavior.

All routes require a Firebase Bearer token for an active, bootstrapped account:

- `GET /api/v1/me/trip-alerts` lists only your saved searches (maximum 20).
- `POST /api/v1/me/trip-alerts` creates one, returning `201` and `version: 1`.
- `PUT /api/v1/me/trip-alerts/:alertId` **replaces all criteria**, using
  `expectedVersion` to protect against concurrent edits. Send the complete
  desired state; omitted optional filters are cleared. Use `enabled: false`
  to pause and `enabled: true` to resume.
- `DELETE /api/v1/me/trip-alerts/:alertId` unsubscribes and deletes the criteria
  (`204`). Other people's or nonexistent alert IDs return `404`.

Example creation body:

```json
{
  "name": "Manali holiday",
  "communityId": "<active-destination-community-uuid>",
  "enabled": true,
  "origin": "Delhi",
  "departureFrom": "2027-04-10",
  "departureTo": "2027-04-20",
  "minBudget": 10000,
  "maxBudget": 20000,
  "minDuration": 3,
  "maxDuration": 10,
  "transport": "BUS"
}
```

`name` (1–80 nonblank characters), exact destination `communityId`, and an
explicit `enabled` boolean are required. Nothing is enabled automatically.
All other filters are optional; omit them rather than sending `null`. For PUT,
also include the version you last read as `expectedVersion`. Money is in INR,
nonnegative, at most two decimal places (more returns
`400 INVALID_TRIP_ALERT_BUDGET`); responses use decimal strings. Date
windows overlap inclusively with the trip dates (not just its departure day),
or with a date-window trip's whole range, budget intervals overlap inclusively,
duration is 1–365 inclusive calendar days (a window trip's entered length), origin is a case-insensitive **literal** substring, and transport is an
exact enum match. A requested budget bound does not match an unknown relevant
trip-price bound. Currency conversion and flexibility-day expansion are not
performed. An alert with only a destination matches any eligible trip there.

The quota includes paused alerts. Concurrent creations cannot exceed it
(`409 TRIP_ALERT_LIMIT_REACHED`). Stale edits return
`409 TRIP_ALERT_VERSION_CONFLICT`. Creation and replacement each allow 20
requests per account per minute, subject to the normal global rate limit.
New/enabled destinations must be active. Archived/merged destinations do not
produce matches; users can still pause/delete old searches and explicitly
resave them against an active destination. Searches are not silently moved
to a different community. Managing private preferences does not activate or
bypass the publishing policy gate.

The first successful publication writes a durable `trip_publication_alerts`
job **inside the publishing transaction**. Existing trips are not backfilled.
Editing, re-opening capacity, or pausing/republishing does not create another
job. The API process polls every five seconds and processes at most 100 saved
searches per database transaction. Row locks allow multiple workers; saved
progress and notifications commit together. Errors roll back progress and
back off that job for a minute, allowing other publications to proceed.
Jobs survive restarts. No external queue or cron installation is required.
After updating the code, run `npm run db:migrate:deploy` before starting it.

For each batch, matching uses the **current trip fields** and only enabled
searches last saved **on or before the first publication timestamp**. Creating,
editing, or resuming a search does not retroactively subscribe to pending old
publications. A trip moved to a different destination closes its pending job;
it never silently retargets the job's audience. Trips must still be `PUBLISHED`, not ended (UTC), have free space,
an active destination and active owner, and not be removed by moderation. Full,
paused, cancelled, completed, expired and removed trips are skipped. The owner,
current active trip members, non-active accounts, and users blocked in either
direction receive no new match alert. An ineligible queued event is completed,
not replayed if its trip becomes eligible again later.

Two daily limits stop one account, or many, from flooding saved searches. An
account's first five trip publications in any 24 hours send alerts; later ones
in that window are still published and searchable but alert nobody;
simultaneous publications by one account are counted one at a time, so they
cannot all slip under the limit together. And a person receives at most ten
matching alerts in any 24 hours, read or unread, across all destinations and
even with several API instances processing alerts at once; further matches
are skipped for them, not delayed. Both numbers are provisional defaults in
`src/modules/trip-alerts/trip-alert.limits.ts`.

Overlapping saved searches still produce **at most one notification per user
per trip**. The generic `MATCHING_TRIP_PUBLISHED` notification uses the trip ID
as `sourceId` and `tripId`; no saved search name/criteria, description, contact
data, or price is copied into it. Fetch normal public trip details before
opening or requesting to join: a saved notification does not grant access or
reserve a place. A committed pause/delete stops future processing of that
search, but does not erase notifications already created. Saved criteria are
included in the owner's account-data export and erased with the account.

### Email notification foundation (real sending off)

The provider-neutral foundation is testable without a domain or an email API
key. **No real sender is configured**, no email worker runs, and source events
do not enqueue email while delivery is unconfigured. There is no console sender
that logs addresses and pretends to send, and no HTTP send-to-address endpoint.
Existing inbox/FCM behavior is unchanged; matching-trip alerts stay in-app only.

- `GET /api/v1/me/email-preferences` reads only your private preferences.
- `PATCH /api/v1/me/email-preferences` changes explicitly supplied categories.
  Both routes require an active, bootstrapped Firebase Bearer identity and
  return `Cache-Control: private, no-store`.

The four optional categories are `connections` (connection request events),
`trips` (trip plan/status updates), `finances` (shared expense/settlement updates)
and `safety` (currently profile-photo removal only). All default to `false`.
This does **not** create a mandatory legal/account-notice policy. Chat messages
and matching-trip events are not allowed into the email outbox.

An account with no saved preferences receives `version: 0`, `updatedAt: null`
and all categories off. Supply that version in the first update:

```json
{
  "expectedVersion": 0,
  "connections": true,
  "trips": true
}
```

Omitted categories are preserved, not enabled. Later edits must supply the
returned version as `expectedVersion`; stale/concurrent edits return
`409 EMAIL_PREFERENCE_VERSION_CONFLICT`. An update must change at least one
category and is limited to 20 requests per account/minute. `deliveryConfigured`
is currently `false` even if a category is opted in. Email addresses, other
account IDs and arbitrary delivery targets are never writable settings here.

When a reviewed real adapter is installed later, eligible **new** notifications
and their email outbox metadata are committed together. Duplicate event keys,
old inbox entries and later opt-in/configuration are not backfilled. A delivery
records its consent version, not an address or rendered message. Any preference
update skips existing pending email; re-enabling does not replay it. In-flight
requests cannot be recalled, so the worker rechecks consent/account eligibility
immediately before starting each send. Trip/financial emails additionally
require current active trip membership; blocks in either direction are honored.

The tested worker uses short `SKIP LOCKED` claims, claim-token guarded updates,
four bounded attempts, 30-second/2-minute/5-minute retry delays, two-minute stale
claim recovery and a 24-hour expiry. Reads and opted-out/inactive recipients
are skipped. External lookups/sends happen outside database transactions with
deadlines. A real adapter must enforce the stable per-notification idempotency
key across the whole retry/expiry window; after a timeout/crash it may be called
again. `SENT` means **provider accepted**, not inbox delivery. Bounce/complaint
processing belongs to the future provider integration. Raw provider errors,
addresses, message bodies and credentials are never stored in the queue or logs.

Recipient resolution queries the linked Firebase account's **current** email,
`emailVerified` and disabled state via Admin SDK, not historical `AuthIdentity`
rows. Missing/unverified/disabled provider accounts receive no email; temporary
lookup failures retry without falling back to an old address. Subjects are
generic inbox titles and plain text asks users to open the app; private message
text, prices, trip descriptions, contact details and trip IDs are not included.

Preferences and owned delivery metadata are included in account exports.
Erasure deletes preferences and notifications, cascading their outbox rows;
stale authenticated writes cannot recreate preferences after deletion begins.

No provider, key or `.env` activation switch is introduced by this milestone.
Real delivery still needs a domain/provider adapter, sender verification,
unsubscribe/suppression handling, bounce/complaint webhooks and live tests.
Track these in [the backend setup checklist](docs/backend-setup-checklist.md).
Run `npm run db:migrate:deploy` after pulling the merged migration before using
the new preferences API.

### Push notifications

Inbox notifications other than in-app-only matching-trip alerts can also be delivered as a push alert through
Firebase Cloud Messaging (FCM) to the recipient's registered devices. The inbox
in PostgreSQL stays the source of truth; push is a best-effort copy. Email is
not sent.

A device opts in by registering its FCM token after the user allows
notifications, and again whenever the token changes:

- `POST /api/v1/me/push-devices` with
  `{ "token": "<fcm-registration-token>", "platform": "WEB" }`. `platform` is
  `ANDROID`, `IOS`, or `WEB`. Registering the same token again refreshes it; a
  token registered by another account moves to that account.
- `GET /api/v1/me/push-devices` lists the account's devices. Tokens are never
  returned.
- `DELETE /api/v1/me/push-devices/:deviceId` stops alerts to one device. Call it
  when the user signs out or turns notifications off.

An account keeps at most 10 devices; registering an eleventh removes the least
recently registered one.

A background worker in the API process sends pending notifications every few
seconds. Each alert carries the same generic title as the inbox entry and a
`data` payload with `notificationId`, `type`, `sourceId`, and `tripId` when
there is one, so the client can open the right screen. The worker:

- skips alerts older than 15 minutes, alerts already read in the inbox, and
  recipients whose account is not active;
- deletes device registrations whose tokens FCM reports as no longer valid;
- retries an alert that no device received after 30 seconds, 2 minutes and 5
  minutes, then records it as `FAILED`;
- sends again alerts that a crashed or stopped API process claimed but never
  finished, after 5 minutes;
- records the outcome on each notification (`SENT`, `SKIPPED`, or `FAILED`)
  and never claims the same alert twice at once, even with several API
  instances running.

Each alert carries its notification ID as a collapse key (an Android and web
`tag`, and `apns-collapse-id` on iOS), so if an alert is ever sent twice, the
device replaces the first copy instead of showing both.

Push delivery is off unless `PUSH_NOTIFICATIONS_ENABLED=true`. Sending through
FCM needs Google credentials in addition to `FIREBASE_PROJECT_ID`: set
`GOOGLE_APPLICATION_CREDENTIALS` to a Firebase service-account key file, or use
the host's workload identity. Without credentials, the API keeps running and
logs `Firebase Cloud Messaging rejected the request: app/invalid-credential`.
Notifications created before this feature existed are never pushed.

## Real-time updates

`GET /api/v1/realtime/stream` is a
[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
stream for the signed-in account. One stream covers all of the account's trip
rooms and its notification inbox. Send the Firebase ID token in the
`Authorization` header like any other request. The browser's built-in
`EventSource` cannot send headers, so web clients use a fetch-based SSE client
such as `@microsoft/fetch-event-source`; Flutter clients can read the streamed
response directly.

| Event                   | Data                   | Meaning                                                    |
| ----------------------- | ---------------------- | ---------------------------------------------------------- |
| `ready`                 | Heartbeat and lifetime | The stream is connected                                    |
| `message.created`       | `{ tripId, message }`  | A new message in one of the account's trip rooms           |
| `message.updated`       | `{ tripId, message }`  | A message was edited                                       |
| `message.deleted`       | `{ tripId, message }`  | A message was deleted by its sender or by moderation       |
| `notifications.changed` | `{}`                   | The inbox changed; refetch the unread count or the inbox   |
| `resync`                | `{}`                   | Events may have been missed; refetch what the screen shows |

`message` has the same shape as in `GET /api/v1/trips/:tripId/messages`,
including `isOwn` for the receiving account, so a client can append it
directly. Events follow the same visibility rules as the message history:
only active members of the trip receive them, and messages are never delivered
across a block in either direction. A change that fails or rolls back is never
announced.

Client rules:

- After `ready` and `resync`, refetch the open room and the unread count.
  Events missed while disconnected are not replayed.
- The server sends a comment line every 25 seconds to keep the connection
  open, and ends every stream after 60 minutes. Reconnect with a fresh ID token
  whenever the stream ends; the `retry` field suggests waiting 5 seconds.
- An account can keep 5 streams open at once (`429 REALTIME_STREAM_LIMIT`).
- A client that stops reading is disconnected rather than buffered.

Every API instance holds one extra database connection that `LISTEN`s for
events, so streams work across several instances without extra services. That
connection must go directly to PostgreSQL, not through a transaction-mode
pooler such as PgBouncer. Behind nginx or another proxy, the stream sends
`X-Accel-Buffering: no`; the proxy's read timeout must be longer than 25
seconds.

## Administrator metrics

`GET /api/v1/admin/metrics/overview?days=30` returns aggregate account, trip,
connection-request and report counts. Only active local `ADMIN` accounts can
access it; moderators and ordinary users cannot. `days` is 7, 30 (default) or 90.
It includes current status breakdowns and creation counts in the rolling UTC
window, not engagement or historical status-transition analytics. No personal
data or tracking SDK is added. See [metric definitions and limits](docs/admin-metrics.md).
This milestone needs no new migration, API key or frontend changes.

## Staff moderation

Reports submitted through `POST /api/v1/reports` now have a staff-only review
workflow. A normal account cannot grant itself staff access, and staff routes
check the account's current database role and active status on every request.

- `GET /api/v1/admin/reports?status=SUBMITTED&page=1&pageSize=20` lists reports.
- `GET /api/v1/admin/reports/:reportId` shows the reported target; this private
  inspection is recorded in the moderation audit trail.
- `POST /api/v1/admin/reports/:reportId/start-review` claims a submitted report.
- `POST /api/v1/admin/reports/:reportId/resolve` accepts a `resolution` of
  `DISMISS`, `SUSPEND_USER`, `REMOVE_CONTENT`, or `RESTRICT_FEATURE` (with a
  `restriction` object; see [feature restrictions](#feature-restrictions)), and a
  required `reason` of at least 10 non-space characters. Only the assigned
  reviewer or an administrator may resolve a claimed report.
- `POST /api/v1/admin/users/:userId/suspend` suspends an active account with a
  reason; `POST /api/v1/admin/users/:userId/restore` restores one and is
  administrator-only.
- `POST /api/v1/admin/users/:userId/remove-profile-photo` removes an
  inappropriate profile photo without a report, with a reason. The same staff
  protections as suspension apply.
- `GET /api/v1/admin/moderation-actions` is an administrator-only audit view.

Content removal supports trips, messages, community posts, community
comments, and profile photos. It retains the records for review instead of hard-deleting them.
Removed trips disappear from public discovery and cannot be republished by the
owner; existing private room and financial records remain available to their
eligible members. Connection requests and user accounts are not removable
content; use account suspension or dismiss those reports. Suspending an account
blocks its authenticated API access and hides its public profile, trips, and
community content. Administrator accounts cannot be suspended through the API.

### Moderation notices

The affected account receives an in-app notification in the same transaction
as the moderation action (PRD §12):

| Action                    | Notification type            | `sourceId`           | `tripId`           |
| ------------------------- | ---------------------------- | -------------------- | ------------------ |
| Trip removed              | `TRIP_REMOVED`               | trip ID              | trip ID            |
| Community post removed    | `COMMUNITY_POST_REMOVED`     | post ID              | `null`             |
| Community comment removed | `COMMUNITY_COMMENT_REMOVED`  | comment ID           | `null`             |
| Trip-room message removed | `MESSAGE_REMOVED`            | message ID           | the message's trip |
| Profile photo removed     | `PROFILE_PHOTO_REMOVED`      | report or action ID  | `null`             |
| Account suspended         | `ACCOUNT_SUSPENDED`          | moderation action ID | `null`             |
| Account restored          | `ACCOUNT_RESTORED`           | moderation action ID | `null`             |
| Feature restricted        | `FEATURE_RESTRICTED`         | restriction ID       | `null`             |
| Restriction lifted early  | `FEATURE_RESTRICTION_LIFTED` | restriction ID       | `null`             |

Notices have generic titles and no `actorId`. They never name the moderator or
the reporter, or repeat the moderator's internal reason; explaining reasons and
appeals awaits the founders' moderation policy. Dismissed reports send nothing
to the reported account. A removed trip notifies only its owner, because members
keep the private room. Suspension and restore notices are per action, so each
repeat is announced.

A suspended account cannot open the inbox, so authenticated routes return
`403 ACCOUNT_SUSPENDED` ("This account is suspended. You can still download your
data or make a data request.") instead of the generic `ACCOUNT_DISABLED`, which
remains for other inactive accounts. These notices use the optional `safety`
email category until a mandatory-notice policy is approved.

### Feature restrictions

For problems that do not justify suspension, staff can restrict one feature of
an account (PRD §6.4):

| `feature`             | Blocks                                 | Still allowed                                 |
| --------------------- | -------------------------------------- | --------------------------------------------- |
| `CONNECTION_REQUESTS` | sending connection requests            | answering received requests                   |
| `COMMUNITY_POSTING`   | creating or editing posts and comments | reading, deleting own content                 |
| `TRIP_PUBLISHING`     | publishing or republishing trips       | drafts, edits, cancelling, completing         |
| `MESSAGING`           | sending or editing trip-room messages  | reading, deleting own messages, leaving trips |

- `POST /api/v1/admin/users/:userId/restrictions` with `feature`, an optional
  `durationDays` (1–90; omit for "until lifted") and a `reason`. Only one active
  restriction per feature: another returns `409 RESTRICTION_ACTIVE`.
- `GET /api/v1/admin/users/:userId/restrictions` lists current and past
  restrictions, with reasons, for staff.
- `POST /api/v1/admin/restrictions/:restrictionId/lift` ends one early with a
  reason; an ended or lifted one returns `409 RESTRICTION_NOT_ACTIVE`.
- `GET /api/v1/me/restrictions` shows the signed-in account its active
  restrictions: feature, `startsAt` and `endsAt` only.

The same staff protections as suspension apply. Each apply or lift is recorded
in the moderation audit trail and notifies the account (without the reason);
a restriction that simply reaches `endsAt` ends silently. A blocked action
returns `403 FEATURE_RESTRICTED` with the end time, checked inside the action's
own database transaction. Restrictions are private: they never appear on public
profiles, and the data export lists only their feature and dates.

### Profile photo moderation

Anyone can report a profile photo with `POST /api/v1/reports`, using
`targetType` `PROFILE_PHOTO` and the photo owner's user ID as `targetId`. This
is separate from reporting the person (`USER`), and both can be open at once.
The report records which photo was reported and stores a private copy of it as
evidence, because the owner may replace the photo before staff review it.

- Inspecting the report shows the owner, whether the reported photo is still
  their current one, and a 15-minute link to the evidence copy.
- Resolving with `REMOVE_CONTENT` removes the reported photo only. If the owner
  has already replaced it, the request returns `409 CONTENT_ALREADY_REMOVED`
  and the new photo stays; review it with a new report or remove it directly.
- Every removal deletes the public file, keeps the evidence copy in the private
  bucket, records a `CONTENT_REMOVED` action with target type `PROFILE_PHOTO`,
  and sends the owner a `PROFILE_PHOTO_REMOVED` notification. The owner can
  upload a new photo afterwards.

Evidence copies are kept while the account exists, and deleted one year after
the account is erased (see account deletion).

Staff roles are provisioned **only by a database operator**, never through a
public API. After the target account has signed in and exists in PostgreSQL,
apply migrations and run this in PowerShell with a database URL scoped to the
intended environment:

```powershell
$env:STAFF_GRANT_OPERATOR = 'Your operator name'
npm run staff:grant -- <user-uuid> ADMIN
```

Use `MODERATOR` instead of `ADMIN` for report reviewers. The command requires
direct database credentials, accepts only an active ordinary account, and
records an operator-labelled audit entry. Revoke access with
`npm run staff:revoke -- <user-uuid>` using the same operator variable. The last
active administrator cannot be revoked. Protect database credentials and
review staff grants separately; the operator label is not an identity proof.

For local Postman testing, use disposable accounts and sample content. Review
actions intentionally persist and must not be run on real user records.

## Account data export

`POST /api/v1/me/data-export` returns a downloadable JSON snapshot for the
Firebase-authenticated account. The caller supplies only a Bearer ID token;
the API derives the local user ID from that token. Active and suspended
accounts, and accounts waiting for deletion, can export; deleted accounts
cannot. The response uses `Content-Disposition:
attachment` and `Cache-Control: private, no-store`; the API does not retain a
copy. Limit: five exports per account per hour.

The JSON includes the local account, profile, linked sign-in identity, verified
contacts, policy acceptance and data-request history, and account-linked trips,
memberships, requests, community activity, checklist items, expenses,
settlements, receipts the account uploaded (file type, size, and dates, not
links), sent messages, notifications, push device registrations (platform and
dates, not tokens), blocks, and submitted reports. It
excludes other members' profiles and messages, moderation review notes, IP
hashes, and Firebase-managed data that is not stored in this database. The
export is sensitive: the Flutter client must save it only where the user
chooses and must not log or upload its contents. Offer it before an account
deletion is confirmed.

### Account data requests and deletion

`POST /api/v1/me/data-requests` takes `{ "type": "ACCESS" }` or
`{ "type": "ACCOUNT_DELETION", "confirm": true }` with a Firebase Bearer token.
`GET /api/v1/me/data-requests` lists only the caller's requests, and
`POST /api/v1/me/data-requests/:requestId/cancel` cancels an open one. These
routes also work for suspended accounts and accounts waiting for deletion, but
not deleted accounts. Repeating an open request of the same type returns its
existing ID; the database prevents concurrent duplicate open requests.

An `ACCESS` request is for the founders to handle by hand; the self-service
export above covers most needs.

An `ACCOUNT_DELETION` request deletes the account in two stages.

1. **At once:** the account is locked and hidden. Its public profile, trips,
   and community posts disappear from listings. Every signed-in route except
   the data-request routes and `POST /api/v1/me/data-export` returns
   `403 ACCOUNT_DELETION_PENDING`, including `POST /api/v1/auth/bootstrap`, so
   the app knows to offer a "restore account" option at sign-in. The
   request's `scheduledFor` is 30 days later. Cancelling the request within
   that time restores the account as it was, including a suspension. Staff
   accounts must have their role revoked first (`409 STAFF_ACCOUNT_DELETION`).
   The request needs a sign-in within the last 10 minutes
   (`403 RECENT_SIGN_IN_REQUIRED`); a missing, invalid, or future sign-in time
   is rejected too. Ask the user to sign in again before confirming.
2. **After 30 days**, a background job in the API erases the account and marks
   the request `COMPLETED`:
   - deletes the profile, profile photo, login links, verified email and
     phone, push devices, notifications, follows, blocks, and policy
     acceptances, and clears the name and birth date;
   - queues deletion of the Firebase sign-in account and public profile photo
     in the same database transaction, then performs those external deletions;
   - cancels upcoming trips the person owns and tells their members, and
     takes them out of upcoming trips that others own;
   - declines join requests waiting for them, withdraws their own waiting
     requests, and cancels pending settlements involving them;
   - takes down their community posts and comments.

Trip messages, expenses, receipts, settlements, checklist items, and
memberships in trips that have already started stay, so other members' chats
and balances remain correct. They point to the erased account, which then has
`displayName: null`; the apps should show it as "Deleted user". Signing in
again with the same login starts a new, empty account after the Firebase
account is deleted. While that deletion is retrying, bootstrap for the old
Firebase UID returns `403 ACCOUNT_CLEANUP_PENDING`. A newly created Firebase
account has a new UID and starts with an empty local account.

Moderation records are kept for one year after erasure. Then the job clears
the text of the person's removed community posts, comments, and join-request
messages, and deletes evidence copies of their photos. Reports and the
moderation audit trail themselves remain.

#### Cleanup retries and operations

External deletion tasks live in `account_cleanup_tasks`. Raw Firebase UIDs and
storage keys are retained only while their deletion task is unfinished. After
Firebase deletion succeeds, a hash of the old UID blocks account bootstrap for
65 minutes, counted from when Firebase confirms the deletion: the old
account's tokens stay valid for up to an hour after deletion, plus a margin for
clock differences. Bootstrap also asks Firebase whether the account still
exists, so the guard mainly covers a sign-in whose check finished just before
the deletion. A later confirmation can extend the block but never shorten
it.
This `FIREBASE_SIGN_IN_GUARD` then expires automatically. Evidence-file deletion
is queued before moderation references are
cleared, so failed file deletion does not lose its retry target. A data request
marked `COMPLETED` means local account erasure has finished; external cleanup
may still be pending.

The worker runs at startup and every 10 minutes. Failed deletions retry after
10 minutes, doubling the delay up to 24 hours, with no attempt limit. Missing
Google credentials or R2 configuration also leave tasks queued: restore the
configuration and restart the API, then the next due run retries them. Multiple
API instances claim separate tasks; a claim abandoned for 5 minutes can be
recovered. Deleting a provider account or object that is already gone counts
as success, so recovery after a crash is safe.

Warnings identify the task ID, type, attempt count, and next retry time without
logging Firebase UIDs, object keys, or provider error text. Operators can inspect
the backlog without exposing targets:

```sql
SELECT kind, count(*) AS pending, min(created_at) AS oldest_task,
       min(next_attempt_at) AS next_attempt, max(attempts) AS most_attempts
FROM account_cleanup_tasks
WHERE kind <> 'FIREBASE_SIGN_IN_GUARD'
GROUP BY kind;
```

Investigate a growing or repeatedly failing backlog by checking Firebase Admin
permissions and R2 credentials/bucket permissions. Keep pending rows until their
external deletion succeeds. Cleanup targets lost by the older worker before
this migration cannot be reconstructed from these tasks; any earlier manual
cleanup warnings still need operator attention.

`GET /api/v1/admin/data-requests?status=OPEN` gives administrators (not
ordinary users or moderators) a paginated queue of request IDs, account IDs,
type, status, and dates; `COMPLETED` and `CANCELLED` filter the history.

## File storage (Cloudflare R2)

Profile photos and receipts are stored in Cloudflare R2, which has a free tier
of 10 GB of storage per month and no charge for downloads. Files go through the
API, which validates and re-encodes them, so clients never upload to R2
directly and buckets need no CORS rules.

Set up R2 once:

1. Create two buckets. The public bucket holds profile photos; the private
   bucket holds receipts and must never be made public.
2. Connect a custom domain to the public bucket, such as
   `media.your-domain.example`. The `r2.dev` address works for development but
   is rate limited and not meant for production.
3. Create an R2 API token with **Object Read & Write** permission for those two
   buckets only.
4. Configure all six settings together:

   | Variable               | Value                                              |
   | ---------------------- | -------------------------------------------------- |
   | `R2_ACCOUNT_ID`        | Cloudflare account ID (32 characters)              |
   | `R2_ACCESS_KEY_ID`     | API token access key ID                            |
   | `R2_SECRET_ACCESS_KEY` | API token secret access key                        |
   | `R2_PUBLIC_BUCKET`     | Public bucket name                                 |
   | `R2_PRIVATE_BUCKET`    | Private bucket name                                |
   | `R2_PUBLIC_BASE_URL`   | HTTPS address of the public bucket's custom domain |

Without these settings the API still runs: upload and receipt endpoints return
`503 STORAGE_UNAVAILABLE`, and `profilePhotoUrl` is `null`.

## Rate limiting and proxies

Every route is rate limited, with stricter per-route limits on writes such as
reports, connection requests, and messages. Requests with a valid Firebase ID
token are counted per account, so people who share an IP address (a mobile
carrier, an office, a campus) do not share limits. Requests without a valid token
are counted per client IP address.

When the API runs behind a load balancer or reverse proxy, set `TRUST_PROXY` to
the number of proxy hops (usually `1`) or to a comma-separated list of proxy
addresses. Without it, every anonymous request appears to come from the proxy and
shares one limit. Do not set `TRUST_PROXY=true` on a server that clients can
reach directly, because they could then spoof `X-Forwarded-For`.

Limits are kept in each process's memory. Running more than one API instance
requires a shared store such as Redis, which is not configured yet.

## Database workflow

The project uses PostgreSQL with Prisma ORM. Prisma keeps database changes in
reviewable migrations instead of changing production tables automatically.

```bash
npm run db:validate
npm run db:generate
npm run db:migrate:dev -- --name describe_your_change
```

Use `db:migrate:dev` only for local development. Deployed environments apply
committed migrations with:

```bash
npm run db:migrate:deploy
```

The Docker image runs this automatically each time the container starts.

Never run development migrations or destructive reset commands against staging
or production databases.

Prisma 7 generates its client into `src/generated/prisma`, which is not
committed. `npm install` and `npm run build` regenerate it. After changing the
schema, run `npm run db:generate` yourself: `db:migrate:dev` no longer
generates the client or runs the seed.

### Connection settings

The API talks to PostgreSQL through node-postgres (`@prisma/adapter-pg`).
These Prisma-style `DATABASE_URL` parameters are still honoured:

| Parameter          | Effect                                                |
| ------------------ | ----------------------------------------------------- |
| `connection_limit` | Maximum pool size (default 10 per process)            |
| `connect_timeout`  | Seconds to wait for a connection (default 5)          |
| `schema`           | PostgreSQL schema for Prisma queries (default public) |

Other Prisma-only parameters such as `pool_timeout` and `pgbouncer` are
ignored. Encryption settings now behave like other Node.js tools:
`sslmode=require` checks the server certificate, so prefer
`sslmode=verify-full` for managed databases with a public certificate. A
database with a self-signed certificate needs its CA in `NODE_EXTRA_CA_CERTS`;
`uselibpqcompat=true&sslmode=require` encrypts without checking it. A database
on the same server as the API needs no SSL parameters.

Inside a transaction, Prisma 7 loads related records in parallel on one
connection. node-postgres queues those queries and prints a one-time
`DeprecationWarning` about it; the results are correct. pg 9 removes that
queue, so Dependabot holds pg at major version 8 until Prisma changes this.

### Dependency notes

- `package.json` overrides `mysql2` and `deepmerge-ts`, which the Prisma CLI
  pins to versions with published security advisories. The API never loads
  either one. Remove the overrides once a Prisma release ships fixed versions.
- TypeScript stays on 6.x until `typescript-eslint` supports TypeScript 7, and
  `@types/node` follows the Node.js 24 runtime. Dependabot ignores those major
  updates, together with Prisma 8.

## Quality checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run db:validate
```

The integration tests require a reachable PostgreSQL database with all committed
migrations applied. GitHub Actions runs these tests automatically against an
isolated PostgreSQL service for every pull request.

## Project structure

```text
src/
  config/       Environment parsing and validation
  database/     Database connection infrastructure
  privacy/      Shared public-text disclosure guards and safe projections
  modules/      Product modules and HTTP routes
  realtime/     Live event stream and PostgreSQL LISTEN/NOTIFY bus
  storage/      Cloudflare R2 client and upload processing
  generated/    Prisma client (generated, not committed)
  app.ts        Fastify application composition
  server.ts     Process startup and graceful shutdown
test/           Automated tests
prisma/         Database schema and committed migrations
scripts/        Staff-role commands and the Docker entrypoint
```

## Git workflow

Do not commit directly to `main`. Create a focused branch, run all quality
checks, push the branch, and open a pull request for review.
