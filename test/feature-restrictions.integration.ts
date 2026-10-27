import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const accounts = ['admin', 'moderator', 'target', 'other'] as const;
type Account = (typeof accounts)[number];
const subjects = Object.fromEntries(
  accounts.map((account) => [
    account,
    `restriction-${account}-${randomUUID()}`,
  ]),
) as Record<Account, string>;
const ids = Object.fromEntries(
  accounts.map((account) => [account, randomUUID()]),
) as Record<Account, string>;
const communityId = randomUUID();
const roomTripId = randomUUID();
const openTripId = randomUUID();
const draftTripId = randomUUID();
const conversationId = randomUUID();
const messageId = randomUUID();
const postId = randomUUID();
const otherPostId = randomUUID();
const day = 86_400_000;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: subjects[token as Account] ?? token,
      emailVerified: false,
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const headers = (account: Account) => ({ authorization: `Bearer ${account}` });

function call(
  account: Account,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: headers(account),
    ...(payload && { payload }),
  });
}

function restrict(
  feature: string,
  options: { durationDays?: number; by?: Account; user?: Account } = {},
) {
  return call(
    options.by ?? 'moderator',
    'POST',
    `/admin/users/${ids[options.user ?? 'target']}/restrictions`,
    {
      feature,
      ...(options.durationDays && { durationDays: options.durationDays }),
      reason: 'Repeated unwanted activity after warnings.',
    },
  );
}

function lift(restrictionId: string) {
  return call(
    'moderator',
    'POST',
    `/admin/restrictions/${restrictionId}/lift`,
    {
      reason: 'Restriction reviewed and lifted early.',
    },
  );
}

function trip(id: string, ownerId: string, status: 'PUBLISHED' | 'DRAFT') {
  return {
    id,
    ownerId,
    communityId,
    originCity: 'Delhi',
    startDate: new Date(Date.now() + 30 * day),
    endDate: new Date(Date.now() + 33 * day),
    durationDays: 4,
    desiredGroupSize: 5,
    description: 'A trip used to test feature restrictions end to end.',
    status,
    publishedAt: status === 'PUBLISHED' ? new Date() : null,
  };
}

beforeAll(async () => {
  for (const account of accounts) {
    await database.user.create({
      data: {
        id: ids[account],
        displayName: `Restriction ${account}`,
        birthDate: new Date('1993-04-12T00:00:00.000Z'),
        staffRole:
          account === 'admin'
            ? 'ADMIN'
            : account === 'moderator'
              ? 'MODERATOR'
              : 'USER',
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subjects[account] },
        },
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Weekend traveller who enjoys small group trips.',
            languages: ['english'],
            communityActivityVisibility: 'PUBLIC',
          },
        },
      },
    });
  }
  await database.community.create({
    data: {
      id: communityId,
      slug: `restrictions-${communityId}`,
      name: 'Restriction Test Destination',
    },
  });
  // The target is a member of roomTripId, not of openTripId, and owns a draft.
  await database.trip.createMany({
    data: [
      trip(roomTripId, ids.other, 'PUBLISHED'),
      trip(openTripId, ids.other, 'PUBLISHED'),
      trip(draftTripId, ids.target, 'DRAFT'),
    ],
  });
  await database.tripMembership.createMany({
    data: [
      { tripId: roomTripId, userId: ids.other, role: 'OWNER' },
      { tripId: roomTripId, userId: ids.target, role: 'MEMBER' },
      { tripId: openTripId, userId: ids.other, role: 'OWNER' },
      { tripId: draftTripId, userId: ids.target, role: 'OWNER' },
    ],
  });
  await database.conversation.create({
    data: {
      id: conversationId,
      tripId: roomTripId,
      participants: {
        create: [{ userId: ids.other }, { userId: ids.target }],
      },
      messages: {
        create: {
          id: messageId,
          senderId: ids.target,
          body: 'A message the target sent before any restriction.',
        },
      },
    },
  });
  await database.communityPost.createMany({
    data: [
      {
        id: postId,
        communityId,
        authorId: ids.target,
        type: 'DISCUSSION',
        status: 'PUBLISHED',
        title: 'Target post',
        body: 'A post the target wrote before any restriction.',
        publishedAt: new Date(),
      },
      {
        id: otherPostId,
        communityId,
        authorId: ids.other,
        type: 'QUESTION',
        status: 'PUBLISHED',
        title: 'Another post',
        body: 'A post by someone else that the target may comment on.',
        publishedAt: new Date(),
      },
    ],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const userIds = Object.values(ids);
  await database.accountRestriction.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.moderationAction.deleteMany({
    where: { targetId: { in: userIds } },
  });
  await database.report.deleteMany({
    where: { reporterId: { in: userIds } },
  });
  await database.connectionRequest.deleteMany({
    where: { requesterId: { in: userIds } },
  });
  await database.messageRevision.deleteMany({ where: { messageId } });
  await database.message.deleteMany({ where: { conversationId } });
  await database.conversation.deleteMany({ where: { id: conversationId } });
  await database.communityComment.deleteMany({
    where: { authorId: { in: userIds } },
  });
  await database.communityPost.deleteMany({ where: { communityId } });
  await database.tripChange.deleteMany({
    where: { tripId: { in: [roomTripId, openTripId, draftTripId] } },
  });
  await database.tripMembership.deleteMany({
    where: { tripId: { in: [roomTripId, openTripId, draftTripId] } },
  });
  await database.trip.deleteMany({ where: { communityId } });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
  await database.community.deleteMany({ where: { id: communityId } });
});

function restrictionNotices() {
  return database.notification.findMany({
    where: {
      recipientId: ids.target,
      type: { in: ['FEATURE_RESTRICTED', 'FEATURE_RESTRICTION_LIFTED'] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { type: true, sourceId: true, actorId: true },
  });
}

describe('applying and lifting restrictions', () => {
  it('lets only staff restrict, with validated input', async () => {
    const byUser = await restrict('MESSAGING', { by: 'other' });
    expect(byUser.statusCode).toBe(403);
    expect(byUser.json().error.code).toBe('STAFF_ONLY');
    for (const payload of [
      { feature: 'BOOKING', reason: 'Repeated unwanted activity.' },
      { feature: 'MESSAGING', durationDays: 0, reason: 'Long enough reason.' },
      { feature: 'MESSAGING', durationDays: 91, reason: 'Long enough reason.' },
      { feature: 'MESSAGING', reason: 'Too short' },
    ]) {
      const invalid = await call(
        'moderator',
        'POST',
        `/admin/users/${ids.target}/restrictions`,
        payload,
      );
      expect(invalid.statusCode).toBe(400);
    }
  });

  it('protects staff accounts like suspension does', async () => {
    const self = await restrict('MESSAGING', { user: 'moderator' });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('STAFF_TARGET_PROTECTED');
    const admin = await restrict('MESSAGING', { user: 'admin' });
    expect(admin.statusCode).toBe(403);
    expect(admin.json().error.code).toBe('STAFF_TARGET_PROTECTED');
  });

  it('rejects a restriction over 90 days in the database too', async () => {
    const startsAt = new Date();
    await expect(
      database.accountRestriction.create({
        data: {
          userId: ids.target,
          feature: 'MESSAGING',
          reason: 'Direct insert beyond the allowed length.',
          createdById: ids.moderator,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 91 * day),
        },
      }),
    ).rejects.toThrow(/account_restrictions_duration_check/);
  });

  it('blocks connection requests until lifted, then allows them again', async () => {
    const before = Date.now();
    const applied = await restrict('CONNECTION_REQUESTS', { durationDays: 7 });
    expect(applied.statusCode).toBe(201);
    const restriction = applied.json().data;
    expect(restriction).toMatchObject({
      userId: ids.target,
      feature: 'CONNECTION_REQUESTS',
      active: true,
      createdById: ids.moderator,
      reason: 'Repeated unwanted activity after warnings.',
      liftedAt: null,
    });
    const endsAt = new Date(restriction.endsAt).getTime();
    expect(endsAt).toBeGreaterThanOrEqual(before + 7 * day);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 7 * day);

    const request = {
      message: 'I would love to join this trip with the group.',
    };
    const blocked = await call(
      'target',
      'POST',
      `/trips/${openTripId}/connection-requests`,
      request,
    );
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatchObject({
      code: 'FEATURE_RESTRICTED',
      message: `Your account can't send connection requests until ${restriction.endsAt}.`,
    });

    const duplicate = await restrict('CONNECTION_REQUESTS', {
      durationDays: 3,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('RESTRICTION_ACTIVE');

    const mine = await call('target', 'GET', '/me/restrictions');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data).toEqual([
      {
        id: restriction.id,
        feature: 'CONNECTION_REQUESTS',
        startsAt: restriction.startsAt,
        endsAt: restriction.endsAt,
      },
    ]);

    const lifted = await lift(restriction.id);
    expect(lifted.statusCode).toBe(200);
    expect(lifted.json().data).toMatchObject({
      active: false,
      liftedById: ids.moderator,
      liftReason: 'Restriction reviewed and lifted early.',
    });
    expect((await lift(restriction.id)).json().error.code).toBe(
      'RESTRICTION_NOT_ACTIVE',
    );
    const allowed = await call(
      'target',
      'POST',
      `/trips/${openTripId}/connection-requests`,
      request,
    );
    expect(allowed.statusCode).toBe(201);
    expect(
      (await call('target', 'GET', '/me/restrictions')).json().data,
    ).toEqual([]);

    // The account hears about both steps, never who acted.
    expect(await restrictionNotices()).toEqual([
      { type: 'FEATURE_RESTRICTED', sourceId: restriction.id, actorId: null },
      {
        type: 'FEATURE_RESTRICTION_LIFTED',
        sourceId: restriction.id,
        actorId: null,
      },
    ]);
    const inbox = await call('target', 'GET', '/me/notifications');
    expect(JSON.stringify(inbox.json())).not.toContain('unwanted activity');
    expect(
      await database.moderationAction.findMany({
        where: { targetId: ids.target },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorId: true },
      }),
    ).toEqual([
      { action: 'FEATURE_RESTRICTED', actorId: ids.moderator },
      { action: 'FEATURE_RESTRICTION_LIFTED', actorId: ids.moderator },
    ]);
  });

  it('ends a timed restriction by itself, without a lift notice', async () => {
    const applied = await restrict('TRIP_PUBLISHING', { durationDays: 1 });
    const id = applied.json().data.id;
    // Move the whole restriction into the past, as if a day had gone by.
    await database.accountRestriction.update({
      where: { id },
      data: {
        startsAt: new Date(Date.now() - 2 * day),
        endsAt: new Date(Date.now() - day),
      },
    });
    expect(
      (await call('target', 'GET', '/me/restrictions')).json().data,
    ).toEqual([]);
    const expiredLift = await lift(id);
    expect(expiredLift.statusCode).toBe(409);
    const notices = await restrictionNotices();
    expect(notices.filter((notice) => notice.sourceId === id)).toEqual([
      { type: 'FEATURE_RESTRICTED', sourceId: id, actorId: null },
    ]);
    const history = await call(
      'moderator',
      'GET',
      `/admin/users/${ids.target}/restrictions`,
    );
    expect(
      history.json().data.find((item: { id: string }) => item.id === id),
    ).toMatchObject({ active: false, liftedAt: null });
  });
});

describe('restricted features', () => {
  it('blocks community posts, comments and edits until lifted, but not deleting', async () => {
    const applied = await restrict('COMMUNITY_POSTING');
    expect(applied.statusCode).toBe(201);
    expect(applied.json().data.endsAt).toBeNull();
    const until = 'until a moderator lifts the restriction';

    const post = await call(
      'target',
      'POST',
      `/communities/${communityId}/posts`,
      {
        type: 'DISCUSSION',
        title: 'A new post',
        body: 'Trying to post while community posting is restricted.',
      },
    );
    const comment = await call(
      'target',
      'POST',
      `/community-posts/${otherPostId}/comments`,
      { body: 'Trying to comment while restricted.' },
    );
    const edit = await call('target', 'PATCH', `/community-posts/${postId}`, {
      body: 'Trying to edit an existing post while restricted.',
    });
    for (const blocked of [post, comment, edit]) {
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error).toMatchObject({
        code: 'FEATURE_RESTRICTED',
        message: `Your account can't post or comment in communities ${until}.`,
      });
    }
    const removed = await call(
      'target',
      'DELETE',
      `/community-posts/${postId}`,
    );
    expect(removed.statusCode).toBe(204);

    await lift(applied.json().data.id);
    const allowed = await call(
      'target',
      'POST',
      `/community-posts/${otherPostId}/comments`,
      { body: 'Commenting again after the restriction was lifted.' },
    );
    expect(allowed.statusCode).toBe(201);
  });

  it('blocks publishing a trip but still allows editing the draft', async () => {
    const applied = await restrict('TRIP_PUBLISHING', { durationDays: 30 });
    expect(applied.statusCode).toBe(201);
    const draft = await database.trip.findUniqueOrThrow({
      where: { id: draftTripId },
    });
    const publish = await call(
      'target',
      'POST',
      `/trips/${draftTripId}/publish`,
      {
        expectedVersion: draft.version,
      },
    );
    expect(publish.statusCode).toBe(403);
    expect(publish.json().error.code).toBe('FEATURE_RESTRICTED');
    const edited = await call('target', 'PATCH', `/trips/${draftTripId}`, {
      expectedVersion: draft.version,
      desiredGroupSize: 6,
    });
    expect(edited.statusCode).toBe(200);

    await lift(applied.json().data.id);
    const published = await call(
      'target',
      'POST',
      `/trips/${draftTripId}/publish`,
      { expectedVersion: edited.json().data.version },
    );
    expect(published.statusCode).toBe(200);
    expect(published.json().data.status).toBe('PUBLISHED');
  });

  it('blocks sending and editing messages, but not reading or deleting', async () => {
    const applied = await restrict('MESSAGING', { durationDays: 3 });
    expect(applied.statusCode).toBe(201);
    const send = await call('target', 'POST', `/trips/${roomTripId}/messages`, {
      body: 'Trying to send while messaging is restricted.',
    });
    const edit = await call('target', 'PATCH', `/messages/${messageId}`, {
      body: 'Trying to edit while messaging is restricted.',
    });
    for (const blocked of [send, edit]) {
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.code).toBe('FEATURE_RESTRICTED');
    }
    const read = await call('target', 'GET', `/trips/${roomTripId}/messages`);
    expect(read.statusCode).toBe(200);
    const deleted = await call('target', 'DELETE', `/messages/${messageId}`);
    expect(deleted.statusCode).toBe(200);

    // Other features and other accounts are unaffected.
    const ownerMessage = await call(
      'other',
      'POST',
      `/trips/${roomTripId}/messages`,
      { body: 'The trip owner is not restricted.' },
    );
    expect(ownerMessage.statusCode).toBe(201);
    await lift(applied.json().data.id);
  });
});

describe('restrictions from reports and in the data export', () => {
  async function claimedReport() {
    const reported = await call('other', 'POST', '/reports', {
      targetType: 'USER',
      targetId: ids.target,
      reason: 'HARASSMENT',
      details: 'Please review these repeated messages.',
    });
    expect(reported.statusCode).toBe(201);
    const reportId = reported.json().data.id as string;
    await call('moderator', 'POST', `/admin/reports/${reportId}/start-review`);
    return reportId;
  }

  it('resolves a report with a restriction and one audit entry', async () => {
    const reportId = await claimedReport();
    const resolve = (payload: object) =>
      call('moderator', 'POST', `/admin/reports/${reportId}/resolve`, {
        reason: 'Harassment confirmed in the trip room.',
        ...payload,
      });
    const missing = await resolve({ resolution: 'RESTRICT_FEATURE' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('INVALID_RESOLUTION');
    const extra = await resolve({
      resolution: 'SUSPEND_USER',
      restriction: { feature: 'MESSAGING' },
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error.code).toBe('INVALID_RESOLUTION');

    const resolved = await resolve({
      resolution: 'RESTRICT_FEATURE',
      restriction: { feature: 'MESSAGING', durationDays: 14 },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.status).toBe('ACTIONED');
    const restriction = await database.accountRestriction.findFirstOrThrow({
      where: { reportId },
    });
    expect(restriction).toMatchObject({
      userId: ids.target,
      feature: 'MESSAGING',
      createdById: ids.moderator,
    });
    expect(
      await database.moderationAction.findMany({
        where: { reportId, action: 'FEATURE_RESTRICTED' },
        select: { targetType: true, targetId: true },
      }),
    ).toEqual([{ targetType: 'USER', targetId: ids.target }]);
    const blocked = await call(
      'target',
      'POST',
      `/trips/${roomTripId}/messages`,
      {
        body: 'Trying to message after the report decision.',
      },
    );
    expect(blocked.json().error.code).toBe('FEATURE_RESTRICTED');
  });

  it('exports restrictions without reasons or staff details', async () => {
    const exported = await call('target', 'POST', '/me/data-export');
    expect(exported.statusCode).toBe(200);
    const restrictions = exported.json().activity.restrictions as Array<
      Record<string, unknown>
    >;
    expect(restrictions.length).toBeGreaterThanOrEqual(5);
    for (const restriction of restrictions) {
      expect(Object.keys(restriction).sort()).toEqual(
        ['endsAt', 'feature', 'id', 'liftedAt', 'startsAt'].sort(),
      );
    }
    expect(JSON.stringify(restrictions)).not.toContain(ids.moderator);
  });
});
