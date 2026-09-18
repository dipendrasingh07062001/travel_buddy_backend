import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const ownerSubject = `connection-owner-${randomUUID()}`;
const requesterSubject = `connection-requester-${randomUUID()}`;
const outsiderSubject = `connection-outsider-${randomUUID()}`;
const communityId = randomUUID();
const createdUserIds: string[] = [];
let tripId: string | undefined;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    const subject =
      token === 'owner-token'
        ? ownerSubject
        : token === 'requester-token'
          ? requesterSubject
          : outsiderSubject;
    return {
      subject,
      displayName:
        token === 'owner-token'
          ? 'Connection Owner'
          : token === 'requester-token'
            ? 'Connection Requester'
            : 'Connection Outsider',
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
      slug: `connections-${communityId}`,
      name: 'Connection Integration Community',
      region: 'Himachal Pradesh',
    },
  });
  await app.ready();

  for (const token of ['owner-token', 'requester-token', 'outsider-token']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: headers(token),
    });
    const userId = response.json().data.id as string;
    createdUserIds.push(userId);
    await database.user.update({
      where: { id: userId },
      data: {
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            homeRegion: 'Delhi NCR',
            biography: 'Integration profile for connection workflow testing.',
            languages: ['english', 'hindi'],
            travelInterests: ['trekking'],
          },
        },
      },
    });
  }
});

afterAll(async () => {
  await app.close();
  if (tripId) await database.trip.deleteMany({ where: { id: tripId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await database.$disconnect();
});

describe('connection request persistence and membership transaction', () => {
  it('accepts a request atomically and grants only members private access', async () => {
    const startDate = new Date(Date.now() + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const endDate = new Date(Date.now() + 35 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const createdTrip = await app.inject({
      method: 'POST',
      url: '/api/v1/trips',
      headers: headers('owner-token'),
      payload: {
        communityId,
        originCity: 'Delhi',
        startDate,
        endDate,
        currentGroupSize: 1,
        desiredGroupSize: 2,
        transport: 'BUS',
        description: 'Published trip for the connection integration workflow.',
      },
    });
    expect(createdTrip.statusCode).toBe(201);
    tripId = createdTrip.json().data.id;

    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: headers('owner-token'),
      payload: { expectedVersion: 1 },
    });
    expect(published.statusCode).toBe(200);

    const requested = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/connection-requests`,
      headers: headers('requester-token'),
      payload: {
        message:
          'I am available on these dates and would like to discuss joining.',
      },
    });
    expect(requested.statusCode).toBe(201);
    const requestId = requested.json().data.id as string;

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/connection-requests/${requestId}/accept`,
      headers: headers('owner-token'),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.status).toBe('ACCEPTED');

    if (!tripId) throw new Error('The integration trip was not created.');
    const persistedTrip = await database.trip.findUniqueOrThrow({
      where: { id: tripId },
      include: { memberships: { orderBy: { joinedAt: 'asc' } } },
    });
    expect(persistedTrip).toMatchObject({
      currentGroupSize: 2,
      desiredGroupSize: 2,
      status: 'FULL',
      version: 3,
    });
    expect(persistedTrip.memberships).toHaveLength(2);
    expect(persistedTrip.memberships.map((member) => member.role)).toEqual([
      'OWNER',
      'MEMBER',
    ]);

    const memberAccess = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/members`,
      headers: headers('requester-token'),
    });
    const outsiderAccess = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/members`,
      headers: headers('outsider-token'),
    });
    expect(memberAccess.statusCode).toBe(200);
    expect(memberAccess.json().data).toHaveLength(2);
    expect(outsiderAccess.statusCode).toBe(403);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/connection-requests`,
      headers: headers('requester-token'),
      payload: {
        message: 'This duplicate request must remain blocked after acceptance.',
      },
    });
    expect(duplicate.statusCode).toBe(404);
    expect(duplicate.json().error.code).toBe('TRIP_NOT_REQUESTABLE');
  });
});
