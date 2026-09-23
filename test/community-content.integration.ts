import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';

const authorId = randomUUID();
const memberId = randomUUID();
const communityId = randomUUID();
const slug = `content-integration-${communityId}`;
let postId = '';
let commentId = '';

function user(id: string, displayName: string): AuthenticatedUser {
  return {
    id,
    displayName,
    birthDate: new Date('1994-01-10T00:00:00.000Z'),
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: {
      profilePhotoStorageKey: null,
      homeCity: 'Delhi',
      homeRegion: 'Delhi NCR',
      biography: 'A complete integration profile for community participation.',
      languages: ['English'],
      travelInterests: ['mountains'],
      pastTripsVisibility: 'MEMBERS_ONLY',
      communityActivityVisibility: 'PUBLIC',
    },
  };
}

const users: Record<string, AuthenticatedUser> = {
  'author-token': user(authorId, 'Community Author'),
  'member-token': user(memberId, 'Community Member'),
};

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: true };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser(identity) {
    return { user: users[identity.subject]!, created: false };
  },
  async findFirebaseUser(subject) {
    return users[subject] ?? null;
  },
};

const app = buildApp({
  logger: false,
  auth: { tokenVerifier, repository: authRepository },
});
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await database.user.createMany({
    data: [
      { id: authorId, displayName: 'Community Author' },
      { id: memberId, displayName: 'Community Member' },
    ],
  });
  await database.userProfile.createMany({
    data: [authorId, memberId].map((userId) => ({
      userId,
      homeCity: 'Delhi',
      biography: 'A complete integration profile for community participation.',
      languages: ['English'],
      communityActivityVisibility: 'PUBLIC' as const,
    })),
  });
  await database.community.create({
    data: {
      id: communityId,
      slug,
      name: 'Community Content Integration',
      region: 'Himachal Pradesh',
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.report.deleteMany({
    where: { reporterId: { in: [authorId, memberId] } },
  });
  await database.userBlock.deleteMany({
    where: {
      OR: [{ blockerId: memberId }, { blockedId: memberId }],
    },
  });
  await database.communityComment.deleteMany({ where: { postId } });
  await database.communityPost.deleteMany({ where: { communityId } });
  await database.community.delete({ where: { id: communityId } });
  await database.userProfile.deleteMany({
    where: { userId: { in: [authorId, memberId] } },
  });
  await database.user.deleteMany({
    where: { id: { in: [authorId, memberId] } },
  });
});

describe('community content database integration', () => {
  it('persists a public post and supports an owner edit', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/posts`,
      headers: headers('author-token'),
      payload: {
        type: 'QUESTION',
        title: 'Integration route question',
        body: 'Which route conditions should travellers prepare for this month?',
      },
    });
    expect(created.statusCode).toBe(201);
    postId = created.json().data.id;

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/community-posts/${postId}`,
      headers: headers('author-token'),
      payload: { type: 'DISCUSSION' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data.type).toBe('DISCUSSION');
    expect(await database.communityPost.count({ where: { id: postId } })).toBe(
      1,
    );
  });

  it('persists, edits, and publicly lists a comment', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/community-posts/${postId}/comments`,
      headers: headers('member-token'),
      payload: { body: 'Check official road notices before departure.' },
    });
    expect(created.statusCode).toBe(201);
    commentId = created.json().data.id;

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/community-comments/${commentId}`,
      headers: headers('member-token'),
      payload: {
        body: 'Check official road and weather notices before departure.',
      },
    });
    expect(edited.json().data.status).toBe('EDITED');

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/community-posts/${postId}/comments`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data[0].id).toBe(commentId);
  });

  it('accepts one open report per reporter and community target', async () => {
    const postReport = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('member-token'),
      payload: {
        targetType: 'COMMUNITY_POST',
        targetId: postId,
        reason: 'OTHER',
        details: 'This post needs moderator review for misleading information.',
      },
    });
    const repeatedPostReport = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('member-token'),
      payload: {
        targetType: 'COMMUNITY_POST',
        targetId: postId,
        reason: 'OTHER',
        details: 'This post needs moderator review for misleading information.',
      },
    });
    const commentReport = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('author-token'),
      payload: {
        targetType: 'COMMUNITY_COMMENT',
        targetId: commentId,
        reason: 'OTHER',
        details: 'This comment needs moderator review for inaccurate guidance.',
      },
    });
    expect(postReport.statusCode).toBe(201);
    expect(postReport.json().data.target.type).toBe('COMMUNITY_POST');
    expect(repeatedPostReport.statusCode).toBe(409);
    expect(commentReport.statusCode).toBe(201);
    expect(commentReport.json().data.target.type).toBe('COMMUNITY_COMMENT');
  });

  it('hides content between blocked accounts for authenticated reads', async () => {
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${authorId}/block`,
      headers: headers('member-token'),
    });
    expect(blocked.statusCode).toBe(200);

    const feed = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug}/posts`,
      headers: headers('member-token'),
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/community-posts/${postId}`,
      headers: headers('member-token'),
    });
    const blockedComment = await app.inject({
      method: 'POST',
      url: `/api/v1/community-posts/${postId}/comments`,
      headers: headers('member-token'),
      payload: { body: 'This blocked interaction must not be created.' },
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.json().data).toEqual([]);
    expect(detail.statusCode).toBe(404);
    expect(blockedComment.statusCode).toBe(404);
  });

  it('soft-deletes owned content while preserving rows for moderation', async () => {
    const commentDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/community-comments/${commentId}`,
      headers: headers('member-token'),
    });
    const postDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/community-posts/${postId}`,
      headers: headers('author-token'),
    });
    expect(commentDelete.statusCode).toBe(204);
    expect(postDelete.statusCode).toBe(204);
    expect(
      await database.communityComment.count({
        where: { id: commentId, status: 'REMOVED' },
      }),
    ).toBe(1);
    expect(
      await database.communityPost.count({
        where: { id: postId, status: 'REMOVED' },
      }),
    ).toBe(1);
  });
});
