import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { ConnectionRequestStatus } from '../src/generated/prisma/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { prismaConnectionRepository } from '../src/modules/connections/connection.repository.js';
import * as notificationRepository from '../src/modules/notifications/notification.repository.js';

const run = randomUUID();
const communityId = randomUUID();
const roles = ['owner', 'requester', 'other'] as const;
type Role = (typeof roles)[number];
const users = Object.fromEntries(
  roles.map((role) => [role, randomUUID()]),
) as Record<Role, string>;
const trips = Array.from({ length: 23 }, () => randomUUID());
const reciprocalTripId = randomUUID();
const message = 'I would like to discuss joining your group on these dates.';
let app: FastifyInstance;
let peer: FastifyInstance;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: `quota-${run}-${token}`, emailVerified: false };
  },
};

function ask(tripId: string, role: Role = 'requester', server = app) {
  return server.inject({
    method: 'POST',
    url: `/api/v1/trips/${tripId}/connection-requests`,
    headers: { authorization: `Bearer ${role}` },
    payload: { message },
  });
}

async function databaseNow() {
  const [clock] = await database.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  if (!clock) throw new Error('Database clock unavailable.');
  return clock.now;
}

async function seedRequests(
  count: number,
  ageMilliseconds = 60 * 60 * 1000,
  statuses: ConnectionRequestStatus[] = ['PENDING'],
) {
  const now = await databaseNow();
  await database.connectionRequest.createMany({
    data: trips.slice(0, count).map((tripId, i) => ({
      tripId,
      requesterId: users.requester,
      recipientId: users.owner,
      message,
      status: statuses[i % statuses.length]!,
      createdAt: new Date(now.getTime() - ageMilliseconds),
    })),
  });
}

const countRequests = (role: Role = 'requester') =>
  database.connectionRequest.count({ where: { requesterId: users[role] } });
const countNotices = () =>
  database.notification.count({
    where: { actorId: users.requester, type: 'CONNECTION_REQUEST_RECEIVED' },
  });

beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: `quota-${run}`,
      name: 'Quota test community',
    },
  });
  for (const role of roles) {
    await database.user.create({
      data: {
        id: users[role],
        displayName: `Quota ${role}`,
        birthDate: new Date('1995-05-20T00:00:00Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Complete profile for isolated quota integration tests.',
            languages: ['english'],
          },
        },
        authAccounts: {
          create: {
            provider: 'FIREBASE',
            providerSubject: `quota-${run}-${role}`,
          },
        },
      },
    });
  }
  const now = await databaseNow();
  const plan = {
    communityId,
    originCity: 'Delhi',
    startDate: new Date(now.getTime() + 30 * 86_400_000),
    endDate: new Date(now.getTime() + 35 * 86_400_000),
    durationDays: 6,
    desiredGroupSize: 3,
    status: 'PUBLISHED' as const,
    publishedAt: now,
    description: 'A public trip for isolated quota integration testing.',
  };
  await database.trip.createMany({
    data: [
      ...trips.map((id) => ({ ...plan, id, ownerId: users.owner })),
      { ...plan, id: reciprocalTripId, ownerId: users.requester },
    ],
  });
});

beforeEach(async () => {
  app = buildApp({ logger: false, auth: { tokenVerifier } });
  peer = buildApp({ logger: false, auth: { tokenVerifier } });
  await Promise.all([app.ready(), peer.ready()]);
});

afterEach(async () => {
  await Promise.all([app.close(), peer.close()]);
  await database.notification.deleteMany({
    where: { actorId: { in: Object.values(users) } },
  });
  await database.connectionRequest.deleteMany({
    where: { tripId: { in: [...trips, reciprocalTripId] } },
  });
  await database.userBlock.deleteMany({
    where: { blockerId: { in: Object.values(users) } },
  });
});

afterAll(async () => {
  await database.trip.deleteMany({ where: { communityId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({
    where: { id: { in: Object.values(users) } },
  });
  await database.$disconnect();
});

describe('rolling daily connection-request quota in PostgreSQL', () => {
  it('serializes two API instances at 19 and commits only request 20 and one notification', async () => {
    await seedRequests(19);
    let pending: ReturnType<typeof ask>[] = [];
    // Hold the same row lock until both contenders are demonstrably waiting in
    // PostgreSQL. This tests real overlapping transactions, not a lucky order.
    try {
      await database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${users.requester}::uuid FOR NO KEY UPDATE`;
        pending = [ask(trips[19]!), ask(trips[20]!, 'requester', peer)];
        await expect
          .poll(
            async () => {
              const [row] = await database.$queryRaw<{ waiting: number }[]>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%FOR NO KEY UPDATE%'
          `;
              return row?.waiting;
            },
            { timeout: 2000 },
          )
          .toBe(2);
      });
    } finally {
      // Drain in-flight HTTP work even if the lock assertion fails.
      await Promise.allSettled(pending);
    }
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 429,
    ]);
    expect(
      responses.find((response) => response.statusCode === 429)!.json().error
        .code,
    ).toBe('CONNECTION_REQUEST_LIMIT');
    expect(await countRequests()).toBe(20);
    expect(await countNotices()).toBe(1);
  });

  it('rejects request 21 without creating a request or notification', async () => {
    await seedRequests(20);
    const response = await ask(trips[20]!);
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('CONNECTION_REQUEST_LIMIT');
    expect(await countRequests()).toBe(20);
    expect(await countNotices()).toBe(0);
  });

  it('counts accepted, declined, withdrawn and blocked requests as well as pending', async () => {
    await seedRequests(20, 60 * 60 * 1000, [
      'PENDING',
      'ACCEPTED',
      'DECLINED',
      'WITHDRAWN',
      'BLOCKED',
    ]);
    expect((await ask(trips[20]!)).json().error.code).toBe(
      'CONNECTION_REQUEST_LIMIT',
    );
    expect(await countRequests()).toBe(20);
    expect(await countNotices()).toBe(0);
  });

  it('excludes requests older than 24 hours, but not those just inside the window', async () => {
    await seedRequests(20, 24 * 60 * 60 * 1000 + 60_000);
    expect((await ask(trips[20]!)).statusCode).toBe(201);
    expect(await countRequests()).toBe(21);
    expect(await countNotices()).toBe(1);
    const now = await databaseNow();
    await database.connectionRequest.updateMany({
      where: { requesterId: users.requester },
      data: {
        createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000 + 60_000),
      },
    });
    expect((await ask(trips[21]!)).json().error.code).toBe(
      'CONNECTION_REQUEST_LIMIT',
    );
    expect(await countNotices()).toBe(1);
  });

  it('keeps the quota per requester rather than per recipient or trip', async () => {
    await seedRequests(20);
    expect((await ask(trips[20]!)).statusCode).toBe(429);
    expect((await ask(trips[20]!, 'other')).statusCode).toBe(201);
    expect(await countRequests('other')).toBe(1);
    expect(await countRequests()).toBe(20);
  });

  it('keeps duplicate and blocked requests from consuming another quota slot', async () => {
    await seedRequests(19);
    const duplicate = await ask(trips[0]!);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('CONNECTION_REQUEST_EXISTS');
    await database.userBlock.create({
      data: { blockerId: users.owner, blockedId: users.requester },
    });
    const blocked = await ask(trips[19]!);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('CONTACT_BLOCKED');
    expect(await countRequests()).toBe(19);
    expect(await countNotices()).toBe(0);
  });

  it('rolls back the quota slot when notification creation fails and releases the lock', async () => {
    await seedRequests(19);
    const input = {
      requesterId: users.requester,
      recipientId: users.owner,
      tripId: trips[19]!,
      relatedTripId: null,
      message,
    };
    // Fail after the real PostgreSQL request insert, inside its transaction.
    const failing = vi
      .spyOn(notificationRepository, 'createNotifications')
      .mockRejectedValueOnce(new Error('Synthetic notification failure'));
    try {
      await expect(
        prismaConnectionRepository.createWithinDailyLimit(input),
      ).rejects.toThrow('Synthetic notification failure');
    } finally {
      failing.mockRestore();
    }
    expect(await countRequests()).toBe(19);
    expect(await countNotices()).toBe(0);
    expect((await ask(trips[19]!)).statusCode).toBe(201);
    expect(await countRequests()).toBe(20);
    expect(await countNotices()).toBe(1);
  });

  it('allows reciprocal requests without foreign-key lock deadlocks', async () => {
    const responses = await Promise.all([
      ask(trips[0]!),
      ask(reciprocalTripId, 'owner', peer),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      201, 201,
    ]);
    expect(await countRequests()).toBe(1);
    expect(await countRequests('owner')).toBe(1);
  });
});
