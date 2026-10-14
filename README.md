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
- Browse destination communities: `GET http://localhost:3000/api/v1/communities`

The health endpoint reports whether the Node.js process is running. The
readiness endpoint also checks whether PostgreSQL is reachable.

## Public trips API

`GET /api/v1/trips` supports these optional query parameters:

- `origin`: case-insensitive partial city match
- `destination`: exact community slug, such as `manali`
- `departureFrom` and `departureTo`: `YYYY-MM-DD` date window
- `minBudget` and `maxBudget`: inclusive budget overlap
- `transport`: `BUS`, `TRAIN`, `FLIGHT`, `CAR`, `MOTORCYCLE`, `OTHER`, or
  `UNDECIDED`
- `sort`: `newest` (default) or `departure_asc`
- `page` and `pageSize`: page-based pagination; page size is capped at 100

Only `PUBLISHED` and `FULL` trips in active communities are public. Draft,
paused, cancelled, and completed trips return `404` from the details endpoint so
their existence is not disclosed. Search and community trip lists also hide
trips whose end date has passed (UTC), and those trips no longer accept
connection requests. The details endpoint still returns them so shared links
keep working.

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
user. Call `POST /api/v1/auth/bootstrap` after the first Firebase sign-in. The
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
actual linked document before asking for acceptance. **This foundation does not
yet gate trip publishing or other actions.** Enable such enforcement only after
the policy documents, versions, and onboarding flow have been approved and
tested together.

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

Evidence copies have no automatic expiry yet; their retention belongs to the
data-retention rules still to be agreed.

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
the API derives the local user ID from that token. Active and suspended users
can export; deleted accounts cannot. The response uses `Content-Disposition:
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
chooses and must not log or upload its contents. This is an in-app self-service
snapshot, not the complete operator-assisted data-request or account-deletion process;
those require separate retention and policy decisions.

### Account data request intake

Users can submit `{ "type": "ACCESS" }` or
`{ "type": "ACCOUNT_DELETION" }` to `POST /api/v1/me/data-requests` with a
Firebase Bearer token. `GET /api/v1/me/data-requests` lists only their own
requests. `POST /api/v1/me/data-requests/:requestId/cancel` cancels one of their
open requests. These routes also work for suspended accounts, but not deleted
accounts. Repeating an open request of the same type returns its existing ID;
the database prevents concurrent duplicate open requests.

`GET /api/v1/admin/data-requests?status=OPEN` gives administrators (not ordinary
users or moderators) a paginated queue of request IDs, account IDs, type and
timestamps. This is an intake and visibility workflow for the two founders.
It does **not** send email, perform an export beyond the self-service endpoint,
delete or anonymize data, or mark requests fulfilled. Do not promise an
automatic deletion in the client UI. Agree and document retention, identity
verification, response handling and deletion rules before implementing the
fulfilment workflow; the PRD calls for qualified review before public beta.

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
