import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

// A double-tap or client retry sends identical requests at the same moment.
// Each round uses fresh users, so per-user rate limits are never reached and
// every burst starts with no existing row.
const rounds = Array.from({ length: 20 }, (_, index) => index + 1);
const acceptRounds = rounds.slice(0, 5);
const communityId = randomUUID();
const createdUserIds: string[] = [];
const createdTripIds: string[] = [];

// The token is the Firebase subject, so any new token is a new account.
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: false };
  },
};

const app = buildApp({ logger: false, auth: { tokenVerifier } });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const day = 86_400_000;

async function createUser(label: string) {
  const token = `duplicate-${label}-${randomUUID()}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    headers: headers(token),
  });
  expect(response.statusCode).toBe(201);
  const id = response.json().data.id as string;
  createdUserIds.push(id);
  return { id, token };
}

async function completeProfile(userId: string) {
  await database.user.update({
    where: { id: userId },
    data: {
      displayName: 'Duplicate Tester',
      birthDate: new Date('1995-05-20T00:00:00.000Z'),
      profile: {
        create: {
          homeCity: 'Delhi',
          biography: 'Integration profile for duplicate submission tests.',
          languages: ['english'],
        },
      },
    },
  });
}

async function createPublishedTrip(ownerId: string) {
  const trip = await database.trip.create({
    data: {
      ownerId,
      communityId,
      originCity: 'Delhi',
      startDate: new Date(Date.now() + 30 * day),
      endDate: new Date(Date.now() + 34 * day),
      durationDays: 5,
      desiredGroupSize: 2,
      description: 'Fixture trip for the duplicate block test.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
    },
  });
  createdTripIds.push(trip.id);
  return trip.id;
}

beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: `duplicate-${communityId}`,
      name: 'Duplicate Submission Community',
      region: 'Himachal Pradesh',
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // Trips first: their requests, memberships and rooms cascade with them.
  await database.trip.deleteMany({ where: { id: { in: createdTripIds } } });
  await database.communityFollow.deleteMany({ where: { communityId } });
  await database.userBlock.deleteMany({
    where: { blockerId: { in: createdUserIds } },
  });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await database.$disconnect();
});

describe('simultaneous duplicate follows', () => {
  it.each(rounds)('round %i: every follow succeeds with one row', async () => {
    const user = await createUser('follower');
    expect(
      await database.communityFollow.count({
        where: { communityId, userId: user.id },
      }),
    ).toBe(0);

    const responses = await Promise.all(
      [1, 2, 3, 4].map(() =>
        app.inject({
          method: 'POST',
          url: `/api/v1/communities/${communityId}/follow`,
          headers: headers(user.token),
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200,
    ]);
    const followedAt = new Set(
      responses.map((response) => response.json().data.followedAt),
    );
    expect(followedAt.size).toBe(1);
    expect(
      await database.communityFollow.count({
        where: { communityId, userId: user.id },
      }),
    ).toBe(1);
  });
});

describe('simultaneous duplicate blocks', () => {
  it.each(rounds)(
    'round %i: every block succeeds and blocks pending requests',
    async () => {
      const blocker = await createUser('blocker');
      const target = await createUser('target');
      const blockerTripId = await createPublishedTrip(blocker.id);
      const targetTripId = await createPublishedTrip(target.id);
      const message = 'Pending request that the block must close.';
      const requests = await Promise.all([
        database.connectionRequest.create({
          data: {
            tripId: targetTripId,
            requesterId: blocker.id,
            recipientId: target.id,
            message,
          },
        }),
        database.connectionRequest.create({
          data: {
            tripId: blockerTripId,
            requesterId: target.id,
            recipientId: blocker.id,
            message,
          },
        }),
      ]);
      expect(
        await database.userBlock.count({
          where: { blockerId: blocker.id, blockedId: target.id },
        }),
      ).toBe(0);

      const responses = await Promise.all(
        [1, 2, 3, 4].map(() =>
          app.inject({
            method: 'POST',
            url: `/api/v1/users/${target.id}/block`,
            headers: headers(blocker.token),
          }),
        ),
      );

      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 200, 200, 200,
      ]);
      const bodies = responses.map((response) => response.json().data);
      expect(new Set(bodies.map((body) => body.blockedAt)).size).toBe(1);
      expect(bodies[0].user.id).toBe(target.id);
      for (const body of bodies) expect(body.user).toEqual(bodies[0].user);
      expect(
        await database.userBlock.count({
          where: { blockerId: blocker.id, blockedId: target.id },
        }),
      ).toBe(1);
      const statuses = await database.connectionRequest.findMany({
        where: { id: { in: requests.map((request) => request.id) } },
        select: { status: true },
      });
      expect(statuses.map((request) => request.status)).toEqual([
        'BLOCKED',
        'BLOCKED',
      ]);
    },
  );
});

describe('simultaneous accepts on a trip without a room', () => {
  let owner: { id: string; token: string };
  let requesters: { id: string; token: string }[];

  beforeAll(async () => {
    owner = await createUser('owner');
    requesters = [
      await createUser('requester-a'),
      await createUser('requester-b'),
    ];
    for (const user of [owner, ...requesters]) await completeProfile(user.id);
  });

  it.each(acceptRounds)(
    'round %i: no accept fails with a server error',
    async () => {
      const startDate = new Date(Date.now() + 30 * day)
        .toISOString()
        .slice(0, 10);
      const endDate = new Date(Date.now() + 34 * day)
        .toISOString()
        .slice(0, 10);
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/trips',
        headers: headers(owner.token),
        payload: {
          communityId,
          originCity: 'Delhi',
          startDate,
          endDate,
          currentGroupSize: 1,
          desiredGroupSize: 3,
          transport: 'BUS',
          description: 'Published trip for the duplicate accept test.',
        },
      });
      expect(created.statusCode).toBe(201);
      const tripId = created.json().data.id as string;
      createdTripIds.push(tripId);
      const published = await app.inject({
        method: 'POST',
        url: `/api/v1/trips/${tripId}/publish`,
        headers: headers(owner.token),
        payload: { expectedVersion: 1, confirmsPersonalPlan: true },
      });
      expect(published.statusCode).toBe(200);

      const requestIds: string[] = [];
      for (const requester of requesters) {
        const requested = await app.inject({
          method: 'POST',
          url: `/api/v1/trips/${tripId}/connection-requests`,
          headers: headers(requester.token),
          payload: {
            message:
              'I am available on these dates and would like to discuss joining.',
          },
        });
        expect(requested.statusCode).toBe(201);
        requestIds.push(requested.json().data.id as string);
      }

      // Creating a trip also creates its room; remove it so both accepts take
      // the room-creation path, as for a trip that never had one.
      await database.conversation.deleteMany({ where: { tripId } });
      expect(await database.conversation.count({ where: { tripId } })).toBe(0);

      const responses = await Promise.all(
        requestIds.map((requestId) =>
          app.inject({
            method: 'POST',
            url: `/api/v1/connection-requests/${requestId}/accept`,
            headers: headers(owner.token),
          }),
        ),
      );

      const statuses = responses.map((response) => response.statusCode);
      for (const status of statuses) expect([200, 409]).toContain(status);
      const accepted = requesters.filter(
        (_, index) => responses[index]!.statusCode === 200,
      );
      expect(accepted.length).toBeGreaterThan(0);

      const trip = await database.trip.findUniqueOrThrow({
        where: { id: tripId },
        include: {
          conversation: { include: { participants: true } },
          memberships: true,
        },
      });
      expect(trip.currentGroupSize).toBe(1 + accepted.length);
      const participantIds = (trip.conversation?.participants ?? []).map(
        (participant) => participant.userId,
      );
      expect(participantIds).toContain(owner.id);
      for (const requester of accepted) {
        expect(participantIds).toContain(requester.id);
        expect(
          trip.memberships.find(
            (membership) => membership.userId === requester.id,
          )?.status,
        ).toBe('ACTIVE');
      }
      expect(await database.conversation.count({ where: { tripId } })).toBe(1);
    },
  );
});
