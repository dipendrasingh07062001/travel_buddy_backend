import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type {
  CommunityFollowRecord,
  CommunityPostRecord,
  CommunityRepository,
  CommunitySummaryRecord,
} from '../src/modules/communities/community.types.js';
import type {
  PublicTripRecord,
  TripRepository,
} from '../src/modules/trips/trip.types.js';

const userId = 'a1000000-0000-4000-8000-000000000001';
const communityId = 'b1000000-0000-4000-8000-000000000001';
const archivedCommunityId = 'b1000000-0000-4000-8000-000000000002';

const currentUser: AuthenticatedUser = {
  id: userId,
  displayName: 'Community Explorer',
  birthDate: new Date('1995-05-10T00:00:00.000Z'),
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  profile: null,
};

const community: CommunitySummaryRecord = {
  id: communityId,
  slug: 'manali',
  name: 'Manali',
  region: 'Himachal Pradesh',
  countryCode: 'IN',
  description: 'Mountain trips and destination discussions.',
  followerCount: 2,
  upcomingTripCount: 1,
  postCount: 1,
};

const post: CommunityPostRecord = {
  id: 'c1000000-0000-4000-8000-000000000001',
  communityId,
  type: 'QUESTION',
  title: 'Local transport options',
  body: 'What are the practical transport options around Manali?',
  author: { id: userId, displayName: currentUser.displayName },
  publishedAt: new Date('2026-09-20T08:00:00.000Z'),
  createdAt: new Date('2026-09-20T07:00:00.000Z'),
  updatedAt: new Date('2026-09-20T08:00:00.000Z'),
};

const publicTrip: PublicTripRecord = {
  id: 'd1000000-0000-4000-8000-000000000001',
  ownerId: userId,
  communityId,
  originCity: 'Delhi',
  startDate: new Date('2027-01-10T00:00:00.000Z'),
  endDate: new Date('2027-01-15T00:00:00.000Z'),
  flexibilityDays: 2,
  durationDays: 6,
  budgetMin: new Prisma.Decimal(12000),
  budgetMax: new Prisma.Decimal(18000),
  currency: 'INR',
  currentGroupSize: 2,
  desiredGroupSize: 5,
  transport: 'BUS',
  description: 'A complete public trip description for Manali.',
  status: 'PUBLISHED',
  version: 1,
  publishedAt: new Date('2026-09-20T08:00:00.000Z'),
  createdAt: new Date('2026-09-20T07:00:00.000Z'),
  updatedAt: new Date('2026-09-20T08:00:00.000Z'),
  owner: { id: userId, displayName: currentUser.displayName },
  community: {
    id: communityId,
    slug: 'manali',
    name: 'Manali',
    region: 'Himachal Pradesh',
    countryCode: 'IN',
  },
};

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: true };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    return { user: currentUser, created: false };
  },
  async findFirebaseUser(subject) {
    return subject === 'user-token' ? currentUser : null;
  },
};

const follows = new Map<string, CommunityFollowRecord>();

const communityRepository: CommunityRepository = {
  async listActive(query) {
    const matches = !query.search || community.name.includes(query.search);
    return {
      communities: matches ? [community] : [],
      totalItems: matches ? 1 : 0,
    };
  },
  async findActiveBySlug(slug) {
    return slug === community.slug ? community : null;
  },
  async listPublishedPosts(_id, query) {
    const posts = !query.type || query.type === post.type ? [post] : [];
    return { posts, totalItems: posts.length };
  },
  async follow(id, idOfCommunity) {
    if (idOfCommunity !== communityId) return null;
    const key = `${idOfCommunity}:${id}`;
    const existing = follows.get(key);
    if (existing) return existing;
    const record = {
      communityId: idOfCommunity,
      userId: id,
      followedAt: new Date('2026-09-22T09:00:00.000Z'),
    };
    follows.set(key, record);
    return record;
  },
  async unfollow(id, idOfCommunity) {
    if (idOfCommunity === archivedCommunityId) return null;
    return follows.delete(`${idOfCommunity}:${id}`);
  },
  async listFollowed(id) {
    const matching = [...follows.values()].filter((item) => item.userId === id);
    return {
      follows: matching.map((item) => ({
        followedAt: item.followedAt,
        community,
      })),
      totalItems: matching.length,
    };
  },
};

let capturedTripQuery: Parameters<TripRepository['listPublic']>[0] | undefined;
const tripRepository: TripRepository = {
  async listPublic(query) {
    capturedTripQuery = query;
    return { trips: [publicTrip], totalItems: 1 };
  },
  async findPublicById() {
    return null;
  },
};

const app = buildApp({
  logger: false,
  health: { checkReadiness: async () => undefined },
  auth: { tokenVerifier, repository: authRepository },
  communities: { repository: communityRepository, tripRepository },
});

const headers = { authorization: 'Bearer user-token' };

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe('community HTTP contract', () => {
  it('allows guests to browse and search active communities', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/communities?search=Manali&page=1&pageSize=10',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0]).toMatchObject({
      id: communityId,
      slug: 'manali',
      activity: { followers: 2, upcomingTrips: 1, posts: 1 },
    });
    expect(response.json().pagination.totalItems).toBe(1);
  });

  it('returns a stable not-found error for unknown communities', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/communities/unknown-place',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('COMMUNITY_NOT_FOUND');
  });

  it('scopes public trip filters to the requested community', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/communities/MANALI/trips?origin=Delhi&transport=BUS&sort=departure_asc',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].destination.slug).toBe('manali');
    expect(capturedTripQuery).toMatchObject({
      destination: 'manali',
      origin: 'Delhi',
      transport: 'BUS',
      sort: 'departure_asc',
    });
  });

  it('validates community trip ranges before querying the database', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/communities/manali/trips?minBudget=20000&maxBudget=10000',
    });
    expect(response.statusCode).toBe(400);
  });

  it('filters public community posts by their declared type', async () => {
    const matching = await app.inject({
      method: 'GET',
      url: '/api/v1/communities/manali/posts?type=QUESTION',
    });
    const empty = await app.inject({
      method: 'GET',
      url: '/api/v1/communities/manali/posts?type=EXPERIENCE',
    });
    expect(matching.statusCode).toBe(200);
    expect(matching.json().data[0]).toMatchObject({
      id: post.id,
      type: 'QUESTION',
      author: { id: userId },
    });
    expect(empty.json().data).toEqual([]);
  });

  it('requires authentication and follows idempotently', async () => {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/follow`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const followed = await app.inject({
        method: 'POST',
        url: `/api/v1/communities/${communityId}/follow`,
        headers,
      });
      expect(followed.statusCode).toBe(200);
      expect(followed.json().data.following).toBe(true);
    }

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/me/followed-communities',
      headers,
    });
    expect(list.json().data).toHaveLength(1);
  });

  it('unfollows idempotently and hides archived communities', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/communities/${communityId}/follow`,
        headers,
      });
      expect(response.statusCode).toBe(204);
    }
    const archived = await app.inject({
      method: 'DELETE',
      url: `/api/v1/communities/${archivedCommunityId}/follow`,
      headers,
    });
    expect(archived.statusCode).toBe(404);

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${randomUUID()}/follow`,
      headers,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('COMMUNITY_NOT_FOUND');
  });
});
