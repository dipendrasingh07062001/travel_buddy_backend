import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { Prisma, type TripStatus } from '../src/generated/prisma/client.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type { TripManagementRepository } from '../src/modules/trips/trip-management.types.js';
import type { PublicTripRecord } from '../src/modules/trips/trip.types.js';

const ownerId = '60000000-0000-4000-8000-000000000001';
const otherUserId = '60000000-0000-4000-8000-000000000002';
const communityId = '70000000-0000-4000-8000-000000000001';
const trips = new Map<string, PublicTripRecord>();

let ownerProfileComplete = true;

function user(id: string): AuthenticatedUser {
  const complete = id === ownerId && ownerProfileComplete;
  return {
    id,
    displayName: id === ownerId ? 'Trip Owner' : 'Other User',
    birthDate: complete ? new Date('1995-05-20T00:00:00.000Z') : null,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: complete
      ? {
          profilePhotoStorageKey: null,
          homeCity: 'Delhi',
          homeRegion: 'Delhi NCR',
          biography: 'Weekend trekker who organises small group trips.',
          languages: ['english', 'hindi'],
          travelInterests: ['trekking'],
          pastTripsVisibility: 'MEMBERS_ONLY',
          communityActivityVisibility: 'PUBLIC',
        }
      : null,
  };
}

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: false };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser(identity) {
    return {
      user: user(identity.subject === 'owner-token' ? ownerId : otherUserId),
      created: false,
    };
  },
  async findFirebaseUser(subject) {
    return user(subject === 'owner-token' ? ownerId : otherUserId);
  },
};

const managementRepository: TripManagementRepository = {
  async isActiveCommunity(id) {
    return id === communityId;
  },
  async create(input) {
    const now = new Date();
    const trip: PublicTripRecord = {
      id: randomUUID(),
      ...input,
      budgetMin:
        input.budgetMin === null ? null : new Prisma.Decimal(input.budgetMin),
      budgetMax:
        input.budgetMax === null ? null : new Prisma.Decimal(input.budgetMax),
      status: 'DRAFT',
      version: 1,
      publishedAt: null,
      publishConfirmedAt: null,
      publishConfirmationVersion: null,
      moderationRemovedAt: null,
      createdAt: now,
      updatedAt: now,
      owner: { id: input.ownerId, displayName: 'Trip Owner' },
      community: {
        id: communityId,
        slug: 'manali',
        name: 'Manali',
        region: 'Himachal Pradesh',
        countryCode: 'IN',
      },
    };
    trips.set(trip.id, trip);
    return trip;
  },
  async listOwned(requestedOwnerId, query) {
    const matches = [...trips.values()].filter(
      (trip) =>
        trip.ownerId === requestedOwnerId &&
        (!query.status || trip.status === query.status),
    );
    return {
      trips: matches.slice(
        (query.page - 1) * query.pageSize,
        query.page * query.pageSize,
      ),
      totalItems: matches.length,
    };
  },
  async findById(id) {
    return trips.get(id) ?? null;
  },
  async updateOwned(id, requestedOwnerId, expectedVersion, statuses, data) {
    const trip = trips.get(id);
    if (
      !trip ||
      trip.ownerId !== requestedOwnerId ||
      trip.version !== expectedVersion ||
      !statuses.includes(trip.status)
    ) {
      return null;
    }
    const next = {
      ...trip,
      ...data,
      version: trip.version + 1,
      updatedAt: new Date(),
    } as PublicTripRecord;
    trips.set(id, next);
    return next;
  },
};

const app = buildApp({
  logger: false,
  health: { checkReadiness: async () => undefined },
  auth: { tokenVerifier, repository: authRepository },
  trips: { managementRepository },
});

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe('authenticated trip management HTTP contract', () => {
  let tripId: string;

  it('requires authentication before creating a trip', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/trips',
      payload: {
        communityId,
        originCity: 'Delhi',
        startDate: '2027-01-10',
        endDate: '2027-01-15',
        desiredGroupSize: 5,
        description: 'A sufficiently detailed private draft trip description.',
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('creates a private draft and derives its duration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/trips',
      headers: { authorization: 'Bearer owner-token' },
      payload: {
        communityId,
        originCity: ' Delhi ',
        startDate: '2027-01-10',
        endDate: '2027-01-15',
        budgetMin: 10000,
        budgetMax: 18000,
        desiredGroupSize: 5,
        transport: 'BUS',
        description: 'A relaxed six-day mountain trip with new travel friends.',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      originCity: 'Delhi',
      durationDays: 6,
      status: 'DRAFT',
      version: 1,
      owner: { id: ownerId },
    });
    tripId = response.json().data.id;
  });

  it('lists only the authenticated owner trips', async () => {
    const owner = await app.inject({
      method: 'GET',
      url: '/api/v1/me/trips?status=DRAFT',
      headers: { authorization: 'Bearer owner-token' },
    });
    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/me/trips',
      headers: { authorization: 'Bearer other-token' },
    });

    expect(owner.statusCode).toBe(200);
    expect(owner.json().data).toHaveLength(1);
    expect(other.json().data).toHaveLength(0);
  });

  it('edits atomically and rejects a stale version', async () => {
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${tripId}`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 1, desiredGroupSize: 6 },
    });
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${tripId}`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 1, desiredGroupSize: 7 },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({
      group: { desiredSize: 6 },
      version: 2,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('TRIP_VERSION_CONFLICT');
  });

  it('forbids a different user from changing the trip', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: { authorization: 'Bearer other-token' },
      payload: { expectedVersion: 2, confirmsPersonalPlan: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('TRIP_FORBIDDEN');
  });

  it('requires a complete adult profile before publishing', async () => {
    ownerProfileComplete = false;
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/trips/${tripId}/publish`,
        headers: { authorization: 'Bearer owner-token' },
        payload: { expectedVersion: 2, confirmsPersonalPlan: true },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('PROFILE_INCOMPLETE');
    } finally {
      ownerProfileComplete = true;
    }
  });

  it('refuses to publish until the owner confirms the plan', async () => {
    for (const payload of [
      { expectedVersion: 2 },
      { expectedVersion: 2, confirmsPersonalPlan: false },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/trips/${tripId}/publish`,
        headers: { authorization: 'Bearer owner-token' },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('PUBLISH_CONFIRMATION_REQUIRED');
    }
    expect(trips.get(tripId)).toMatchObject({
      status: 'DRAFT',
      version: 2,
      publishConfirmedAt: null,
    });
  });

  it('publishes through the lifecycle command and rejects an invalid repeat', async () => {
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 2, confirmsPersonalPlan: true },
    });
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 3, confirmsPersonalPlan: true },
    });

    expect(published.statusCode).toBe(200);
    expect(published.json().data).toMatchObject({
      status: 'PUBLISHED' satisfies TripStatus,
      version: 3,
    });
    expect(published.json().data.publishedAt).toBeTruthy();
    expect(published.json().data.publishConfirmation).toEqual({
      confirmedAt: published.json().data.publishedAt,
      version: '2026-10-27',
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe('INVALID_TRIP_STATE');
  });

  it('enforces pause, republish, full, completion-date, and cancellation rules', async () => {
    const pause = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/pause`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 3 },
    });
    const firstConfirmation = trips.get(tripId)!.publishConfirmedAt!;
    // A paused plan may have been edited, so republishing asks again.
    const unconfirmedRepublish = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 4 },
    });
    const republish = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 4, confirmsPersonalPlan: true },
    });
    const markFull = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/mark-full`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 5 },
    });
    const completeEarly = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/complete`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 6 },
    });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/cancel`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 6 },
    });

    expect(pause.json().data).toMatchObject({ status: 'PAUSED', version: 4 });
    expect(unconfirmedRepublish.json().error.code).toBe(
      'PUBLISH_CONFIRMATION_REQUIRED',
    );
    expect(republish.json().data).toMatchObject({
      status: 'PUBLISHED',
      version: 5,
    });
    expect(
      Date.parse(republish.json().data.publishConfirmation.confirmedAt),
    ).toBeGreaterThanOrEqual(firstConfirmation.getTime());
    // Pause, mark-full and cancel above needed no confirmation.
    expect(markFull.json().data).toMatchObject({ status: 'FULL', version: 6 });
    expect(completeEarly.statusCode).toBe(409);
    expect(completeEarly.json().error.code).toBe('INVALID_TRIP_STATE');
    expect(cancel.json().data).toMatchObject({
      status: 'CANCELLED',
      version: 7,
    });
  });
});

describe('trip date windows', () => {
  const headers = { authorization: 'Bearer owner-token' };
  const basePayload = {
    communityId,
    originCity: 'Delhi',
    desiredGroupSize: 4,
    description: 'A flexible group trip to the hills with relaxed plans.',
  };

  async function createTrip(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/trips',
      headers,
      payload: { ...basePayload, ...payload },
    });
  }

  async function editTrip(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${id}`,
      headers,
      payload: { expectedVersion: trips.get(id)!.version, ...payload },
    });
  }

  it('keeps exact dates as the default', async () => {
    const response = await createTrip({
      startDate: '2027-05-10',
      endDate: '2027-05-12',
      flexibilityDays: 1,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      dateMode: 'EXACT',
      weekendsOnly: false,
      flexibilityDays: 1,
      durationDays: 3,
    });
  });

  it('stores the entered length of a trip inside a month window', async () => {
    const response = await createTrip({
      startDate: '2027-12-01',
      endDate: '2027-12-31',
      dateMode: 'WINDOW',
      durationDays: 3,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      startDate: '2027-12-01',
      endDate: '2027-12-31',
      dateMode: 'WINDOW',
      weekendsOnly: false,
      flexibilityDays: 0,
      durationDays: 3,
    });
  });

  it('accepts a weekend window of up to four days', async () => {
    const response = await createTrip({
      startDate: '2027-03-01',
      endDate: '2027-03-31',
      dateMode: 'WINDOW',
      weekendsOnly: true,
      durationDays: 4,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      dateMode: 'WINDOW',
      weekendsOnly: true,
      durationDays: 4,
    });
  });

  // 1 March 2027 is a Monday and 5 March a Friday.
  it.each([
    [
      'a window without a length',
      { startDate: '2027-12-01', endDate: '2027-12-31', dateMode: 'WINDOW' },
      'durationDays is required for a date window.',
    ],
    [
      'a length longer than the window',
      {
        startDate: '2027-12-01',
        endDate: '2027-12-03',
        dateMode: 'WINDOW',
        durationDays: 5,
      },
      'durationDays must fit inside the date window.',
    ],
    [
      'a window over 92 days',
      {
        startDate: '2027-01-01',
        endDate: '2027-04-30',
        dateMode: 'WINDOW',
        durationDays: 3,
      },
      'A date window cannot exceed 92 days.',
    ],
    [
      'day flexibility on a window',
      {
        startDate: '2027-12-01',
        endDate: '2027-12-31',
        dateMode: 'WINDOW',
        durationDays: 3,
        flexibilityDays: 2,
      },
      'A date window already allows flexibility, so flexibilityDays must be 0.',
    ],
    [
      'a weekend trip longer than four days',
      {
        startDate: '2027-03-01',
        endDate: '2027-03-31',
        dateMode: 'WINDOW',
        weekendsOnly: true,
        durationDays: 5,
      },
      'A weekend trip can last at most 4 days.',
    ],
    [
      'a weekend window without a Saturday or Sunday',
      {
        startDate: '2027-03-01',
        endDate: '2027-03-05',
        dateMode: 'WINDOW',
        weekendsOnly: true,
        durationDays: 2,
      },
      'A weekend window must include a Saturday or Sunday.',
    ],
    [
      'weekends only on exact dates',
      { startDate: '2027-03-06', endDate: '2027-03-07', weekendsOnly: true },
      'weekendsOnly applies only to a date window.',
    ],
    [
      'a length on exact dates',
      { startDate: '2027-03-06', endDate: '2027-03-07', durationDays: 2 },
      'durationDays is calculated from the dates of an exact trip.',
    ],
  ])('rejects %s', async (_case, payload, message) => {
    const response = await createTrip(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'INVALID_TRIP_DATES',
      message,
    });
  });

  it('rejects an unknown date type', async () => {
    const response = await createTrip({
      startDate: '2027-12-01',
      endDate: '2027-12-31',
      dateMode: 'MONTH',
      durationDays: 3,
    });
    expect(response.statusCode).toBe(400);
  });

  it('switches exact dates to a window and drops day flexibility', async () => {
    const created = await createTrip({
      startDate: '2027-06-01',
      endDate: '2027-06-20',
      flexibilityDays: 2,
    });
    const id = created.json().data.id;

    const withoutLength = await editTrip(id, { dateMode: 'WINDOW' });
    expect(withoutLength.statusCode).toBe(400);
    expect(withoutLength.json().error.message).toBe(
      'durationDays is required for a date window.',
    );

    const switched = await editTrip(id, {
      dateMode: 'WINDOW',
      durationDays: 4,
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().data).toMatchObject({
      startDate: '2027-06-01',
      endDate: '2027-06-20',
      dateMode: 'WINDOW',
      flexibilityDays: 0,
      durationDays: 4,
    });
  });

  it('keeps a window length when only the dates move', async () => {
    const created = await createTrip({
      startDate: '2027-12-01',
      endDate: '2027-12-31',
      dateMode: 'WINDOW',
      durationDays: 5,
    });
    const id = created.json().data.id;

    const moved = await editTrip(id, {
      startDate: '2027-11-15',
      endDate: '2027-12-15',
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().data).toMatchObject({
      startDate: '2027-11-15',
      endDate: '2027-12-15',
      dateMode: 'WINDOW',
      durationDays: 5,
    });

    const tooShort = await editTrip(id, { endDate: '2027-11-17' });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json().error.message).toBe(
      'durationDays must fit inside the date window.',
    );
  });

  it('switches a weekend window back to exact dates', async () => {
    const created = await createTrip({
      startDate: '2027-03-01',
      endDate: '2027-03-31',
      dateMode: 'WINDOW',
      weekendsOnly: true,
      durationDays: 2,
    });
    const id = created.json().data.id;

    const exact = await editTrip(id, {
      dateMode: 'EXACT',
      startDate: '2027-03-06',
      endDate: '2027-03-07',
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json().data).toMatchObject({
      dateMode: 'EXACT',
      weekendsOnly: false,
      flexibilityDays: 0,
      durationDays: 2,
    });
  });

  it('leaves the date plan alone when other fields change', async () => {
    const created = await createTrip({
      startDate: '2027-12-01',
      endDate: '2027-12-31',
      dateMode: 'WINDOW',
      durationDays: 3,
    });
    const id = created.json().data.id;

    const edited = await editTrip(id, { desiredGroupSize: 6 });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data).toMatchObject({
      dateMode: 'WINDOW',
      durationDays: 3,
      group: { desiredSize: 6 },
    });
  });
});
