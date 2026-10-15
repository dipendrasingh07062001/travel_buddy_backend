import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors/app-error.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
  VerifiedIdentity,
} from '../src/modules/auth/auth.types.js';
import type { ProfileActivityRepository } from '../src/modules/profiles/profile-activity.types.js';
import type { ProfileSignalsRepository } from '../src/modules/profiles/profile-signals.types.js';

const targetId = 'a0000000-0000-4000-8000-000000000001';
const viewerId = 'a0000000-0000-4000-8000-000000000002';
const tripId = 'a0000000-0000-4000-8000-000000000003';
const now = new Date('2026-01-01T00:00:00.000Z');
const community = {
  id: 'a0000000-0000-4000-8000-000000000004',
  slug: 'manali',
  name: 'Manali',
  region: null,
  countryCode: 'IN',
};
const calls: unknown[][] = [];
let missing = false;
let status: AuthenticatedUser['status'] = 'ACTIVE';
const identity: VerifiedIdentity = { subject: 'viewer', emailVerified: false };
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    if (token === 'invalid')
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    return { ...identity, subject: token };
  },
};
const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    throw new Error('Not used.');
  },
  async findFirebaseUser(subject) {
    if (subject === 'unknown') return null;
    return {
      id: viewerId,
      displayName: 'Viewer',
      birthDate: null,
      status,
      profile: null,
      createdAt: now,
    };
  },
};
const activityRepository: ProfileActivityRepository = {
  async listTrips(id, viewer, query) {
    calls.push(['trips', id, viewer, query]);
    return missing
      ? null
      : {
          totalItems: 1,
          items: [
            {
              id: tripId,
              originCity: 'Delhi',
              startDate: now,
              endDate: now,
              durationDays: 1,
              status: 'COMPLETED',
              publishedAt: now,
              community,
            },
          ],
        };
  },
  async listPosts(id, viewer, query) {
    calls.push(['posts', id, viewer, query]);
    return missing
      ? null
      : {
          totalItems: 1,
          items: [
            {
              id: tripId,
              type: 'QUESTION',
              title: 'A public question',
              publishedAt: now,
              community,
            },
          ],
        };
  },
  async listComments(id, viewer, query) {
    calls.push(['comments', id, viewer, query]);
    return missing
      ? null
      : {
          totalItems: 1,
          items: [
            {
              id: tripId,
              createdAt: now,
              editedAt: null,
              post: { id: tripId, title: 'Public discussion', community },
            },
          ],
        };
  },
};
const signalsRepository: ProfileSignalsRepository = {
  async findPublic(id, viewer) {
    calls.push(['signals', id, viewer]);
    return missing ? null : [{ type: 'EMAIL', recordedAt: now }];
  },
  async refresh(id, claims) {
    calls.push(['refresh', id, claims]);
    return [];
  },
};
const app = buildApp({
  logger: false,
  auth: { tokenVerifier, repository: authRepository },
  profileActivity: { repository: activityRepository },
  profileSignals: { repository: signalsRepository },
});
beforeAll(() => app.ready());
afterAll(() => app.close());
beforeEach(() => {
  calls.length = 0;
  missing = false;
  status = 'ACTIVE';
});
const read = (suffix: string, token?: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/users/${targetId}/${suffix}`,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
const refresh = (payload?: object) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/me/verification-signals/refresh?userId=not-the-caller',
    headers: { authorization: 'Bearer viewer' },
    ...(payload && { payload }),
  });

describe('profile activity HTTP contracts', () => {
  it.each(['trips', 'community-posts', 'community-comments'])(
    'allows guests to request visible %s cards',
    async (suffix) => {
      const response = await read(suffix);
      expect(response.statusCode).toBe(200);
      expect(calls[0]?.[1]).toBe(targetId);
      expect(calls[0]?.[2]).toBeUndefined();
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json().pagination).toEqual({
        page: 1,
        pageSize: 20,
        totalItems: 1,
        totalPages: 1,
      });
      expect(response.json().data[0]).not.toHaveProperty('body');
      expect(response.json().data[0]).not.toHaveProperty('memberships');
    },
  );
  it('forwards only the authenticated viewer and validated query options', async () => {
    const response = await read(
      'trips?period=past&page=2&pageSize=5&viewerId=somebody-else',
      'viewer',
    );
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ['trips', targetId, viewerId, { period: 'past', page: 2, pageSize: 5 }],
    ]);
  });
  it('serializes an intentionally minimal trip activity card', async () => {
    const response = await read('trips?period=past');
    expect(Object.keys(response.json().data[0]).sort()).toEqual(
      [
        'id',
        'originCity',
        'destination',
        'startDate',
        'endDate',
        'durationDays',
        'status',
        'publishedAt',
      ].sort(),
    );
    expect(response.json().data[0].startDate).toBe('2026-01-01');
  });
  it.each([
    'trips?period=invalid',
    'trips?page=0',
    'community-posts?pageSize=101',
    'community-comments?page=2.5',
    'trips?page=9007199254740992',
    'community-posts?page=9007199254740991&pageSize=100',
  ])('rejects invalid query %s before repository access', async (query) => {
    expect((await read(query)).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it.each([
    'trips',
    'community-posts',
    'community-comments',
    'verification-signals',
  ])(
    'returns 404 rather than counts for missing/hidden profiles: %s',
    async (suffix) => {
      missing = true;
      expect((await read(suffix)).statusCode).toBe(404);
    },
  );
  it('validates the user UUID', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/users/not-a-uuid/trips',
        })
      ).statusCode,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('does not silently treat an invalid authenticated viewer as a guest', async () => {
    expect((await read('trips', 'invalid')).statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it.each(['SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const)(
    'rejects a %s viewer',
    async (value) => {
      status = value;
      expect((await read('community-comments', 'viewer')).statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    },
  );
});

describe('factual verification signal HTTP contracts', () => {
  it('returns a dated claim explanation, not contacts or a trust score', async () => {
    const response = await read('verification-signals');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.signals).toEqual([
      {
        type: 'EMAIL',
        label: 'Email verification recorded',
        recordedAt: now.toISOString(),
        source: 'FIREBASE_SIGN_IN_CLAIM',
        explanation: expect.stringContaining('verified-email claim'),
        limitations: expect.stringContaining('not'),
      },
    ]);
    expect(response.json().data.notice).toContain('not live identity checks');
    expect(response.json().data).not.toHaveProperty('email');
    expect(response.json().data).not.toHaveProperty('trustScore');
  });
  it('uses the caller and cached verified token claims, never a query userId', async () => {
    expect((await refresh()).statusCode).toBe(200);
    expect(calls).toEqual([
      ['refresh', viewerId, { subject: 'viewer', emailVerified: false }],
    ]);
  });
  it('rejects a client-supplied verification payload', async () => {
    const response = await refresh({
      userId: targetId,
      emailVerified: true,
      phoneNumber: '+919999999999',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VERIFICATION_BODY_NOT_ALLOWED');
    expect(calls).toHaveLength(0);
  });
  it('requires authentication before refreshing', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/me/verification-signals/refresh',
        })
      ).statusCode,
    ).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it('rejects unprovisioned accounts', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/verification-signals/refresh',
      headers: { authorization: 'Bearer unknown' },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
