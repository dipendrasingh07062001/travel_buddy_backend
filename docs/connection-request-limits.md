# Connection request limits

An account can create at most 20 trip-specific connection requests in a rolling
24-hour window. This fixes concurrent quota enforcement; it does not introduce a
new product limit, migration, provider, API key or Flutter request format.

## Contract

- The quota belongs to the authenticated requester, across all target trips and
  recipients. Different requesters have independent quotas.
- Count all retained requests with `createdAt >= databaseNow - 24 hours`,
  regardless of status. Accepting, declining, withdrawing or blocking an existing
  request does not undo that request's use of a quota slot.
- The first 20 valid requests can succeed. Further requests return HTTP `429`
  with code `CONNECTION_REQUEST_LIMIT` and the existing error message.
- Profile, trip availability, self-request, block, related-trip, duplicate and
  rejoin checks remain in force. Rejected or rolled-back inserts use no slot.
- The existing route's per-account hourly rate limiter is separate. This change
  does not make process-local HTTP limiters shared across API instances.

## Transaction design

The old implementation counted recent requests in the service, then inserted in
a separate repository transaction. Two requests could both read 19 and commit,
producing 21 requests.

`createWithinDailyLimit` now owns the complete quota/write operation:

1. Begin an explicitly `READ COMMITTED` PostgreSQL transaction and set a local
   five-second statement timeout. The Prisma transaction timeout is 15 seconds.
2. Lock the requester's existing `users` row with `FOR NO KEY UPDATE`. Requests
   from the same account serialize even when sent to different API instances.
   The lock targets the client's configured schema with safely quoted identifiers.
3. Read `clock_timestamp()` after acquiring the lock. Count using a fresh
   statement snapshot, so the count sees the preceding lock holder's commit.
4. Return a quota rejection without inserting if 20 or more requests count.
5. Otherwise insert the request using that database timestamp and create its
   notification in the same transaction. Commit together or roll back together.

`NO KEY UPDATE` is deliberate: it serializes competing quota decisions while
remaining compatible with the foreign-key key-share locks used by reciprocal
requests. A stronger `FOR UPDATE` lock on both users can introduce unnecessary
foreign-key deadlocks. See PostgreSQL's [row-level lock compatibility](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)
and [read committed snapshots](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED).

The database clock avoids different API hosts defining different rolling windows.
`clock_timestamp()` rather than transaction-start time avoids a stale clock after
waiting for a lock. The repository exposes no separate count-then-create path.
Database errors fail closed; they do not fall back to an unlocked insert.

All application connection-request writers must use this repository method.
Direct SQL, seeds and administrative database access are not governed by an
application repository lock. This is not a database trigger or an unrestricted
manual-write guarantee. Per-trip pending-request uniqueness remains enforced by
the existing database index.

## Automated verification

- Unit/API: quota rejection preserves `429 CONNECTION_REQUEST_LIMIT`; repository
  tests check lock order, isolation, database-clock bounds, unchanged status
  counting, shared request/notification timestamp, no writes at the limit and
  error propagation.
- PostgreSQL: two Fastify instances share a requester at 19 existing requests.
  A test transaction holds the requester lock until both inserts are observed
  waiting in PostgreSQL. Releasing it must produce one `201`, one quota `429`,
  exactly 20 requests and one new notification.
- PostgreSQL: over-limit rejection, all request statuses, expiry around 24 hours,
  independent requesters, duplicate/block rejection, transaction rollback after
  notification failure and reciprocal requests are covered.
- Existing connection, rejoin, membership, notification and other regression
  suites must continue to pass. Tests use a separate test database, not the
  development app's data.

Focused commands, with `NODE_ENV=test` and `DATABASE_URL` pointing to an isolated
test database with the existing migrations applied:

```text
npx vitest run test/connection-quota-repository.test.ts test/connections.test.ts
npm run test:integration -- test/connection-quota.integration.ts test/connections.integration.ts test/trip-rejoin.integration.ts
```
