import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { processAccountErasures } from '../src/modules/account-deletion/account-erasure.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { MemoryStorage } from './helpers/memory-storage.js';

const run = randomUUID();
const roles = [
  'leaver',
  'canceller',
  'companion',
  'host',
  'requester',
  'admin',
] as const;
type Role = (typeof roles)[number];
const userIds = {} as Record<Role, string>;
const subject = (role: string) => `deletion-${role}-${run}`;
const communityId = randomUUID();
const tripIds = {
  owned: randomUUID(),
  joined: randomUUID(),
  asked: randomUUID(),
};
const day = 86_400_000;

// Exercise invalid authentication times as well as a genuinely old sign-in.
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    const [role, age] = token.split(':');
    const authTime =
      age === 'missing'
        ? undefined
        : age === 'invalid'
          ? new Date(Number.NaN)
          : new Date(
              Date.now() +
                (age === 'stale' ? -3_600_000 : age === 'future' ? 60_000 : 0),
            );
    return {
      subject: subject(role ?? token),
      displayName: `Deletion ${role}`,
      emailVerified: false,
      ...(authTime && { authTime }),
    };
  },
};
const storage = new MemoryStorage();
const app = buildApp({ logger: false, auth: { tokenVerifier }, storage });
const removedSignIns: string[] = [];
const erasureOptions = (now: Date) => ({
  storage,
  logger: app.log,
  signInAccounts: {
    async remove(id: string) {
      removedSignIns.push(id);
    },
  },
  now,
});

function api(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload && { payload }),
  });
}

const requestDeletion = (token: string) =>
  api('POST', '/me/data-requests', token, {
    type: 'ACCOUNT_DELETION',
    confirm: true,
  });

const notificationsFor = (role: Role, type: string) =>
  database.notification.count({
    where: { recipientId: userIds[role], type: type as never },
  });

async function createTrip(
  id: string,
  ownerId: string,
  members: string[],
  desiredGroupSize: number,
) {
  await database.trip.create({
    data: {
      id,
      ownerId,
      communityId,
      originCity: 'Delhi',
      // After the erasure date, so the trips are still upcoming then.
      startDate: new Date(Date.now() + 60 * day),
      endDate: new Date(Date.now() + 65 * day),
      durationDays: 6,
      currentGroupSize: members.length + 1,
      desiredGroupSize,
      description: 'Trip for the account deletion integration test.',
      status: members.length + 1 >= desiredGroupSize ? 'FULL' : 'PUBLISHED',
      publishedAt: new Date(),
      memberships: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          ...members.map((userId) => ({ userId, role: 'MEMBER' as const })),
        ],
      },
      conversation: {
        create: {
          participants: {
            create: [ownerId, ...members].map((userId) => ({ userId })),
          },
        },
      },
    },
  });
}

beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: `deletion-${communityId}`,
      name: 'Deletion Community',
    },
  });
  await app.ready();
  for (const role of roles) {
    const response = await api('POST', '/auth/bootstrap', role);
    userIds[role] = response.json().data.id as string;
    await database.user.update({
      where: { id: userIds[role] },
      data: {
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Integration profile for account deletion.',
            languages: ['english'],
          },
        },
      },
    });
  }
  await database.user.update({
    where: { id: userIds.admin },
    data: { staffRole: 'ADMIN' },
  });
});

afterAll(async () => {
  await app.close();
  const ids = Object.values(userIds);
  await database.report.deleteMany({
    where: {
      OR: [{ reporterId: { in: ids } }, { reportedUserId: { in: ids } }],
    },
  });
  await database.moderationAction.deleteMany({
    where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
  });
  await database.settlement.deleteMany({
    where: { tripId: { in: Object.values(tripIds) } },
  });
  await database.trip.deleteMany({
    where: { id: { in: Object.values(tripIds) } },
  });
  await database.communityPost.deleteMany({ where: { communityId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.accountDataRequest.deleteMany({
    where: { userId: { in: ids } },
  });
  await database.connectionRequest.deleteMany({
    where: { OR: [{ requesterId: { in: ids } }, { recipientId: { in: ids } }] },
  });
  await database.user.deleteMany({
    where: {
      OR: [
        { id: { in: ids } },
        { authAccounts: { some: { providerSubject: subject('leaver') } } },
      ],
    },
  });
  await database.$disconnect();
});

describe('requesting account deletion', () => {
  it('needs explicit confirmation and a recent sign-in', async () => {
    const unconfirmed = await api('POST', '/me/data-requests', 'canceller', {
      type: 'ACCOUNT_DELETION',
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.code).toBe('DELETION_NOT_CONFIRMED');

    const stale = await requestDeletion('canceller:stale');
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('RECENT_SIGN_IN_REQUIRED');
  });

  it.each(['missing', 'invalid', 'future'])(
    'rejects a %s authentication time without scheduling deletion',
    async (age) => {
      const response = await requestDeletion(`canceller:${age}`);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('RECENT_SIGN_IN_REQUIRED');
      expect(
        await database.accountDataRequest.count({
          where: { userId: userIds.canceller, type: 'ACCOUNT_DELETION' },
        }),
      ).toBe(0);
      expect(
        await database.user.findUniqueOrThrow({
          where: { id: userIds.canceller },
          select: { status: true },
        }),
      ).toEqual({ status: 'ACTIVE' });
    },
  );

  it('refuses staff accounts', async () => {
    const response = await requestDeletion('admin');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('STAFF_ACCOUNT_DELETION');
  });

  it('locks and hides the account at once and restores it when cancelled', async () => {
    const requested = await requestDeletion('canceller');
    expect(requested.statusCode).toBe(201);
    const deletion = requested.json().data;
    expect(deletion).toMatchObject({
      type: 'ACCOUNT_DELETION',
      status: 'OPEN',
    });
    const scheduledIn = Date.parse(deletion.scheduledFor) - Date.now();
    expect(Math.abs(scheduledIn - 30 * day)).toBeLessThan(60_000);

    const repeated = await requestDeletion('canceller');
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().data.id).toBe(deletion.id);

    for (const response of [
      await api('GET', '/me', 'canceller'),
      await api('POST', '/auth/bootstrap', 'canceller'),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('ACCOUNT_DELETION_PENDING');
    }
    const profile = await api('GET', `/users/${userIds.canceller}`, 'host');
    expect(profile.statusCode).toBe(404);
    expect((await api('POST', '/me/data-export', 'canceller')).statusCode).toBe(
      200,
    );

    const cancelled = await api(
      'POST',
      `/me/data-requests/${deletion.id}/cancel`,
      'canceller',
    );
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.status).toBe('CANCELLED');
    expect((await api('GET', '/me', 'canceller')).statusCode).toBe(200);
  });

  it('keeps a suspension made during the grace period after a cancel', async () => {
    const requested = await requestDeletion('canceller');
    expect(requested.statusCode).toBe(201);
    const suspended = await api(
      'POST',
      `/admin/users/${userIds.canceller}/suspend`,
      'admin',
      { reason: 'Suspended while the account waited for deletion.' },
    );
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().data.status).toBe('PENDING_DELETION');

    await api(
      'POST',
      `/me/data-requests/${requested.json().data.id}/cancel`,
      'canceller',
    );
    expect(
      await database.user.findUniqueOrThrow({
        where: { id: userIds.canceller },
        select: { status: true, statusBeforeDeletion: true },
      }),
    ).toEqual({ status: 'SUSPENDED', statusBeforeDeletion: null });
  });
});

describe('erasing an account after the grace period', () => {
  let deletionId = '';
  const photoKey = `profile-photos/${run}/photo.webp`;

  beforeAll(async () => {
    const { leaver, companion, host, requester } = userIds;
    await createTrip(tripIds.owned, leaver, [companion], 4);
    await createTrip(tripIds.joined, host, [leaver], 2);
    await createTrip(tripIds.asked, host, [], 4);
    await database.connectionRequest.createMany({
      data: [
        {
          tripId: tripIds.owned,
          requesterId: requester,
          recipientId: leaver,
          message: 'Please let me join your trip to the mountains.',
        },
        {
          tripId: tripIds.asked,
          requesterId: leaver,
          recipientId: host,
          message: 'I would love to join this trip with my camera.',
        },
      ],
    });
    const conversation = await database.conversation.findUniqueOrThrow({
      where: { tripId: tripIds.owned },
    });
    await database.message.create({
      data: {
        conversationId: conversation.id,
        senderId: leaver,
        body: 'See you all at the bus stand.',
      },
    });
    await database.settlement.create({
      data: {
        tripId: tripIds.owned,
        payerId: companion,
        receiverId: leaver,
        amountPaise: 50_000,
      },
    });
    await database.communityPost.create({
      data: {
        communityId,
        authorId: leaver,
        type: 'QUESTION',
        status: 'PUBLISHED',
        title: 'Best season for this trek?',
        body: 'Which month has the clearest views on this route?',
        publishedAt: new Date(),
      },
    });
    await database.pushDevice.create({
      data: { userId: leaver, token: `fcm-${run}`, platform: 'ANDROID' },
    });
    await database.userBlock.create({
      data: { blockerId: leaver, blockedId: requester },
    });
    await database.userProfile.update({
      where: { userId: leaver },
      data: { profilePhotoStorageKey: photoKey },
    });
    await storage.putObject({
      bucket: 'public',
      key: photoKey,
      body: Buffer.from('photo'),
      contentType: 'image/webp',
      cacheControl: 'public',
    });

    const requested = await requestDeletion('leaver');
    await database.tripChange.create({
      data: {
        tripId: tripIds.owned,
        version: 1,
        actorId: leaver,
        action: 'CREATED',
        changes: { status: { before: null, after: 'PUBLISHED' } },
      },
    });
    expect(requested.statusCode).toBe(201);
    deletionId = requested.json().data.id as string;
  });

  it('does nothing before the grace period ends', async () => {
    const result = await processAccountErasures(
      erasureOptions(new Date(Date.now() + 29 * day)),
    );
    expect(result.erased).toBe(0);
  });

  it('erases personal data and keeps shared trip history', async () => {
    const result = await processAccountErasures(
      erasureOptions(new Date(Date.now() + 31 * day)),
    );
    expect(result.erased).toBeGreaterThanOrEqual(1);
    const { leaver, requester } = userIds;

    expect(
      await database.user.findUniqueOrThrow({
        where: { id: leaver },
        select: {
          status: true,
          displayName: true,
          birthDate: true,
          profile: true,
          authAccounts: true,
          identities: true,
          pushDevices: true,
          blocksCreated: true,
          notifications: true,
        },
      }),
    ).toEqual({
      status: 'DELETED',
      displayName: null,
      birthDate: null,
      profile: null,
      authAccounts: [],
      identities: [],
      pushDevices: [],
      blocksCreated: [],
      notifications: [],
    });
    expect(storage.keys('public')).not.toContain(photoKey);
    expect(removedSignIns).toContain(subject('leaver'));
    expect(
      await database.accountDataRequest.findUniqueOrThrow({
        where: { id: deletionId },
        select: { status: true },
      }),
    ).toEqual({ status: 'COMPLETED' });

    // Their upcoming trip is cancelled, and its member is told.
    expect(
      await database.trip.findUniqueOrThrow({
        where: { id: tripIds.owned },
        select: { status: true },
      }),
    ).toEqual({ status: 'CANCELLED' });
    expect(await notificationsFor('companion', 'TRIP_STATUS_CHANGED')).toBe(1);
    const ownedHistory = await database.tripChange.findMany({
      where: { tripId: tripIds.owned },
      orderBy: { version: 'asc' },
    });
    expect(ownedHistory).toHaveLength(2);
    expect(ownedHistory.every((row) => row.actorId === null)).toBe(true);
    expect(ownedHistory[1]).toMatchObject({
      action: 'ACCOUNT_ERASURE',
      changes: { status: { before: 'PUBLISHED', after: 'CANCELLED' } },
    });
    expect(
      await database.tripChange.findFirst({
        where: { tripId: tripIds.joined },
      }),
    ).toMatchObject({
      actorId: null,
      action: 'ACCOUNT_ERASURE',
      changes: {
        currentGroupSize: { before: 2, after: 1 },
        status: { before: 'FULL', after: 'PUBLISHED' },
      },
    });

    // They leave the other upcoming trip, which has room again.
    expect(
      await database.trip.findUniqueOrThrow({
        where: { id: tripIds.joined },
        select: {
          status: true,
          currentGroupSize: true,
          memberships: { where: { userId: leaver }, select: { status: true } },
        },
      }),
    ).toEqual({
      status: 'PUBLISHED',
      currentGroupSize: 1,
      memberships: [{ status: 'LEFT' }],
    });

    // Waiting requests are answered, and pending payments cancelled.
    const requests = await database.connectionRequest.findMany({
      where: { OR: [{ requesterId: leaver }, { recipientId: leaver }] },
      select: { requesterId: true, status: true },
    });
    expect(requests).toEqual(
      expect.arrayContaining([
        { requesterId: requester, status: 'DECLINED' },
        { requesterId: leaver, status: 'WITHDRAWN' },
      ]),
    );
    expect(
      await notificationsFor('requester', 'CONNECTION_REQUEST_DECLINED'),
    ).toBe(1);
    expect(await notificationsFor('host', 'CONNECTION_REQUEST_WITHDRAWN')).toBe(
      1,
    );
    expect(
      await database.settlement.findFirstOrThrow({
        where: { tripId: tripIds.owned },
        select: { status: true },
      }),
    ).toEqual({ status: 'CANCELLED' });
    expect(await notificationsFor('companion', 'SETTLEMENT_CANCELLED')).toBe(1);

    // Shared history stays; public content is taken down.
    expect(
      await database.message.findFirstOrThrow({
        where: { senderId: leaver },
        select: { body: true },
      }),
    ).toEqual({ body: 'See you all at the bus stand.' });
    expect(
      await database.communityPost.findFirstOrThrow({
        where: { authorId: leaver },
        select: { status: true },
      }),
    ).toEqual({ status: 'REMOVED' });
  });

  it('runs only once and lets the same login start a new account', async () => {
    const again = await processAccountErasures(
      erasureOptions(new Date(Date.now() + 32 * day)),
    );
    expect(again.erased).toBe(0);

    const fresh = await api('POST', '/auth/bootstrap', 'leaver');
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().data.id).not.toBe(userIds.leaver);
  });

  it('clears remaining text and evidence a year after erasure', async () => {
    const evidenceKey = `moderation-evidence/profile-photos/${run}.webp`;
    await storage.putObject({
      bucket: 'private',
      key: evidenceKey,
      body: Buffer.from('evidence'),
      contentType: 'image/webp',
      cacheControl: 'private',
    });
    await database.report.create({
      data: {
        reporterId: userIds.requester,
        targetType: 'PROFILE_PHOTO',
        reportedUserId: userIds.leaver,
        reportedPhotoKey: photoKey,
        evidenceStorageKey: evidenceKey,
        reason: 'HARASSMENT',
      },
    });
    const { deletedAt } = await database.user.findUniqueOrThrow({
      where: { id: userIds.leaver },
      select: { deletedAt: true },
    });

    const early = await processAccountErasures(
      erasureOptions(new Date(deletedAt!.getTime() + 300 * day)),
    );
    expect(early.purged).toBe(0);
    expect(storage.keys('private')).toContain(evidenceKey);

    const result = await processAccountErasures(
      erasureOptions(new Date(deletedAt!.getTime() + 366 * day)),
    );
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(storage.keys('private')).not.toContain(evidenceKey);
    expect(
      await database.report.findFirstOrThrow({
        where: { reportedUserId: userIds.leaver },
        select: { evidenceStorageKey: true },
      }),
    ).toEqual({ evidenceStorageKey: null });
    expect(
      await database.communityPost.findFirstOrThrow({
        where: { authorId: userIds.leaver },
        select: { title: true, body: true },
      }),
    ).toEqual({ title: '', body: '' });
    expect(
      await database.connectionRequest.findFirstOrThrow({
        where: { requesterId: userIds.leaver },
        select: { message: true },
      }),
    ).toEqual({ message: '' });
  });
});
