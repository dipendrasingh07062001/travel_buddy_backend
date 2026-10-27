import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const subjects = {
  admin: `moderation-admin-${randomUUID()}`,
  moderator: `moderation-staff-${randomUUID()}`,
  reporter: `moderation-reporter-${randomUUID()}`,
  owner: `moderation-owner-${randomUUID()}`,
};
const ids: Record<keyof typeof subjects, string> = {
  admin: randomUUID(),
  moderator: randomUUID(),
  reporter: randomUUID(),
  owner: randomUUID(),
};
const communityId = randomUUID();
const tripId = randomUUID();
const postId = randomUUID();
const commentId = randomUUID();
const conversationId = randomUUID();
const messageId = randomUUID();

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    const key = token as keyof typeof subjects;
    return { subject: subjects[key] ?? token, emailVerified: false };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: `moderation-${communityId}`,
      name: 'Moderation Test Destination',
      region: 'Himachal Pradesh',
    },
  });
  for (const key of Object.keys(subjects) as Array<keyof typeof subjects>) {
    await database.user.create({
      data: {
        id: ids[key],
        displayName: `Test ${key}`,
        staffRole:
          key === 'admin'
            ? 'ADMIN'
            : key === 'moderator'
              ? 'MODERATOR'
              : 'USER',
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subjects[key] },
        },
      },
    });
  }
  const startDate = new Date(Date.now() + 30 * 86_400_000);
  const endDate = new Date(Date.now() + 35 * 86_400_000);
  await database.trip.create({
    data: {
      id: tripId,
      ownerId: ids.owner,
      communityId,
      originCity: 'Delhi',
      startDate,
      endDate,
      durationDays: 6,
      currentGroupSize: 2,
      desiredGroupSize: 3,
      description: 'A public trip created to test moderation takedown.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
    },
  });
  await database.communityPost.create({
    data: {
      id: postId,
      communityId,
      authorId: ids.owner,
      type: 'DISCUSSION',
      status: 'PUBLISHED',
      title: 'Moderation test post',
      body: 'A published discussion created for moderation testing.',
      publishedAt: new Date(),
    },
  });
  await database.communityComment.create({
    data: {
      id: commentId,
      postId,
      authorId: ids.owner,
      body: 'A comment used to test moderation removal.',
    },
  });
  await database.tripMembership.createMany({
    data: [
      { tripId, userId: ids.owner, role: 'OWNER' },
      { tripId, userId: ids.reporter, role: 'MEMBER' },
    ],
  });
  await database.conversation.create({
    data: {
      id: conversationId,
      tripId,
      participants: {
        create: [{ userId: ids.owner }, { userId: ids.reporter }],
      },
      messages: {
        create: {
          id: messageId,
          senderId: ids.owner,
          body: 'A private message used to test moderation removal.',
        },
      },
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.moderationAction.deleteMany({
    where: {
      targetId: {
        in: [tripId, postId, commentId, messageId, ...Object.values(ids)],
      },
    },
  });
  await database.report.deleteMany({ where: { reporterId: ids.reporter } });
  await database.messageRevision.deleteMany({ where: { messageId } });
  await database.message.deleteMany({ where: { id: messageId } });
  await database.conversation.deleteMany({ where: { id: conversationId } });
  await database.tripMembership.deleteMany({ where: { tripId } });
  await database.communityComment.deleteMany({ where: { id: commentId } });
  await database.communityPost.deleteMany({ where: { id: postId } });
  await database.trip.deleteMany({ where: { id: tripId } });
  await database.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.$disconnect();
});

async function report(
  targetType:
    'TRIP' | 'USER' | 'COMMUNITY_POST' | 'COMMUNITY_COMMENT' | 'MESSAGE',
  targetId: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/reports',
    headers: headers('reporter'),
    payload: {
      targetType,
      targetId,
      reason: 'SCAM_OR_FRAUD',
      details: 'Please review this reported item.',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.id as string;
}

const moderationNoticeTypes = [
  'TRIP_REMOVED',
  'COMMUNITY_POST_REMOVED',
  'COMMUNITY_COMMENT_REMOVED',
  'MESSAGE_REMOVED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_RESTORED',
] as const;

function moderationNotices(account: keyof typeof ids) {
  return database.notification.findMany({
    where: {
      recipientId: ids[account],
      type: { in: [...moderationNoticeTypes] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { type: true, sourceId: true, tripId: true, actorId: true },
  });
}

async function resolveReport(
  reportId: string,
  resolution: 'DISMISS' | 'SUSPEND_USER' | 'REMOVE_CONTENT',
  reason: string,
) {
  await app.inject({
    method: 'POST',
    url: `/api/v1/admin/reports/${reportId}/start-review`,
    headers: headers('moderator'),
  });
  return app.inject({
    method: 'POST',
    url: `/api/v1/admin/reports/${reportId}/resolve`,
    headers: headers('moderator'),
    payload: { resolution, reason },
  });
}

describe('moderation and enforcement', () => {
  it('denies non-staff and restricts audit access to administrators', async () => {
    const guest = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports',
    });
    const user = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports',
      headers: headers('reporter'),
    });
    const staff = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports',
      headers: headers('moderator'),
    });
    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/moderation-actions',
      headers: headers('moderator'),
    });
    expect(guest.statusCode).toBe(401);
    expect(user.statusCode).toBe(403);
    expect(user.json().error.code).toBe('STAFF_ONLY');
    expect(staff.statusCode).toBe(200);
    expect(audit.statusCode).toBe(403);
  });

  it('claims, removes a reported trip, and prevents republication', async () => {
    const reportId = await report('TRIP', tripId);
    const inspected = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/reports/${reportId}`,
      headers: headers('moderator'),
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().data.target.description).toContain('public trip');
    // Published before confirmations were recorded, so none is shown.
    expect(inspected.json().data.target).toMatchObject({
      publishConfirmedAt: null,
      publishConfirmationVersion: null,
    });
    expect(
      await database.moderationAction.count({
        where: { reportId, action: 'REPORT_INSPECTED' },
      }),
    ).toBe(1);
    const claim = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/start-review`,
      headers: headers('moderator'),
    });
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/start-review`,
      headers: headers('admin'),
    });
    expect(claim.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(409);

    const wrongReviewer = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/resolve`,
      headers: headers('reporter'),
      payload: {
        resolution: 'REMOVE_CONTENT',
        reason: 'This is confirmed commercial spam.',
      },
    });
    expect(wrongReviewer.statusCode).toBe(403);

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/resolve`,
      headers: headers('moderator'),
      payload: {
        resolution: 'REMOVE_CONTENT',
        reason: 'This is confirmed commercial spam.',
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.status).toBe('ACTIONED');
    // The owner learns what was removed; the reporter, a trip member, does
    // not, and nothing names the moderator or repeats their reason.
    expect(await moderationNotices('owner')).toEqual([
      { type: 'TRIP_REMOVED', sourceId: tripId, tripId, actorId: null },
    ]);
    expect(await moderationNotices('reporter')).toEqual([]);
    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v1/me/notifications',
      headers: headers('owner'),
    });
    expect(inbox.json().data).toContainEqual(
      expect.objectContaining({
        type: 'TRIP_REMOVED',
        title: 'Your trip was removed',
        sourceId: tripId,
        actorId: null,
      }),
    );
    expect(JSON.stringify(inbox.json())).not.toContain('commercial spam');
    const tripHistory = await database.tripChange.findMany({
      where: { tripId },
    });
    expect(tripHistory).toHaveLength(1);
    expect(tripHistory[0]).toMatchObject({
      action: 'MODERATION_REMOVED',
      version: 2,
      changes: { moderationRemoved: { before: false, after: true } },
    });
    expect(JSON.stringify(tripHistory)).not.toContain('commercial spam');
    const hiddenHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/history`,
      headers: headers('owner'),
    });
    expect(hiddenHistory.statusCode).toBe(404);

    const publicTrip = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}`,
    });
    expect(publicTrip.statusCode).toBe(404);
    const ownerPublish = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: headers('owner'),
      payload: { expectedVersion: 2, confirmsPersonalPlan: true },
    });
    expect(ownerPublish.statusCode).toBe(403);
    expect(ownerPublish.json().error.code).toBe('TRIP_REMOVED_BY_MODERATION');

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/moderation-actions',
      headers: headers('admin'),
    });
    expect(audit.statusCode).toBe(200);
    expect(
      audit
        .json()
        .data.some(
          (action: { action: string; reportId: string }) =>
            action.action === 'CONTENT_REMOVED' && action.reportId === reportId,
        ),
    ).toBe(true);
  });

  it('soft-removes a reported comment', async () => {
    const reportId = await report('COMMUNITY_COMMENT', commentId);
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/start-review`,
      headers: headers('moderator'),
    });
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/resolve`,
      headers: headers('moderator'),
      payload: {
        resolution: 'REMOVE_CONTENT',
        reason: 'This comment violates the community standards.',
      },
    });
    expect(resolved.statusCode).toBe(200);
    const stored = await database.communityComment.findUniqueOrThrow({
      where: { id: commentId },
    });
    expect(stored.status).toBe('REMOVED');
    expect(stored.removedAt).not.toBeNull();
    expect(await moderationNotices('owner')).toContainEqual({
      type: 'COMMUNITY_COMMENT_REMOVED',
      sourceId: commentId,
      tripId: null,
      actorId: null,
    });
  });

  it('removes a reported community post while retaining the record', async () => {
    const reportId = await report('COMMUNITY_POST', postId);
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/start-review`,
      headers: headers('moderator'),
    });
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/resolve`,
      headers: headers('moderator'),
      payload: {
        resolution: 'REMOVE_CONTENT',
        reason: 'This published post violates policy.',
      },
    });
    expect(resolved.statusCode).toBe(200);
    const stored = await database.communityPost.findUniqueOrThrow({
      where: { id: postId },
    });
    expect(stored.status).toBe('REMOVED');
    expect(stored.removedAt).not.toBeNull();
    const publicPost = await app.inject({
      method: 'GET',
      url: `/api/v1/community-posts/${postId}`,
    });
    expect(publicPost.statusCode).toBe(404);
    expect(await moderationNotices('owner')).toContainEqual({
      type: 'COMMUNITY_POST_REMOVED',
      sourceId: postId,
      tripId: null,
      actorId: null,
    });
  });

  it('redacts a reported private message and preserves its revision', async () => {
    const reportId = await report('MESSAGE', messageId);
    const inspected = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/reports/${reportId}`,
      headers: headers('moderator'),
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().data.target.body).toContain('private message');
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/start-review`,
      headers: headers('moderator'),
    });
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/resolve`,
      headers: headers('moderator'),
      payload: {
        resolution: 'REMOVE_CONTENT',
        reason: 'This message contains prohibited solicitation.',
      },
    });
    expect(resolved.statusCode).toBe(200);
    const stored = await database.message.findUniqueOrThrow({
      where: { id: messageId },
    });
    expect(stored.status).toBe('DELETED');
    const revision = await database.messageRevision.findFirst({
      where: { messageId },
    });
    expect(revision?.editorId).toBe(ids.moderator);
    const visible = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('reporter'),
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().data[0].body).toBeNull();
    expect(await moderationNotices('owner')).toContainEqual({
      type: 'MESSAGE_REMOVED',
      sourceId: messageId,
      tripId,
      actorId: null,
    });
    expect(await moderationNotices('reporter')).toEqual([]);
  });

  it('suspends a reported account and permits only an admin to restore it', async () => {
    const reportId = await report('USER', ids.owner);
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/start-review`,
      headers: headers('moderator'),
    });
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${reportId}/resolve`,
      headers: headers('moderator'),
      payload: {
        resolution: 'SUSPEND_USER',
        reason: 'Repeated verified policy violations.',
      },
    });
    expect(resolved.statusCode).toBe(200);
    const disabled = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: headers('owner'),
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().error.code).toBe('ACCOUNT_SUSPENDED');
    const suspension = await database.moderationAction.findFirstOrThrow({
      where: { reportId, action: 'USER_SUSPENDED' },
    });
    expect(await moderationNotices('owner')).toContainEqual({
      type: 'ACCOUNT_SUSPENDED',
      sourceId: suspension.id,
      tripId: null,
      actorId: null,
    });

    const staffRestore = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${ids.owner}/restore`,
      headers: headers('moderator'),
      payload: { reason: 'Appeal accepted after review.' },
    });
    expect(staffRestore.statusCode).toBe(403);
    const adminRestore = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${ids.owner}/restore`,
      headers: headers('admin'),
      payload: { reason: 'Appeal accepted after review.' },
    });
    expect(adminRestore.statusCode).toBe(200);
    const restored = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: headers('owner'),
    });
    expect(restored.statusCode).toBe(200);
    const restoration = await database.moderationAction.findFirstOrThrow({
      where: { targetId: ids.owner, action: 'USER_RESTORED' },
    });
    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v1/me/notifications',
      headers: headers('owner'),
    });
    expect(inbox.json().data).toContainEqual(
      expect.objectContaining({
        type: 'ACCOUNT_RESTORED',
        title: 'Your account access was restored',
        sourceId: restoration.id,
        actorId: null,
      }),
    );
  });

  it('rejects privilege abuse and whitespace-only moderation reasons', async () => {
    const ordinary = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${ids.owner}/suspend`,
      headers: headers('reporter'),
      payload: { reason: 'This ordinary user cannot suspend someone.' },
    });
    expect(ordinary.statusCode).toBe(403);
    const protectedAdmin = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${ids.admin}/suspend`,
      headers: headers('moderator'),
      payload: { reason: 'Attempted suspension of an administrator.' },
    });
    expect(protectedAdmin.statusCode).toBe(403);
    expect(protectedAdmin.json().error.code).toBe('STAFF_TARGET_PROTECTED');
    const blank = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${ids.owner}/suspend`,
      headers: headers('moderator'),
      payload: { reason: '             ' },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error.code).toBe('INVALID_MODERATION_REASON');
  });

  it('does not tell a reported account about a dismissed report', async () => {
    const before = await moderationNotices('owner');
    const reportId = await report('USER', ids.owner);
    const resolved = await resolveReport(
      reportId,
      'DISMISS',
      'No policy violation was found.',
    );
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.status).toBe('DISMISSED');
    expect(await moderationNotices('owner')).toEqual(before);
  });

  it('sends one notice for each direct suspension and restore', async () => {
    const before = await moderationNotices('owner');
    for (let round = 0; round < 2; round += 1) {
      const suspended = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${ids.owner}/suspend`,
        headers: headers('moderator'),
        payload: { reason: 'Direct suspension for repeated spam.' },
      });
      expect(suspended.statusCode).toBe(200);
      const restored = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${ids.owner}/restore`,
        headers: headers('admin'),
        payload: { reason: 'Suspension period ended after review.' },
      });
      expect(restored.statusCode).toBe(200);
    }
    const after = await moderationNotices('owner');
    expect(after.slice(before.length).map((notice) => notice.type)).toEqual([
      'ACCOUNT_SUSPENDED',
      'ACCOUNT_RESTORED',
      'ACCOUNT_SUSPENDED',
      'ACCOUNT_RESTORED',
    ]);
    expect(new Set(after.map((notice) => notice.sourceId)).size).toBe(
      after.length,
    );
    expect(after.every((notice) => notice.actorId === null)).toBe(true);
  });
});
