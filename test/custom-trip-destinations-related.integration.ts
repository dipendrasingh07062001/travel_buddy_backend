import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { processAccountErasures } from '../src/modules/account-deletion/account-erasure.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { createAccountDataExport } from '../src/modules/data-export/data-export.repository.js';
import { processTripAlertBatch } from '../src/modules/trip-alerts/trip-alert.worker.js';
import { MemoryStorage } from './helpers/memory-storage.js';

// Every account is new, so per-user limits (connection requests, report
// reviews) start empty.
const run = randomUUID();
const roles = [
  'owner',
  'requester',
  'subscriber',
  'reporter',
  'moderator',
  'admin',
  'leavingOwner',
  'leavingMember',
] as const;
type Role = (typeof roles)[number];
const userIds = {} as Record<Role, string>;
const subject = (role: Role) => `custom-destination-related-${role}-${run}`;
const tripIds: string[] = [];
const communityIds = {
  linked: randomUUID(),
  empty: randomUUID(),
  source: randomUUID(),
  target: randomUUID(),
};
const slug = (id: string) => `custom-related-${id}`;
const custom = (name: string) => ({
  id: null,
  slug: null,
  name,
  region: null,
  countryCode: null,
});

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: subject(token as Role),
      displayName: `Related ${token}`,
      emailVerified: false,
    };
  },
};
const storage = new MemoryStorage();
const app = buildApp({ logger: false, auth: { tokenVerifier }, storage });

function api(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  role?: Role,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    ...(role && { headers: { authorization: `Bearer ${role}` } }),
    ...(payload && { payload }),
  });
}

const day = 86_400_000;
const dateIn = (days: number) =>
  new Date(Date.now() + days * day).toISOString().slice(0, 10);

async function version(id: string) {
  return (
    await database.trip.findUniqueOrThrow({
      where: { id },
      select: { version: true },
    })
  ).version;
}

async function createTrip(
  role: Role,
  destination: object,
  { publish = true, desiredGroupSize = 4 } = {},
) {
  const created = await api('POST', '/trips', role, {
    ...destination,
    originCity: 'Jaipur',
    startDate: dateIn(30),
    endDate: dateIn(34),
    desiredGroupSize,
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().data.id as string;
  tripIds.push(id);
  if (publish) {
    const published = await api('POST', `/trips/${id}/publish`, role, {
      expectedVersion: 1,
      confirmsPersonalPlan: true,
    });
    expect(published.statusCode, published.body).toBe(200);
  }
  return id;
}

beforeAll(async () => {
  for (const [key, id] of Object.entries(communityIds)) {
    await database.community.create({
      data: { id, slug: slug(id), name: `Related ${key} ${run}` },
    });
  }
  await app.ready();
  for (const role of roles) {
    const response = await api('POST', '/auth/bootstrap', role);
    userIds[role] = response.json().data.id;
    await database.user.update({
      where: { id: userIds[role] },
      data: {
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        ...(role === 'moderator' && { staffRole: 'MODERATOR' }),
        ...(role === 'admin' && { staffRole: 'ADMIN' }),
        profile: {
          create: {
            homeCity: 'Jaipur',
            biography: 'Integration profile for custom destination checks.',
            languages: ['english'],
          },
        },
      },
    });
  }
});

afterAll(async () => {
  await app.close();
  const ids = Object.values(userIds);
  await database.moderationAction.deleteMany({
    where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
  });
  await database.report.deleteMany({ where: { reporterId: { in: ids } } });
  await database.connectionRequest.deleteMany({
    where: { OR: [{ requesterId: { in: ids } }, { recipientId: { in: ids } }] },
  });
  await database.trip.deleteMany({ where: { id: { in: tripIds } } });
  await database.tripAlertSubscription.deleteMany({
    where: { userId: { in: ids } },
  });
  await database.communityAdminAction.deleteMany({
    where: { actorId: { in: ids } },
  });
  await database.community.updateMany({
    where: { id: { in: Object.values(communityIds) } },
    data: { mergedIntoId: null },
  });
  await database.community.deleteMany({
    where: { id: { in: Object.values(communityIds) } },
  });
  await database.accountCleanupTask.deleteMany({
    where: { userId: { in: ids } },
  });
  await database.accountDataRequest.deleteMany({
    where: { userId: { in: ids } },
  });
  await database.user.deleteMany({ where: { id: { in: ids } } });
  await database.$disconnect();
});

describe('publication alerts', () => {
  async function drain() {
    for (let i = 0; i < 100; i++) {
      if (!(await processTripAlertBatch({ batchSize: 100 })).tripId) return;
    }
    throw new Error('Alert queue did not drain in bounded test iterations.');
  }

  it('queues alerts only for trips linked to a community', async () => {
    const typed = await createTrip('owner', {
      destinationName: `Alertless ${run}`,
    });
    const linked = await createTrip('owner', {
      communityId: communityIds.linked,
    });
    const queued = await database.tripPublicationAlert.findMany({
      where: { tripId: { in: [typed, linked] } },
      select: { tripId: true },
    });
    expect(queued).toEqual([{ tripId: linked }]);
  });

  it('sends no alert for a linked trip edited to a typed destination before delivery', async () => {
    const before = new Date(Date.now() - 60_000);
    await database.tripAlertSubscription.create({
      data: {
        userId: userIds.subscriber,
        name: 'Related destination search',
        communityId: communityIds.linked,
        enabled: true,
        createdAt: before,
        updatedAt: before,
      },
    });
    const id = await createTrip('owner', { communityId: communityIds.linked });
    const edited = await api('PATCH', `/trips/${id}`, 'owner', {
      expectedVersion: await version(id),
      destinationName: `Changed ${run}`,
    });
    expect(edited.statusCode).toBe(200);

    await drain();
    expect(
      await database.tripPublicationAlert.findUniqueOrThrow({
        where: { tripId: id },
        select: { completedAt: true },
      }),
    ).toMatchObject({ completedAt: expect.any(Date) });
    expect(
      await database.notification.count({
        where: {
          recipientId: userIds.subscriber,
          tripId: id,
          type: 'MATCHING_TRIP_PUBLISHED',
        },
      }),
    ).toBe(0);
  });
});

describe('connections, trip room and profile', () => {
  it('shows a typed destination on requests, the room and the profile', async () => {
    const name = `Kheerganga ${run}`;
    const tripId = await createTrip('owner', { destinationName: name });
    const relatedName = `Bir ${run}`;
    const relatedTripId = await createTrip('requester', {
      destinationName: relatedName,
    });

    const requested = await api(
      'POST',
      `/trips/${tripId}/connection-requests`,
      'requester',
      {
        message: 'I would like to join this trip and can share the costs.',
        relatedTripId,
      },
    );
    expect(requested.statusCode, requested.body).toBe(201);
    expect(requested.json().data).toMatchObject({
      trip: { id: tripId, destination: { slug: null, name } },
      relatedTrip: {
        id: relatedTripId,
        destination: { slug: null, name: relatedName },
      },
    });

    const accepted = await api(
      'POST',
      `/connection-requests/${requested.json().data.id}/accept`,
      'owner',
    );
    expect(accepted.statusCode, accepted.body).toBe(200);

    const room = await api('GET', `/trips/${tripId}/room`, 'requester');
    expect(room.statusCode, room.body).toBe(200);
    expect(room.json().data.plan).toMatchObject({
      destination: custom(name),
      description: null,
    });

    const profile = await api(
      'GET',
      `/users/${userIds.owner}/trips?period=upcoming&pageSize=100`,
    );
    expect(profile.statusCode, profile.body).toBe(200);
    expect(
      profile.json().data.find((trip: { id: string }) => trip.id === tripId),
    ).toMatchObject({ destination: custom(name) });
  });

  it('exports the typed destination', async () => {
    const name = `Exported ${run}`;
    const id = await createTrip('owner', { destinationName: name });
    const exported = await createAccountDataExport(userIds.owner);
    expect(
      exported?.activity.trips.find((trip) => trip.id === id),
    ).toMatchObject({ communityId: null, destinationName: name });
  });
});

describe('moderation', () => {
  it('shows staff a typed destination and removes the trip', async () => {
    const name = `Reported ${run}`;
    const id = await createTrip('owner', { destinationName: name });
    const reported = await api('POST', '/reports', 'reporter', {
      targetType: 'TRIP',
      targetId: id,
      reason: 'SCAM_OR_FRAUD',
      details: 'The destination text looks like an advert.',
    });
    expect(reported.statusCode, reported.body).toBe(201);
    const reportId = reported.json().data.id as string;

    const inspected = await api(
      'GET',
      `/admin/reports/${reportId}`,
      'moderator',
    );
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().data.target).toMatchObject({
      id,
      communityId: null,
      destinationName: name,
      description: null,
    });

    expect(
      (
        await api(
          'POST',
          `/admin/reports/${reportId}/start-review`,
          'moderator',
        )
      ).statusCode,
    ).toBe(200);
    const resolved = await api(
      'POST',
      `/admin/reports/${reportId}/resolve`,
      'moderator',
      { resolution: 'REMOVE_CONTENT', reason: 'Commercial text in the trip.' },
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await api('GET', `/trips/${id}`)).statusCode).toBe(404);
  });
});

describe('community administration', () => {
  it('counts, archives and merges only linked trips', async () => {
    // Close to the hub's name, but not equal, so it stays a typed destination.
    const emptyName = `Related empty ${run}, HP`;
    const typedId = await createTrip('owner', { destinationName: emptyName });

    const detail = await api('GET', `/communities/${slug(communityIds.empty)}`);
    expect(detail.json().data.activity.upcomingTrips).toBe(0);

    const archived = await api(
      'POST',
      `/admin/communities/${communityIds.empty}/archive`,
      'admin',
      { expectedVersion: 1, reason: 'Not needed for this test.' },
    );
    expect(archived.statusCode, archived.body).toBe(200);

    const linkedId = await createTrip('owner', {
      communityId: communityIds.source,
    });
    const merged = await api(
      'POST',
      `/admin/communities/${communityIds.source}/merge`,
      'admin',
      {
        targetCommunityId: communityIds.target,
        expectedVersion: 1,
        expectedTargetVersion: 1,
        reason: 'Duplicate destination for this test.',
      },
    );
    expect(merged.statusCode, merged.body).toBe(200);

    const trips = await database.trip.findMany({
      where: { id: { in: [typedId, linkedId] } },
      select: { id: true, communityId: true, destinationName: true },
    });
    expect(trips).toEqual(
      expect.arrayContaining([
        { id: typedId, communityId: null, destinationName: emptyName },
        {
          id: linkedId,
          communityId: communityIds.target,
          destinationName: null,
        },
      ]),
    );
  });
});

describe('account erasure', () => {
  it('cancels an erased owner’s typed trip and removes an erased member', async () => {
    const ownedId = await createTrip('leavingOwner', {
      destinationName: `Erased owner ${run}`,
    });
    const joinedId = await createTrip(
      'owner',
      { destinationName: `Erased member ${run}` },
      { desiredGroupSize: 3 },
    );
    await database.tripMembership.create({
      data: { tripId: joinedId, userId: userIds.leavingMember, role: 'MEMBER' },
    });
    await database.trip.update({
      where: { id: joinedId },
      data: { currentGroupSize: 2 },
    });

    const now = new Date();
    for (const role of ['leavingOwner', 'leavingMember'] as const) {
      await database.user.update({
        where: { id: userIds[role] },
        data: {
          status: 'PENDING_DELETION',
          statusBeforeDeletion: 'ACTIVE',
        },
      });
      await database.accountDataRequest.create({
        data: {
          userId: userIds[role],
          type: 'ACCOUNT_DELETION',
          scheduledFor: new Date(now.getTime() - 60_000),
        },
      });
    }
    await processAccountErasures({
      storage,
      logger: app.log,
      signInAccounts: { async remove() {} },
      now,
    });

    expect(
      await database.trip.findUniqueOrThrow({
        where: { id: ownedId },
        select: { status: true, destinationName: true },
      }),
    ).toEqual({ status: 'CANCELLED', destinationName: `Erased owner ${run}` });
    expect(
      await database.trip.findUniqueOrThrow({
        where: { id: joinedId },
        select: { currentGroupSize: true },
      }),
    ).toEqual({ currentGroupSize: 1 });
    expect(
      await database.tripMembership.findFirstOrThrow({
        where: { tripId: joinedId, userId: userIds.leavingMember },
        select: { status: true },
      }),
    ).toEqual({ status: 'LEFT' });
    expect(
      await database.tripChange.count({
        where: {
          tripId: { in: [ownedId, joinedId] },
          action: 'ACCOUNT_ERASURE',
        },
      }),
    ).toBe(2);
  });
});
