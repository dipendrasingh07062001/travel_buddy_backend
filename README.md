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

## Private trip-room messaging

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

Message history uses cursor pagination. Edits and soft deletions preserve an
internal revision trail, while deleted content is hidden from ordinary API
responses. Completed and cancelled trip rooms are read-only. Messages from a
blocked account are hidden from that user, and a two-person room cannot be used
to bypass a block. A member can report another member's message through
`POST /api/v1/reports` with `targetType` set to `MESSAGE`.

This milestone provides persistent REST messaging. Real-time delivery and
notification fan-out are separate milestones.

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
