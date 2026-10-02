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
their existence is not disclosed.

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
Profile-photo upload is deferred until an object-storage provider is selected.

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
Requests are accepted only for published trips with available group capacity.
Self-requests, duplicate requests, and more than 20 new requests in a rolling
24-hour period are rejected.

Users list their received or sent requests with
`GET /api/v1/me/connection-requests?box=received` or `box=sent`. The trip owner
can accept or decline a pending request. The requester can withdraw it. A
declined or otherwise resolved request cannot be repeatedly resubmitted for the
same trip.

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
trip as `PUBLISHED`. The owner cannot leave or be removed. Real-time delivery
and notification fan-out are separate milestones.

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
new settlement records between the two accounts. Receipt uploads and
notification delivery remain separate milestones.

## In-app notifications

Important activity creates a durable notification in PostgreSQL in the same
transaction as the activity itself. The API provides an inbox and unread count
for the signed-in account:

- `GET /api/v1/me/notifications?page=1&pageSize=20&unreadOnly=false`
- `GET /api/v1/me/notifications/unread-count`
- `POST /api/v1/me/notifications/:notificationId/read`
- `POST /api/v1/me/notifications/read-all`

The inbox covers connection requests and decisions, trip plan/status changes,
new group messages, expense creation/edits/voiding, and external settlement
requests/decisions. Notification titles are generic; message text, financial
amounts and private profile details are not copied into notifications. A user
can read or mark only their own records. Muted trip rooms and blocked senders do
not produce new message notifications for that recipient. The Flutter or web
client can poll the inbox and unread-count endpoints; polling frequency should
be modest and stop when the app is in the background.

This milestone does not send email or phone push notifications. Firebase Cloud
Messaging can later deliver push alerts to opted-in devices, but PostgreSQL
remains the authoritative in-app inbox. Do not collect or store device push
identifiers until that delivery channel is explicitly implemented.

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
- `GET /api/v1/admin/moderation-actions` is an administrator-only audit view.

Content removal supports trips, messages, community posts, and community
comments. It retains the records for review instead of hard-deleting them.
Removed trips disappear from public discovery and cannot be republished by the
owner; existing private room and financial records remain available to their
eligible members. Connection requests and user accounts are not removable
content; use account suspension or dismiss those reports. Suspending an account
blocks its authenticated API access and hides its public profile, trips, and
community content. Administrator accounts cannot be suspended through the API.

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

Never run development migrations or destructive reset commands against staging
or production databases.

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
  app.ts        Fastify application composition
  server.ts     Process startup and graceful shutdown
test/           Automated tests
prisma/         Database schema and committed migrations
```

## Git workflow

Do not commit directly to `main`. Create a focused branch, run all quality
checks, push the branch, and open a pull request for review.
