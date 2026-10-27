import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const run = randomUUID();
const communityId = randomUUID();
const communitySlug = `trip-integrity-${communityId}`;
const tokens = ['owner-token', 'member-token', 'latecomer-token'] as const;
const createdUserIds: string[] = [];
const createdTripIds: string[] = [];

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: `trip-integrity-${token}-${run}`,
      displayName: token,
      emailVerified: false,
    };
  },
};

const app = buildApp({ logger: false, auth: { tokenVerifier } });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const isoDate = (daysFromToday: number) =>
  new Date(Date.now() + daysFromToday * 86_400_000).toISOString().slice(0, 10);

async function createPublishedTrip(desiredGroupSize: number) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/trips',
    headers: headers('owner-token'),
    payload: {
      communityId,
      originCity: 'Delhi',
      startDate: isoDate(20),
      endDate: isoDate(24),
      desiredGroupSize,
      description: 'Published trip for trip integrity integration testing.',
    },
  });
  expect(created.statusCode).toBe(201);
  const tripId = created.json().data.id as string;
  createdTripIds.push(tripId);

  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/trips/${tripId}/publish`,
    headers: headers('owner-token'),
    payload: { expectedVersion: 1, confirmsPersonalPlan: true },
  });
  expect(published.statusCode).toBe(200);
  return tripId;
}

function requestToJoin(tripId: string, token: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/trips/${tripId}/connection-requests`,
    headers: headers(token),
    payload: {
      message: 'I am free on these dates and would like to join the group.',
    },
  });
}

beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: communitySlug,
      name: 'Trip Integrity Community',
      region: 'Himachal Pradesh',
    },
  });
  await app.ready();

  for (const token of tokens) {
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
            biography: 'Integration profile for trip integrity testing.',
            languages: ['english'],
          },
        },
      },
    });
  }
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({ where: { id: { in: createdTripIds } } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await database.$disconnect();
});

describe('trip integrity rules', () => {
  it('keeps the group size at or above the active member count', async () => {
    const tripId = await createPublishedTrip(4);
    const requested = await requestToJoin(tripId, 'member-token');
    expect(requested.statusCode).toBe(201);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/connection-requests/${requested.json().data.id}/accept`,
      headers: headers('owner-token'),
    });
    expect(accepted.statusCode).toBe(200);

    const before = await database.trip.findUniqueOrThrow({
      where: { id: tripId },
    });
    expect(before.currentGroupSize).toBe(2);

    const shrunk = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${tripId}`,
      headers: headers('owner-token'),
      payload: { expectedVersion: before.version, currentGroupSize: 1 },
    });
    expect(shrunk.statusCode).toBe(409);
    expect(shrunk.json().error.code).toBe('GROUP_SIZE_BELOW_ACTIVE_MEMBERS');

    const unchanged = await database.trip.findUniqueOrThrow({
      where: { id: tripId },
    });
    expect(unchanged).toMatchObject({
      currentGroupSize: 2,
      version: before.version,
    });

    const grown = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${tripId}`,
      headers: headers('owner-token'),
      payload: { expectedVersion: before.version, currentGroupSize: 3 },
    });
    expect(grown.statusCode).toBe(200);
    expect(grown.json().data.group).toMatchObject({ currentSize: 3 });
  });

  it('hides ended trips from discovery and rejects requests to join them', async () => {
    const tripId = await createPublishedTrip(4);
    await database.trip.update({
      where: { id: tripId },
      data: {
        startDate: new Date(`${isoDate(-10)}T00:00:00.000Z`),
        endDate: new Date(`${isoDate(-7)}T00:00:00.000Z`),
        durationDays: 4,
      },
    });

    for (const url of [
      `/api/v1/trips?destination=${communitySlug}`,
      `/api/v1/trips?destination=${communitySlug}&departureFrom=${isoDate(-30)}`,
      `/api/v1/communities/${communitySlug}/trips`,
    ]) {
      const listed = await app.inject({ method: 'GET', url });
      expect(listed.statusCode).toBe(200);
      expect(
        listed.json().data.map((trip: { id: string }) => trip.id),
      ).not.toContain(tripId);
    }

    const requested = await requestToJoin(tripId, 'latecomer-token');
    expect(requested.statusCode).toBe(404);
    expect(requested.json().error.code).toBe('TRIP_NOT_REQUESTABLE');
  });

  it('still lists a trip that is in progress until its end date passes', async () => {
    const tripId = await createPublishedTrip(4);
    await database.trip.update({
      where: { id: tripId },
      data: {
        startDate: new Date(`${isoDate(-2)}T00:00:00.000Z`),
        endDate: new Date(`${isoDate(0)}T00:00:00.000Z`),
        durationDays: 3,
      },
    });

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/trips?destination=${communitySlug}`,
    });
    expect(listed.json().data.map((trip: { id: string }) => trip.id)).toContain(
      tripId,
    );
  });
});
