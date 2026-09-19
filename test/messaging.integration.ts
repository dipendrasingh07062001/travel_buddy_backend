import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const ownerSubject = `message-owner-${randomUUID()}`;
const memberSubject = `message-member-${randomUUID()}`;
const outsiderSubject = `message-outsider-${randomUUID()}`;
const communityId = randomUUID();
const createdUserIds: string[] = [];
let ownerId = '';
let memberId = '';
let tripId = '';
let messageId = '';

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    const subject =
      token === 'owner-token'
        ? ownerSubject
        : token === 'member-token'
          ? memberSubject
          : outsiderSubject;
    return {
      subject,
      displayName:
        token === 'owner-token'
          ? 'Messaging Owner'
          : token === 'member-token'
            ? 'Messaging Member'
            : 'Messaging Outsider',
      emailVerified: false,
    };
  },
};

const app = buildApp({ logger: false, auth: { tokenVerifier } });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: `messaging-${communityId}`,
      name: 'Messaging Integration Community',
      region: 'Himachal Pradesh',
    },
  });
  await app.ready();
  for (const token of ['owner-token', 'member-token', 'outsider-token']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: headers(token),
    });
    const id = response.json().data.id as string;
    createdUserIds.push(id);
    if (token === 'owner-token') ownerId = id;
    if (token === 'member-token') memberId = id;
    await database.user.update({
      where: { id },
      data: {
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Integration profile for private messaging testing.',
            languages: ['english'],
          },
        },
      },
    });
  }

  const startDate = new Date(Date.now() + 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const endDate = new Date(Date.now() + 35 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const trip = await app.inject({
    method: 'POST',
    url: '/api/v1/trips',
    headers: headers('owner-token'),
    payload: {
      communityId,
      originCity: 'Delhi',
      startDate,
      endDate,
      desiredGroupSize: 3,
      description: 'Published trip for persisted private messaging tests.',
    },
  });
  expect(trip.statusCode).toBe(201);
  tripId = trip.json().data.id;
  await app.inject({
    method: 'POST',
    url: `/api/v1/trips/${tripId}/publish`,
    headers: headers('owner-token'),
    payload: { expectedVersion: 1 },
  });
  const request = await app.inject({
    method: 'POST',
    url: `/api/v1/trips/${tripId}/connection-requests`,
    headers: headers('member-token'),
    payload: {
      message: 'I am available and would like to join this travel group.',
    },
  });
  expect(request.statusCode).toBe(201);
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/v1/connection-requests/${request.json().data.id}/accept`,
    headers: headers('owner-token'),
  });
  expect(accepted.statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await database.report.deleteMany({
    where: { reporterId: { in: createdUserIds } },
  });
  await database.userBlock.deleteMany({
    where: {
      OR: [
        { blockerId: { in: createdUserIds } },
        { blockedId: { in: createdUserIds } },
      ],
    },
  });
  await database.trip.deleteMany({ where: { id: tripId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await database.$disconnect();
});

describe('persisted private trip-room messaging', () => {
  it('creates private room participation from accepted trip membership', async () => {
    const ownerRoom = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/room`,
      headers: headers('owner-token'),
    });
    const memberRoom = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/room`,
      headers: headers('member-token'),
    });
    const outsiderRoom = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/room`,
      headers: headers('outsider-token'),
    });
    expect(ownerRoom.statusCode).toBe(200);
    expect(memberRoom.statusCode).toBe(200);
    expect(ownerRoom.json().data.members).toHaveLength(2);
    expect(outsiderRoom.statusCode).toBe(404);

    const conversation = await database.conversation.findUniqueOrThrow({
      where: { tripId },
      include: { participants: true },
    });
    expect(
      conversation.participants.map((value) => value.userId).sort(),
    ).toEqual([ownerId, memberId].sort());
  });

  it('persists messages privately and audits edits and soft deletion', async () => {
    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('member-token'),
      payload: { body: 'Let us confirm our meeting point tomorrow evening.' },
    });
    expect(sent.statusCode).toBe(201);
    messageId = sent.json().data.id;

    const ownerList = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('owner-token'),
    });
    const outsiderList = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('outsider-token'),
    });
    expect(ownerList.json().data).toHaveLength(1);
    expect(outsiderList.statusCode).toBe(404);

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/messages/${messageId}`,
      headers: headers('member-token'),
      payload: { body: 'Let us confirm our meeting point tomorrow at 7 PM.' },
    });
    expect(edited.json().data.status).toBe('EDITED');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/messages/${messageId}`,
      headers: headers('member-token'),
    });
    expect(deleted.json().data).toMatchObject({
      body: null,
      status: 'DELETED',
    });

    const persisted = await database.message.findUniqueOrThrow({
      where: { id: messageId },
      include: { revisions: { orderBy: { createdAt: 'asc' } } },
    });
    expect(persisted.body).toBe(
      'Let us confirm our meeting point tomorrow at 7 PM.',
    );
    expect(persisted.revisions.map((revision) => revision.action)).toEqual([
      'EDIT',
      'DELETE',
    ]);
    expect(persisted.revisions[0]?.previousBody).toBe(
      'Let us confirm our meeting point tomorrow evening.',
    );
  });

  it('allows a member to report a deleted message for moderation evidence', async () => {
    const report = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('owner-token'),
      payload: {
        targetType: 'MESSAGE',
        targetId: messageId,
        reason: 'HARASSMENT',
        details: 'Preserve this deleted message for moderator review.',
      },
    });
    expect(report.statusCode).toBe(201);
    expect(report.json().data.target).toEqual({
      type: 'MESSAGE',
      id: messageId,
    });
  });

  it('hides blocked-member messages and prevents a two-person block bypass', async () => {
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${memberId}/block`,
      headers: headers('owner-token'),
    });
    expect(blocked.statusCode).toBe(200);

    const hiddenHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('owner-token'),
    });
    const blockedSend = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('owner-token'),
      payload: { body: 'A two-person room must not bypass the active block.' },
    });
    expect(hiddenHistory.json().data).toHaveLength(0);
    expect(blockedSend.statusCode).toBe(403);
    expect(blockedSend.json().error.code).toBe('CONTACT_BLOCKED');
  });

  it('persists read and mute state and makes completed rooms read-only', async () => {
    const read = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/read`,
      headers: headers('owner-token'),
    });
    const muted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${tripId}/room/preferences`,
      headers: headers('owner-token'),
      payload: { muted: true },
    });
    expect(read.statusCode).toBe(204);
    expect(muted.json().data.preferences.muted).toBe(true);
    expect(muted.json().data.preferences.lastReadAt).toBeTruthy();

    await database.trip.update({
      where: { id: tripId },
      data: { status: 'COMPLETED' },
    });
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('owner-token'),
      payload: { body: 'Completed rooms must not accept new messages.' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('TRIP_ROOM_READ_ONLY');

    await database.tripMembership.update({
      where: { tripId_userId: { tripId, userId: memberId } },
      data: { status: 'REMOVED', removedAt: new Date() },
    });
    const removedAccess = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/room`,
      headers: headers('member-token'),
    });
    expect(removedAccess.statusCode).toBe(404);
  });
});
