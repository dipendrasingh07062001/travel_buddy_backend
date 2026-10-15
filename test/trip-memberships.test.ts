import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors/app-error.js';
import { Prisma } from '../src/generated/prisma/client.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type {
  ListTripMembershipsQuery,
  TripMembershipListItem,
  TripMembershipRepository,
} from '../src/modules/trips/trip-membership.types.js';
import type { PublicTripRecord } from '../src/modules/trips/trip.types.js';

const userId = '60000000-0000-4000-8000-000000000001';
const tripId = '60000000-0000-4000-8000-000000000002';
const membershipId = '60000000-0000-4000-8000-000000000003';
let accountStatus: AuthenticatedUser['status'] = 'ACTIVE';
const calls: Array<{ userId: string; query: ListTripMembershipsQuery }> = [];
let items: TripMembershipListItem[] = [];

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    if (token === 'invalid')
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    return { subject: token, emailVerified: false };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    throw new Error('Not used in this suite.');
  },
  async findFirebaseUser(subject) {
    if (subject === 'unknown') return null;
    return {
      id: userId,
      displayName: 'Membership User',
      status: accountStatus,
      birthDate: null,
      profile: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
  },
};

const repository: TripMembershipRepository = {
  async listForUser(requestedUserId, query) {
    calls.push({ userId: requestedUserId, query });
    return { items, totalItems: items.length };
  },
};

const app = buildApp({
  logger: false,
  auth: { tokenVerifier, repository: authRepository },
  tripMemberships: { repository },
});
const headers = { authorization: 'Bearer member' };
const get = (query = '') =>
  app.inject({
    method: 'GET',
    url: `/api/v1/me/trip-memberships${query ? `?${query}` : ''}`,
    headers,
  });

beforeAll(() => app.ready());
beforeEach(() => {
  calls.length = 0;
  items = [];
  accountStatus = 'ACTIVE';
});
afterAll(() => app.close());

function item(status: 'ACTIVE' | 'LEFT' | 'REMOVED'): TripMembershipListItem {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const trip: PublicTripRecord = {
    id: tripId,
    ownerId: userId,
    communityId: '60000000-0000-4000-8000-000000000004',
    originCity: 'Delhi',
    startDate: now,
    endDate: now,
    flexibilityDays: 0,
    durationDays: 1,
    budgetMin: new Prisma.Decimal('1200.50'),
    budgetMax: null,
    currency: 'INR',
    currentGroupSize: 1,
    desiredGroupSize: 3,
    transport: 'BUS',
    description: 'Private trip summary for a current member.',
    status: 'COMPLETED',
    version: 8,
    moderationRemovedAt: null,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    owner: { id: userId, displayName: 'Owner' },
    community: {
      id: '60000000-0000-4000-8000-000000000004',
      slug: 'manali',
      name: 'Manali',
      region: null,
      countryCode: 'IN',
    },
  };
  return {
    membership: {
      id: membershipId,
      tripId,
      role: 'MEMBER',
      status,
      joinedAt: now,
      leftAt: status === 'LEFT' ? now : null,
      removedAt: status === 'REMOVED' ? now : null,
    },
    // Inactive trips are intentionally supplied to check the presenter's guard too.
    trip,
  };
}

describe('own trip membership HTTP contract', () => {
  it('uses the authenticated account and defaults to active memberships', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      { userId, query: { view: 'active', page: 1, pageSize: 20 } },
    ]);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({
      data: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    });
  });

  it('parses the role, trip status and pagination filters', async () => {
    expect(
      (await get('role=MEMBER&tripStatus=COMPLETED&page=2&pageSize=10'))
        .statusCode,
    ).toBe(200);
    expect(calls[0]).toEqual({
      userId,
      query: {
        view: 'active',
        role: 'MEMBER',
        tripStatus: 'COMPLETED',
        page: 2,
        pageSize: 10,
      },
    });
  });

  it.each(['active', 'history', 'all'] as const)(
    'supports the %s view',
    async (view) => {
      expect((await get(`view=${view}&role=OWNER`)).statusCode).toBe(200);
      expect(calls[0]?.query).toMatchObject({ view, role: 'OWNER' });
    },
  );

  it('cannot select someone else by passing userId in the query', async () => {
    expect(
      (await get('userId=60000000-0000-4000-8000-000000000099')).statusCode,
    ).toBe(200);
    expect(calls[0]?.userId).toBe(userId);
    expect(calls[0]?.query).not.toHaveProperty('userId');
  });

  it('presents the active summary without internal owner fields or write metadata', async () => {
    items = [item('ACTIVE')];
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0]).toMatchObject({
      id: membershipId,
      tripId,
      role: 'MEMBER',
      status: 'ACTIVE',
      trip: {
        id: tripId,
        status: 'COMPLETED',
        budget: { minimum: '1200.50', maximum: null, currency: 'INR' },
      },
    });
    expect(response.json().data[0].trip).not.toHaveProperty('ownerId');
    expect(response.json().data[0].trip).not.toHaveProperty('version');
    expect(response.json().data[0]).not.toHaveProperty('connectionRequestId');
  });

  it.each(['LEFT', 'REMOVED'] as const)(
    'redacts fresh trip details for %s memberships',
    async (status) => {
      items = [item(status)];
      const response = await get('view=history');
      expect(response.statusCode).toBe(200);
      expect(response.json().data[0]).toEqual({
        id: membershipId,
        tripId,
        role: 'MEMBER',
        status,
        joinedAt: '2026-01-01T00:00:00.000Z',
        leftAt: status === 'LEFT' ? '2026-01-01T00:00:00.000Z' : null,
        removedAt: status === 'REMOVED' ? '2026-01-01T00:00:00.000Z' : null,
        trip: null,
      });
    },
  );

  it.each([
    'view=unknown',
    'role=ADMIN',
    'tripStatus=UNKNOWN',
    'page=0',
    'page=1.5',
    'pageSize=0',
    'pageSize=101',
    'page=9007199254740992',
    'page=9007199254740991&pageSize=100',
    'view=history&tripStatus=PUBLISHED',
    'view=all&tripStatus=COMPLETED',
  ])('rejects %s before querying memberships', async (query) => {
    expect((await get(query)).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, 'Basic credentials', 'Bearer invalid'])(
    'rejects missing, malformed or invalid authentication: %s',
    async (authorization) => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me/trip-memberships',
        ...(authorization ? { headers: { authorization } } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects an account that has not been bootstrapped', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/trip-memberships',
      headers: { authorization: 'Bearer unknown' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACCOUNT_NOT_PROVISIONED');
    expect(calls).toHaveLength(0);
  });

  it.each(['SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const)(
    'rejects %s accounts',
    async (status) => {
      accountStatus = status;
      expect((await get()).statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    },
  );
});
