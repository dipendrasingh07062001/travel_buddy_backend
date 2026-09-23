import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const subjects = {
  'owner-token': `room-owner-${randomUUID()}`,
  'member-one-token': `room-member-one-${randomUUID()}`,
  'member-two-token': `room-member-two-${randomUUID()}`,
  'outsider-token': `room-outsider-${randomUUID()}`,
};
const names = {
  'owner-token': 'Room Owner',
  'member-one-token': 'Room Member One',
  'member-two-token': 'Room Member Two',
  'outsider-token': 'Room Outsider',
};
const communityId = randomUUID();
const createdUserIds: string[] = [];
let ownerId = '';
let memberOneId = '';
let memberTwoId = '';
let tripId = '';

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    const typedToken = token as keyof typeof subjects;
    return {
      subject: subjects[typedToken],
      displayName: names[typedToken],
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
      slug: `trip-room-${communityId}`,
      name: 'Trip Room Integration Community',
      region: 'Himachal Pradesh',
    },
  });
  await app.ready();

  for (const token of Object.keys(subjects)) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: headers(token),
    });
    const id = response.json().data.id as string;
    createdUserIds.push(id);
    if (token === 'owner-token') ownerId = id;
    if (token === 'member-one-token') memberOneId = id;
    if (token === 'member-two-token') memberTwoId = id;
    await database.user.update({
      where: { id },
      data: {
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Integration profile for trip-room coordination.',
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
      transport: 'BUS',
      description: 'Published trip for trip-room coordination integration.',
    },
  });
  expect(trip.statusCode).toBe(201);
  tripId = trip.json().data.id;
  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/trips/${tripId}/publish`,
    headers: headers('owner-token'),
    payload: { expectedVersion: 1 },
  });
  expect(published.statusCode).toBe(200);

  for (const token of ['member-one-token', 'member-two-token']) {
    const request = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/connection-requests`,
      headers: headers(token),
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
  }
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({ where: { id: tripId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await database.$disconnect();
});

describe('persisted trip-room coordination', () => {
  it('coordinates the shared plan, checklist, and membership lifecycle', async () => {
    const initialRoom = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/room`,
      headers: headers('member-one-token'),
    });
    expect(initialRoom.statusCode).toBe(200);
    expect(initialRoom.json().data).toMatchObject({
      status: 'ACTIVE',
      plan: {
        originCity: 'Delhi',
        destination: { id: communityId },
        transport: 'BUS',
        status: 'FULL',
        version: 4,
      },
      checklist: [],
    });

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/checklist-items`,
      headers: headers('member-one-token'),
      payload: { title: '  Confirm the bus tickets  ' },
    });
    expect(created.statusCode).toBe(201);
    const itemId = created.json().data.id as string;
    const completed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/checklist-items/${itemId}`,
      headers: headers('member-two-token'),
      payload: { completed: true },
    });
    expect(completed.json().data).toMatchObject({
      title: 'Confirm the bus tickets',
      status: 'COMPLETED',
      completedBy: { id: memberTwoId },
    });

    const roomWithChecklist = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/room`,
      headers: headers('owner-token'),
    });
    expect(roomWithChecklist.json().data.checklist).toHaveLength(1);

    const outsiderRemoval = await app.inject({
      method: 'DELETE',
      url: `/api/v1/checklist-items/${itemId}`,
      headers: headers('outsider-token'),
    });
    const ownerRemoval = await app.inject({
      method: 'DELETE',
      url: `/api/v1/checklist-items/${itemId}`,
      headers: headers('owner-token'),
    });
    expect(outsiderRemoval.statusCode).toBe(404);
    expect(ownerRemoval.json().data.status).toBe('REMOVED');
    const persistedItem = await database.tripChecklistItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(persistedItem.removedAt).not.toBeNull();

    await database.trip.update({
      where: { id: tripId },
      data: { status: 'COMPLETED' },
    });
    const endedCreate = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/checklist-items`,
      headers: headers('member-one-token'),
      payload: { title: 'Do not add this item' },
    });
    const endedLeave = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/leave`,
      headers: headers('member-one-token'),
    });
    expect(endedCreate.statusCode).toBe(409);
    expect(endedLeave.statusCode).toBe(409);
    await database.trip.update({
      where: { id: tripId },
      data: { status: 'FULL' },
    });

    const left = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/leave`,
      headers: headers('member-one-token'),
    });
    expect(left.statusCode).toBe(204);
    const formerMemberAccess = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/room`,
      headers: headers('member-one-token'),
    });
    expect(formerMemberAccess.statusCode).toBe(404);

    const removed = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/members/${memberTwoId}/remove`,
      headers: headers('owner-token'),
    });
    expect(removed.statusCode).toBe(204);

    const persistedTrip = await database.trip.findUniqueOrThrow({
      where: { id: tripId },
      include: {
        memberships: { orderBy: { joinedAt: 'asc' } },
        conversation: { include: { participants: true } },
      },
    });
    expect(persistedTrip).toMatchObject({
      currentGroupSize: 1,
      status: 'PUBLISHED',
      version: 6,
    });
    expect(
      persistedTrip.memberships.map((membership) => ({
        userId: membership.userId,
        status: membership.status,
      })),
    ).toEqual([
      { userId: ownerId, status: 'ACTIVE' },
      { userId: memberOneId, status: 'LEFT' },
      { userId: memberTwoId, status: 'REMOVED' },
    ]);
    expect(persistedTrip.conversation?.participants).toHaveLength(3);
  });
});
