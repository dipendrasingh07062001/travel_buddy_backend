import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import { hiddenPublicText } from '../src/privacy/public-text.js';

// The integration database is shared, so every fixture carries this run token
// and posts use far-future publication times to sort ahead of other data.
const run = randomUUID();

const viewerId = randomUUID();
const authorId = randomUUID();
const privateAuthorId = randomUUID();
const suspendedAuthorId = randomUUID();
const deletedAuthorId = randomUUID();
const blockedByViewerId = randomUUID();
const viewerBlockerId = randomUUID();
const userIds = [
  viewerId,
  authorId,
  privateAuthorId,
  suspendedAuthorId,
  deletedAuthorId,
  blockedByViewerId,
  viewerBlockerId,
];

const community = {
  alpha: { id: randomUUID(), slug: `discovery-${run}-alpha` },
  beta: { id: randomUUID(), slug: `discovery-${run}-beta` },
  delta: { id: randomUUID(), slug: `discovery-${run}-delta` },
  epsilon: { id: randomUUID(), slug: `discovery-${run}-epsilon` },
  gamma: { id: randomUUID(), slug: `discovery-${run}-gamma` },
  archived: { id: randomUUID(), slug: `discovery-${run}-archived` },
  mergedBeta: { id: randomUUID(), slug: `discovery-${run}-old-beta` },
};
const communityIds = Object.values(community).map((item) => item.id);

const post = {
  alphaDiscussion: randomUUID(),
  betaExperience: randomUUID(),
  alphaPhoneQuestion: randomUUID(),
  archivedCommunity: randomUUID(),
  privateAuthor: randomUUID(),
  suspendedAuthor: randomUUID(),
  deletedAuthor: randomUUID(),
  removed: randomUUID(),
  draft: randomUUID(),
  blockedByViewer: randomUUID(),
  viewerBlocker: randomUUID(),
};
const fixturePostIds = new Set<string>(Object.values(post));

function authenticatedUser(id: string): AuthenticatedUser {
  return {
    id,
    displayName: 'Discovery Viewer',
    birthDate: new Date('1994-01-10T00:00:00.000Z'),
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: null,
  };
}

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: true };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    return { user: authenticatedUser(viewerId), created: false };
  },
  async findFirebaseUser(subject) {
    return subject === 'viewer-token' ? authenticatedUser(viewerId) : null;
  },
};

const app = buildApp({
  logger: false,
  auth: { tokenVerifier, repository: authRepository },
});
const viewerHeaders = { authorization: 'Bearer viewer-token' };

function publishedAt(hour: number) {
  return new Date(Date.UTC(2100, 0, 1, hour));
}

function postFixture(
  id: string,
  communityId: string,
  author: string,
  hour: number,
  overrides: Partial<{
    type: 'DISCUSSION' | 'QUESTION' | 'EXPERIENCE';
    status: 'DRAFT' | 'PUBLISHED' | 'REMOVED';
    title: string;
    removedAt: Date;
  }> = {},
) {
  const status = overrides.status ?? 'PUBLISHED';
  return {
    id,
    communityId,
    authorId: author,
    type: overrides.type ?? 'DISCUSSION',
    status,
    title: overrides.title ?? `Discovery post ${id}`,
    body: 'A public destination post used by discovery integration tests.',
    publishedAt: status === 'DRAFT' ? null : publishedAt(hour),
    removedAt: overrides.removedAt ?? null,
  };
}

function tripFixture(
  communityId: string,
  status: 'DRAFT' | 'PUBLISHED' | 'FULL' = 'PUBLISHED',
) {
  return {
    id: randomUUID(),
    ownerId: authorId,
    communityId,
    originCity: 'Delhi',
    startDate: new Date('2099-03-01T00:00:00.000Z'),
    endDate: new Date('2099-03-05T00:00:00.000Z'),
    durationDays: 5,
    desiredGroupSize: 4,
    description: 'Upcoming public trip used by community discovery tests.',
    status,
    publishedAt: status === 'DRAFT' ? null : new Date('2026-10-01T00:00:00Z'),
  };
}

async function listRecentPosts(query = '', headers = {}) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/community-posts?pageSize=100${query}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response;
}

function fixtureIds(response: { json(): { data: { id: string }[] } }) {
  return response
    .json()
    .data.map((item) => item.id)
    .filter((id) => fixturePostIds.has(id));
}

beforeAll(async () => {
  await database.user.createMany({
    data: [
      { id: viewerId, displayName: 'Discovery Viewer' },
      { id: authorId, displayName: 'Discovery Author' },
      { id: privateAuthorId, displayName: 'Private Author' },
      {
        id: suspendedAuthorId,
        displayName: 'Suspended Author',
        status: 'SUSPENDED',
      },
      {
        id: deletedAuthorId,
        displayName: 'Deleted Author',
        status: 'DELETED',
        deletedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
      { id: blockedByViewerId, displayName: 'Blocked By Viewer' },
      { id: viewerBlockerId, displayName: 'Viewer Blocker' },
    ],
  });
  await database.userProfile.createMany({
    data: [
      { userId: authorId, communityActivityVisibility: 'PUBLIC' },
      { userId: privateAuthorId, communityActivityVisibility: 'PRIVATE' },
    ],
  });
  await database.userBlock.createMany({
    data: [
      { blockerId: viewerId, blockedId: blockedByViewerId },
      { blockerId: viewerBlockerId, blockedId: viewerId },
    ],
  });
  await database.community.createMany({
    data: [
      { ...community.alpha, name: `Discovery Alpha ${run}` },
      { ...community.beta, name: `Discovery Beta ${run}` },
      { ...community.delta, name: `Discovery Delta ${run}` },
      { ...community.epsilon, name: `Discovery Epsilon ${run}` },
      { ...community.gamma, name: `Discovery Gamma ${run}` },
      {
        ...community.archived,
        name: `Discovery Archived ${run}`,
        status: 'ARCHIVED',
      },
    ],
  });
  await database.community.create({
    data: {
      ...community.mergedBeta,
      name: `Discovery Old Beta ${run}`,
      status: 'ARCHIVED',
      mergedIntoId: community.beta.id,
    },
  });
  await database.communityPost.createMany({
    data: [
      postFixture(post.alphaDiscussion, community.alpha.id, authorId, 10),
      postFixture(post.betaExperience, community.beta.id, authorId, 11, {
        type: 'EXPERIENCE',
      }),
      postFixture(post.alphaPhoneQuestion, community.alpha.id, authorId, 12, {
        type: 'QUESTION',
        title: 'Call me on 9876543210 for the plan',
      }),
      postFixture(post.archivedCommunity, community.archived.id, authorId, 13),
      postFixture(post.privateAuthor, community.alpha.id, privateAuthorId, 13),
      postFixture(
        post.suspendedAuthor,
        community.alpha.id,
        suspendedAuthorId,
        13,
      ),
      postFixture(post.deletedAuthor, community.alpha.id, deletedAuthorId, 13),
      postFixture(post.removed, community.alpha.id, authorId, 13, {
        status: 'REMOVED',
        removedAt: new Date('2026-10-02T00:00:00.000Z'),
      }),
      postFixture(post.draft, community.alpha.id, authorId, 13, {
        status: 'DRAFT',
      }),
      postFixture(
        post.blockedByViewer,
        community.alpha.id,
        blockedByViewerId,
        14,
      ),
      postFixture(post.viewerBlocker, community.beta.id, viewerBlockerId, 15),
    ],
  });
  // Upcoming public trips: beta 2, alpha 1, epsilon 1, gamma 1, delta 0.
  await database.trip.createMany({
    data: [
      tripFixture(community.beta.id),
      tripFixture(community.beta.id, 'FULL'),
      tripFixture(community.alpha.id),
      tripFixture(community.epsilon.id),
      tripFixture(community.gamma.id),
      tripFixture(community.delta.id, 'DRAFT'),
    ],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.communityPost.deleteMany({
    where: { communityId: { in: communityIds } },
  });
  await database.trip.deleteMany({
    where: { communityId: { in: communityIds } },
  });
  await database.community.deleteMany({
    where: { id: community.mergedBeta.id },
  });
  await database.community.deleteMany({ where: { id: { in: communityIds } } });
  await database.userBlock.deleteMany({
    where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
  });
  await database.userProfile.deleteMany({ where: { userId: { in: userIds } } });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('recent posts across communities', () => {
  it('shows guests public posts from every active community, newest first', async () => {
    const response = await listRecentPosts();
    expect(fixtureIds(response)).toEqual([
      post.viewerBlocker,
      post.blockedByViewer,
      post.alphaPhoneQuestion,
      post.betaExperience,
      post.alphaDiscussion,
    ]);
    const experience = response
      .json()
      .data.find((item: { id: string }) => item.id === post.betaExperience);
    expect(experience).toMatchObject({
      communityId: community.beta.id,
      community: {
        id: community.beta.id,
        slug: community.beta.slug,
        name: `Discovery Beta ${run}`,
      },
      author: { id: authorId, displayName: 'Discovery Author' },
    });
  });

  it('hides posts blocked in either direction from a signed-in viewer', async () => {
    const response = await listRecentPosts('', viewerHeaders);
    expect(fixtureIds(response)).toEqual([
      post.alphaPhoneQuestion,
      post.betaExperience,
      post.alphaDiscussion,
    ]);
  });

  it('masks sensitive public text without hiding the post', async () => {
    const response = await listRecentPosts(
      `&community=${community.alpha.slug}`,
    );
    const question = response
      .json()
      .data.find((item: { id: string }) => item.id === post.alphaPhoneQuestion);
    expect(question.title).toBe(hiddenPublicText);
  });

  it('filters by destination, including a merged destination slug', async () => {
    const alpha = await listRecentPosts(`&community=${community.alpha.slug}`);
    expect(alpha.json().data.map((item: { id: string }) => item.id)).toEqual([
      post.blockedByViewer,
      post.alphaPhoneQuestion,
      post.alphaDiscussion,
    ]);
    expect(alpha.json().pagination.totalItems).toBe(3);

    const merged = await listRecentPosts(
      `&community=${community.mergedBeta.slug}`,
    );
    expect(merged.json().data.map((item: { id: string }) => item.id)).toEqual([
      post.viewerBlocker,
      post.betaExperience,
    ]);
  });

  it('filters by post type', async () => {
    const response = await listRecentPosts('&type=EXPERIENCE');
    expect(fixtureIds(response)).toEqual([post.betaExperience]);
  });

  it('paginates a destination list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/community-posts?community=${community.alpha.slug}&page=2&pageSize=2`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((item: { id: string }) => item.id)).toEqual(
      [post.alphaDiscussion],
    );
    expect(response.json().pagination).toEqual({
      page: 2,
      pageSize: 2,
      totalItems: 3,
      totalPages: 2,
    });
  });

  it('does not accept an archived destination filter', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/community-posts?community=${community.archived.slug}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('COMMUNITY_NOT_FOUND');
  });
});

describe('community activity sort', () => {
  it('keeps the name order by default', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/communities?search=${run}`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().data.map((item: { slug: string }) => item.slug),
    ).toEqual([
      community.alpha.slug,
      community.beta.slug,
      community.delta.slug,
      community.epsilon.slug,
      community.gamma.slug,
    ]);
  });

  it('orders by upcoming trips, then posts, then name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/communities?search=${run}&sort=activity`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .data.map(
          (item: {
            slug: string;
            activity: { upcomingTrips: number; posts: number };
          }) => [item.slug, item.activity.upcomingTrips, item.activity.posts],
        ),
    ).toEqual([
      [community.beta.slug, 2, 2],
      [community.alpha.slug, 1, 3],
      [community.epsilon.slug, 1, 0],
      [community.gamma.slug, 1, 0],
      [community.delta.slug, 0, 0],
    ]);
    expect(response.json().pagination.totalItems).toBe(5);
  });

  it('paginates the activity order', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/communities?search=${run}&sort=activity&page=2&pageSize=2`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().data.map((item: { slug: string }) => item.slug),
    ).toEqual([community.epsilon.slug, community.gamma.slug]);
    expect(response.json().pagination).toEqual({
      page: 2,
      pageSize: 2,
      totalItems: 5,
      totalPages: 3,
    });
  });
});
