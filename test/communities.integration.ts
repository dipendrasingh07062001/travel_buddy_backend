import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';

const explorerId = randomUUID();
const publicAuthorId = randomUUID();
const privateAuthorId = randomUUID();
const activeCommunityId = randomUUID();
const archivedCommunityId = randomUUID();
const publishedTripId = randomUUID();
const draftTripId = randomUUID();
const publicPostId = randomUUID();
const privatePostId = randomUUID();
const removedPostId = randomUUID();
const slug = `integration-community-${activeCommunityId}`;

function authenticatedUser(id: string, displayName: string): AuthenticatedUser {
  return {
    id,
    displayName,
    birthDate: new Date('1994-01-10T00:00:00.000Z'),
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: null,
  };
}

const authUsers: Record<string, AuthenticatedUser> = {
  'explorer-token': authenticatedUser(explorerId, 'Community Explorer'),
};

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: true };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser(identity) {
    return { user: authUsers[identity.subject]!, created: false };
  },
  async findFirebaseUser(subject) {
    return authUsers[subject] ?? null;
  },
};

const app = buildApp({
  logger: false,
  auth: { tokenVerifier, repository: authRepository },
});
const headers = { authorization: 'Bearer explorer-token' };

beforeAll(async () => {
  await database.user.createMany({
    data: [
      { id: explorerId, displayName: 'Community Explorer' },
      { id: publicAuthorId, displayName: 'Public Author' },
      { id: privateAuthorId, displayName: 'Private Author' },
    ],
  });
  await database.userProfile.createMany({
    data: [
      {
        userId: publicAuthorId,
        communityActivityVisibility: 'PUBLIC',
      },
      {
        userId: privateAuthorId,
        communityActivityVisibility: 'PRIVATE',
      },
    ],
  });
  await database.community.createMany({
    data: [
      {
        id: activeCommunityId,
        slug,
        name: 'Integration Community',
        region: 'Himachal Pradesh',
        description:
          'An active destination community used by integration tests.',
      },
      {
        id: archivedCommunityId,
        slug: `archived-${archivedCommunityId}`,
        name: 'Archived Integration Community',
        status: 'ARCHIVED',
      },
    ],
  });
  await database.trip.createMany({
    data: [
      {
        id: publishedTripId,
        ownerId: publicAuthorId,
        communityId: activeCommunityId,
        originCity: 'Delhi',
        startDate: new Date('2027-01-10T00:00:00.000Z'),
        endDate: new Date('2027-01-15T00:00:00.000Z'),
        durationDays: 6,
        budgetMin: 12000,
        budgetMax: 18000,
        desiredGroupSize: 4,
        transport: 'BUS',
        description:
          'Published community integration trip for public browsing.',
        status: 'PUBLISHED',
        publishedAt: new Date('2026-09-20T09:00:00.000Z'),
      },
      {
        id: draftTripId,
        ownerId: publicAuthorId,
        communityId: activeCommunityId,
        originCity: 'Delhi',
        startDate: new Date('2027-02-10T00:00:00.000Z'),
        endDate: new Date('2027-02-15T00:00:00.000Z'),
        durationDays: 6,
        desiredGroupSize: 4,
        description:
          'Private draft that must not appear in community browsing.',
        status: 'DRAFT',
      },
    ],
  });
  await database.communityPost.createMany({
    data: [
      {
        id: publicPostId,
        communityId: activeCommunityId,
        authorId: publicAuthorId,
        type: 'QUESTION',
        status: 'PUBLISHED',
        title: 'Public integration question',
        body: 'This public question should be visible in the community feed.',
        publishedAt: new Date('2026-09-20T10:00:00.000Z'),
      },
      {
        id: privatePostId,
        communityId: activeCommunityId,
        authorId: privateAuthorId,
        type: 'DISCUSSION',
        status: 'PUBLISHED',
        title: 'Private author activity',
        body: 'This post must be hidden by the author privacy preference.',
        publishedAt: new Date('2026-09-20T11:00:00.000Z'),
      },
      {
        id: removedPostId,
        communityId: activeCommunityId,
        authorId: publicAuthorId,
        type: 'EXPERIENCE',
        status: 'REMOVED',
        title: 'Removed integration post',
        body: 'This removed post must not be returned by the public API.',
        publishedAt: new Date('2026-09-20T12:00:00.000Z'),
        removedAt: new Date('2026-09-21T12:00:00.000Z'),
      },
    ],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.communityFollow.deleteMany({
    where: { communityId: { in: [activeCommunityId, archivedCommunityId] } },
  });
  await database.communityPost.deleteMany({
    where: { communityId: { in: [activeCommunityId, archivedCommunityId] } },
  });
  await database.trip.deleteMany({
    where: { id: { in: [publishedTripId, draftTripId] } },
  });
  await database.community.deleteMany({
    where: { id: { in: [activeCommunityId, archivedCommunityId] } },
  });
  await database.userProfile.deleteMany({
    where: { userId: { in: [publicAuthorId, privateAuthorId] } },
  });
  await database.user.deleteMany({
    where: { id: { in: [explorerId, publicAuthorId, privateAuthorId] } },
  });
});

describe('community database integration', () => {
  it('returns active communities with privacy-safe activity counts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/communities?search=${activeCommunityId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0]).toMatchObject({
      id: activeCommunityId,
      activity: { followers: 0, upcomingTrips: 1, posts: 1 },
    });
  });

  it('does not expose archived communities', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/archived-${archivedCommunityId}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('COMMUNITY_NOT_FOUND');
  });

  it('returns only public trips belonging to the community', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug}/trips?origin=Delhi`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((trip: { id: string }) => trip.id)).toEqual(
      [publishedTripId],
    );
  });

  it('returns only published posts allowed by author privacy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug}/posts`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((post: { id: string }) => post.id)).toEqual(
      [publicPostId],
    );
  });

  it('persists idempotent follow and unfollow operations', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const followed = await app.inject({
        method: 'POST',
        url: `/api/v1/communities/${activeCommunityId}/follow`,
        headers,
      });
      expect(followed.statusCode).toBe(200);
    }
    expect(
      await database.communityFollow.count({
        where: { communityId: activeCommunityId, userId: explorerId },
      }),
    ).toBe(1);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/me/followed-communities',
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0].community.id).toBe(activeCommunityId);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const unfollowed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/communities/${activeCommunityId}/follow`,
        headers,
      });
      expect(unfollowed.statusCode).toBe(204);
    }
  });

  it('rejects following an archived community', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${archivedCommunityId}/follow`,
      headers,
    });
    expect(response.statusCode).toBe(404);
  });
});
