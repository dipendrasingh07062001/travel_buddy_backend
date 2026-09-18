import { randomUUID } from 'node:crypto';

import { Prisma, type TripStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
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

function user(id: string): AuthenticatedUser {
  return {
    id,
    displayName: id === ownerId ? 'Trip Owner' : 'Other User',
    birthDate: null,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: null,
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
      payload: { expectedVersion: 2 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('TRIP_FORBIDDEN');
  });

  it('publishes through the lifecycle command and rejects an invalid repeat', async () => {
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 2 },
    });
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 3 },
    });

    expect(published.statusCode).toBe(200);
    expect(published.json().data).toMatchObject({
      status: 'PUBLISHED' satisfies TripStatus,
      version: 3,
    });
    expect(published.json().data.publishedAt).toBeTruthy();
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
    const republish = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedVersion: 4 },
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
    expect(republish.json().data).toMatchObject({
      status: 'PUBLISHED',
      version: 5,
    });
    expect(markFull.json().data).toMatchObject({ status: 'FULL', version: 6 });
    expect(completeEarly.statusCode).toBe(409);
    expect(completeEarly.json().error.code).toBe('INVALID_TRIP_STATE');
    expect(cancel.json().data).toMatchObject({
      status: 'CANCELLED',
      version: 7,
    });
  });
});
