import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Prisma, type Trip } from '../src/generated/prisma/client.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type {
  TripHistoryQuery,
  TripHistoryRepository,
} from '../src/modules/trips/trip-history.repository.js';
import { tripChanges } from '../src/modules/trips/trip-history.js';

const userId = '70000000-0000-4000-8000-000000000001';
const tripId = '70000000-0000-4000-8000-000000000002';
let status: AuthenticatedUser['status'] = 'ACTIVE';
let found = true;
const calls: Array<{
  tripId: string;
  userId: string;
  query: TripHistoryQuery;
}> = [];
const tokenVerifier: TokenVerifier = {
  async verify(subject) {
    return { subject, emailVerified: false };
  },
};
const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    throw new Error('Unused');
  },
  async findFirebaseUser() {
    return {
      id: userId,
      displayName: 'Reader',
      status,
      birthDate: null,
      profile: null,
      createdAt: new Date(),
    };
  },
};
const repository: TripHistoryRepository = {
  async list(id, reader, query) {
    calls.push({ tripId: id, userId: reader, query });
    return found
      ? {
          data: [],
          currentVersion: 9,
          pagination: { pageSize: query.pageSize, nextBeforeVersion: null },
        }
      : null;
  },
};
const app = buildApp({
  logger: false,
  auth: { tokenVerifier, repository: authRepository },
  tripHistory: repository,
});
const get = (query = '', authorization: string | undefined = 'Bearer reader') =>
  app.inject({
    method: 'GET',
    url: `/api/v1/trips/${tripId}/history${query}`,
    ...(authorization && { headers: { authorization } }),
  });
beforeAll(() => app.ready());
afterAll(() => app.close());
beforeEach(() => {
  calls.length = 0;
  status = 'ACTIVE';
  found = true;
});

describe('trip history contract', () => {
  it('uses the authenticated reader, bounded defaults and private caching', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(calls).toEqual([{ tripId, userId, query: { pageSize: 20 } }]);
    expect(response.json()).toEqual({
      data: [],
      currentVersion: 9,
      pagination: { pageSize: 20, nextBeforeVersion: null },
    });
  });
  it('accepts a version cursor instead of unstable offsets', async () => {
    expect((await get('?pageSize=2&beforeVersion=8')).statusCode).toBe(200);
    expect(calls[0]?.query).toEqual({ pageSize: 2, beforeVersion: 8 });
  });
  it.each([
    '?pageSize=0',
    '?pageSize=101',
    '?pageSize=1.5',
    '?beforeVersion=0',
    '?beforeVersion=2147483648',
    '?beforeVersion=no',
  ])('rejects invalid query %s', async (query) => {
    expect((await get(query)).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/history`,
    });
    expect(response.statusCode).toBe(401);
  });
  it.each(['SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const)(
    'rejects %s accounts before reading',
    async (disabled) => {
      status = disabled;
      expect((await get()).statusCode).toBe(403);
      expect(calls).toEqual([]);
    },
  );
  it('does not distinguish hidden trips from missing ones', async () => {
    found = false;
    const response = await get();
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('TRIP_NOT_FOUND');
  });
});

const trip: Trip = {
  id: tripId,
  ownerId: userId,
  communityId: userId,
  originCity: 'Delhi',
  startDate: new Date('2026-12-01T00:00:00Z'),
  endDate: new Date('2026-12-05T00:00:00Z'),
  dateMode: 'EXACT',
  weekendsOnly: false,
  durationDays: 5,
  flexibilityDays: 0,
  budgetMin: new Prisma.Decimal('1200'),
  budgetMax: null,
  currency: 'INR',
  currentGroupSize: 1,
  desiredGroupSize: 3,
  transport: 'BUS',
  status: 'DRAFT',
  description: 'PRIVATE old contact number',
  version: 1,
  publishedAt: null,
  publishConfirmedAt: null,
  publishConfirmationVersion: null,
  moderationRemovedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
describe('allowlisted structured trip changes', () => {
  it('normalizes dates and decimals without floating-point money', () => {
    expect(
      tripChanges(trip, {
        ...trip,
        startDate: new Date('2026-12-02T00:00:00Z'),
        budgetMin: new Prisma.Decimal('1400.55'),
      }),
    ).toEqual({
      startDate: { before: '2026-12-01', after: '2026-12-02' },
      budgetMin: { before: '1200.00', after: '1400.55' },
    });
  });
  it('records a description marker, never old or new text', () => {
    const changes = tripChanges(trip, {
      ...trip,
      description: 'PRIVATE new email',
    });
    expect(changes).toEqual({ description: { changed: true } });
    expect(JSON.stringify(changes)).not.toContain('PRIVATE');
    expect(JSON.stringify(tripChanges(null, trip))).not.toContain('PRIVATE');
  });
  it('does not create fake changes for version/timestamp or decimal formatting differences', () => {
    const unchanged: Trip = {
      ...trip,
      version: 2,
      updatedAt: new Date(0),
      budgetMin: new Prisma.Decimal('1200.00'),
    };
    expect(tripChanges(trip, unchanged)).toEqual({});
  });
  it('does not copy actor, membership, publication timestamps or private fields', () => {
    const fields = Object.keys(tripChanges(null, trip));
    expect(fields).not.toContain('ownerId');
    expect(fields).not.toContain('publishedAt');
    expect(fields).not.toContain('createdAt');
    expect(
      tripChanges(trip, { ...trip, moderationRemovedAt: new Date() }),
    ).toEqual({ moderationRemoved: { before: false, after: true } });
  });
});
