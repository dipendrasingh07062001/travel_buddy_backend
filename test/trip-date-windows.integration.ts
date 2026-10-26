import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import { utcStartOfToday } from '../src/modules/trips/trip.types.js';

const ownerId = randomUUID();
const memberId = randomUUID();
const communityId = randomUUID();
const slug = `date-windows-${communityId}`;
const today = utcStartOfToday();
const day = 86_400_000;
const date = (offset: number) => new Date(today.getTime() + offset * day);
const iso = (offset: number) => date(offset).toISOString().slice(0, 10);

const owner: AuthenticatedUser = {
  id: ownerId,
  displayName: 'Window Owner',
  birthDate: new Date('1994-01-10T00:00:00.000Z'),
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  profile: null,
};

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: true };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    return { user: owner, created: false };
  },
  async findFirebaseUser(subject) {
    return subject === 'owner-token' ? owner : null;
  },
};

const app = buildApp({
  logger: false,
  auth: { tokenVerifier, repository: authRepository },
});
const headers = { authorization: 'Bearer owner-token' };

function tripData(
  start: number,
  end: number,
  overrides: Partial<Prisma.TripUncheckedCreateInput> = {},
): Prisma.TripUncheckedCreateInput {
  return {
    id: randomUUID(),
    ownerId,
    communityId,
    originCity: 'Delhi',
    startDate: date(start),
    endDate: date(end),
    durationDays: end - start + 1,
    desiredGroupSize: 4,
    description: 'Date window integration fixture trip.',
    status: 'PUBLISHED',
    publishedAt: date(-1),
    ...overrides,
  };
}

async function searchIds(query: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/trips?destination=${slug}&pageSize=100&${query}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json().data.map((trip: { id: string }) => trip.id);
}

const search = { from: iso(30), to: iso(34) };
const fixtures = {
  // Shares 4 of the 5 searched days.
  exact: tripData(30, 33),
  // A 31-day window holding a 3-day trip: shares 5 range days, capped at 3.
  window: tripData(20, 50, { dateMode: 'WINDOW', durationDays: 3 }),
  // A window that does not overlap the searched days.
  laterWindow: tripData(60, 80, { dateMode: 'WINDOW', durationDays: 3 }),
};

beforeAll(async () => {
  await database.user.createMany({
    data: [
      { id: ownerId, displayName: 'Window Owner' },
      { id: memberId, displayName: 'Window Member' },
    ],
  });
  await database.community.create({
    data: { id: communityId, slug, name: `Date Windows ${communityId}` },
  });
  await database.trip.createMany({ data: Object.values(fixtures) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const trips = await database.trip.findMany({
    where: { communityId },
    select: { id: true },
  });
  const tripIds = trips.map((trip) => trip.id);
  await database.notification.deleteMany({
    where: { tripId: { in: tripIds } },
  });
  await database.tripChange.deleteMany({ where: { tripId: { in: tripIds } } });
  await database.tripMembership.deleteMany({
    where: { tripId: { in: tripIds } },
  });
  await database.trip.deleteMany({ where: { communityId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({
    where: { id: { in: [ownerId, memberId] } },
  });
});

describe('trip date windows in the database', () => {
  it('stores a window created through the API', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/trips',
      headers,
      payload: {
        communityId,
        originCity: 'Delhi',
        startDate: iso(100),
        endDate: iso(130),
        dateMode: 'WINDOW',
        durationDays: 3,
        desiredGroupSize: 4,
        description: 'Any three days in this window suits our small group.',
      },
    });
    expect(response.statusCode).toBe(201);
    const stored = await database.trip.findUniqueOrThrow({
      where: { id: response.json().data.id },
      select: {
        dateMode: true,
        weekendsOnly: true,
        flexibilityDays: true,
        durationDays: true,
      },
    });
    expect(stored).toEqual({
      dateMode: 'WINDOW',
      weekendsOnly: false,
      flexibilityDays: 0,
      durationDays: 3,
    });
  });

  it.each([
    ['an exact trip whose length differs from its dates', { durationDays: 2 }],
    ['weekends only on exact dates', { weekendsOnly: true }],
    [
      'a window longer than its range',
      { dateMode: 'WINDOW' as const, durationDays: 40 },
    ],
    [
      'day flexibility on a window',
      { dateMode: 'WINDOW' as const, durationDays: 3, flexibilityDays: 2 },
    ],
  ])('rejects %s with a database rule', async (_case, overrides) => {
    await expect(
      database.trip.create({ data: tripData(200, 230, overrides) }),
    ).rejects.toThrow(/trips_date_mode_check/);
  });

  it('rejects windows over 92 days and impossible weekend windows', async () => {
    await expect(
      database.trip.create({
        data: tripData(200, 300, { dateMode: 'WINDOW', durationDays: 3 }),
      }),
    ).rejects.toThrow(/trips_date_mode_check/);
    // 1 March 2027 is a Monday and 5 March a Friday.
    await expect(
      database.trip.create({
        data: {
          ...tripData(0, 0, {
            dateMode: 'WINDOW',
            weekendsOnly: true,
            durationDays: 2,
          }),
          startDate: new Date('2027-03-01T00:00:00.000Z'),
          endDate: new Date('2027-03-05T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/trips_date_mode_check/);
  });
});

describe('trip date windows in search', () => {
  it('finds a window that overlaps the searched days', async () => {
    const ids = await searchIds(
      `departureFrom=${search.from}&departureTo=${search.to}`,
    );
    expect(ids).toContain(fixtures.exact.id);
    expect(ids).toContain(fixtures.window.id);
    expect(ids).not.toContain(fixtures.laterWindow.id);
  });

  it('filters by the entered trip length, not the window size', async () => {
    const short = await searchIds('maxDuration=3');
    expect(short).toContain(fixtures.window.id);
    expect(short).not.toContain(fixtures.exact.id);
    const long = await searchIds('minDuration=10');
    expect(long).not.toContain(fixtures.window.id);
  });

  it('caps shared days at the trip length when sorting by overlap', async () => {
    const ids = await searchIds(
      `departureFrom=${search.from}&departureTo=${search.to}&sort=date_overlap`,
    );
    expect(ids.indexOf(fixtures.exact.id)).toBeLessThan(
      ids.indexOf(fixtures.window.id),
    );
  });
});

describe('trip date window changes', () => {
  it('records the change and notifies members when only the length changes', async () => {
    const trip = await database.trip.create({
      data: tripData(140, 160, {
        dateMode: 'WINDOW',
        durationDays: 3,
        status: 'DRAFT',
        publishedAt: null,
      }),
    });
    await database.tripMembership.createMany({
      data: [
        { tripId: trip.id, userId: ownerId, role: 'OWNER' },
        { tripId: trip.id, userId: memberId, role: 'MEMBER' },
      ],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${trip.id}`,
      headers,
      payload: { expectedVersion: 1, durationDays: 4 },
    });
    expect(response.statusCode).toBe(200);

    const change = await database.tripChange.findFirstOrThrow({
      where: { tripId: trip.id, version: 2 },
    });
    expect(change.changes).toMatchObject({
      durationDays: { before: 3, after: 4 },
    });
    expect(
      await database.notification.count({
        where: { tripId: trip.id, recipientId: memberId, type: 'TRIP_UPDATED' },
      }),
    ).toBe(1);

    const exact = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${trip.id}`,
      headers,
      payload: { expectedVersion: 2, dateMode: 'EXACT' },
    });
    expect(exact.statusCode).toBe(200);
    const switched = await database.tripChange.findFirstOrThrow({
      where: { tripId: trip.id, version: 3 },
    });
    expect(switched.changes).toMatchObject({
      dateMode: { before: 'WINDOW', after: 'EXACT' },
      durationDays: { before: 4, after: 21 },
    });
  });
});
