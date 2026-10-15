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
  recorded group count is below capacity.
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
first. Ties use the smallest sum of start-date and end-date differences from
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
user. Verification also checks whether Firebase has revoked the token, disabled
the account, or deleted it; an unexpired token alone cannot restore an erased
account. Call `POST /api/v1/auth/bootstrap` after the first Firebase sign-in. The
operation is idempotent and returns `201` only when it creates the local account.
Subsequent calls return `200`. `GET /api/v1/me` returns the authenticated local
profile.

Set `FIREBASE_PROJECT_ID` to the shared Firebase project ID. For local
development, set `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of a
service-account JSON file kept outside this repository. In deployed
environments, use the hosting platform's workload identity or secret manager.
Never commit service-account credentials.

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

`currentGroupSize` counts travellers already committed to the trip, including
the owner and accepted members. The owner can raise it for companions who are
not on the platform, but not below the number of active members; that returns
`409 GROUP_SIZE_BELOW_ACTIVE_MEMBERS`.

Every edit or lifecycle request must include the latest version returned by the
API, for example `{ "expectedVersion": 2 }`. A stale version returns
`409 TRIP_VERSION_CONFLICT`; refresh the trip before retrying. This prevents one
device from silently overwriting a newer change from another device. Only the
owner may mutate a trip. The server derives `durationDays` from the dates and
validates date, budget, group-size, community, ownership, and lifecycle rules.

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

## Destination communities

Guests can browse active destination hubs and their public activity:

- `GET /api/v1/communities`
- `GET /api/v1/communities/:slug`
- `GET /api/v1/communities/:slug/trips`
- `GET /api/v1/communities/:slug/posts`

The list supports case-insensitive `search`, `page`, and `pageSize`. Community
trip results reuse the objective public-trip filters. Community posts can be
filtered by `DISCUSSION`, `QUESTION`, or `EXPERIENCE`; only published posts from
active accounts whose community activity is public are returned.

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
requests/decisions, and profile photos removed by moderation. Notification
titles are generic; message text, financial
amounts and private profile details are not copied into notifications. A user
can read or mark only their own records. Muted trip rooms and blocked senders do
not produce new message notifications for that recipient. While a
[real-time stream](#real-time-updates) is open, a `notifications.changed` event
signals that the inbox changed; without one, poll the unread count modestly and
stop when the app is in the background.

### Push notifications

Every inbox notification can also be delivered as a push alert through
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

## Staff moderation

Reports submitted through `POST /api/v1/reports` now have a staff-only review
workflow. A normal account cannot grant itself staff access, and staff routes
check the account's current database role and active status on every request.

- `GET /api/v1/admin/reports?status=SUBMITTED&page=1&pageSize=20` lists reports.
- `GET /api/v1/admin/reports/:reportId` shows the reported target; this private
  inspection is recorded in the moderation audit trail.
- `POST /api/v1/admin/reports/:reportId/start-review` claims a submitted report.
- `POST /api/v1/admin/reports/:reportId/resolve` accepts a `resolution` of
  `DISMISS`, `SUSPEND_USER`, or `REMOVE_CONTENT`, and a required `reason` of at
  least 10 non-space characters. Only the assigned reviewer or an administrator
  may resolve a claimed report.
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
one hour, covering requests whose token verification raced with deletion.
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
