import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const ownerSubject = `safety-owner-${randomUUID()}`;
const requesterSubject = `safety-requester-${randomUUID()}`;
const communityId = randomUUID();
const createdUserIds: string[] = [];
let ownerId = '';
let requesterId = '';
let tripId = '';
let requestId = '';

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    const owner = token === 'owner-token';
    return {
      subject: owner ? ownerSubject : requesterSubject,
      displayName: owner ? 'Safety Owner' : 'Safety Requester',
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
      slug: `safety-${communityId}`,
      name: 'Safety Integration Community',
      region: 'Himachal Pradesh',
    },
  });
  await app.ready();
  for (const token of ['owner-token', 'requester-token']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: headers(token),
    });
    const id = response.json().data.id as string;
    createdUserIds.push(id);
    if (token === 'owner-token') ownerId = id;
    else requesterId = id;
    await database.user.update({
      where: { id },
      data: {
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Integration profile for safety workflow testing.',
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
      currentGroupSize: 1,
      desiredGroupSize: 3,
      description: 'Published trip used to verify persisted safety controls.',
    },
  });
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
    headers: headers('requester-token'),
    payload: {
      message: 'I am interested in joining this safety integration trip.',
    },
  });
  requestId = request.json().data.id;
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

describe('persisted safety controls', () => {
  it('blocks a user and atomically closes pending requests in both directions', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${requesterId}/block`,
      headers: headers('owner-token'),
    });
    expect(response.statusCode).toBe(200);

    const persistedRequest = await database.connectionRequest.findUniqueOrThrow(
      {
        where: { id: requestId },
      },
    );
    expect(persistedRequest.status).toBe('BLOCKED');
    const storedBlock = await database.userBlock.findUnique({
      where: {
        blockerId_blockedId: { blockerId: ownerId, blockedId: requesterId },
      },
    });
    expect(storedBlock).not.toBeNull();

    const blockedAccept = await app.inject({
      method: 'POST',
      url: `/api/v1/connection-requests/${requestId}/accept`,
      headers: headers('owner-token'),
    });
    expect(blockedAccept.statusCode).toBe(403);
    expect(blockedAccept.json().error.code).toBe('CONTACT_BLOCKED');

    const blockedSend = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/connection-requests`,
      headers: headers('requester-token'),
      payload: { message: 'A blocked user cannot create another request.' },
    });
    expect(blockedSend.statusCode).toBe(403);
    expect(blockedSend.json().error.code).toBe('CONTACT_BLOCKED');
  });

  it('persists auditable reports and returns only the reporter records', async () => {
    const report = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('requester-token'),
      payload: {
        targetType: 'TRIP',
        targetId: tripId,
        reason: 'COMMERCIAL_TOUR_SPAM',
        details: 'This listing appears to advertise a commercial tour.',
      },
    });
    expect(report.statusCode).toBe(201);

    const own = await app.inject({
      method: 'GET',
      url: '/api/v1/me/reports',
      headers: headers('requester-token'),
    });
    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/me/reports',
      headers: headers('owner-token'),
    });
    expect(own.json().data).toHaveLength(1);
    expect(own.json().data[0].target).toEqual({ type: 'TRIP', id: tripId });
    expect(other.json().data).toHaveLength(0);
  });
});
