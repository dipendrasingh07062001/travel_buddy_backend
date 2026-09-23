import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type {
  CommunityCommentRecord,
  CommunityContentPostRecord,
  CommunityContentRepository,
} from '../src/modules/communities/community-content.types.js';

const authorId = 'a2000000-0000-4000-8000-000000000001';
const outsiderId = 'a2000000-0000-4000-8000-000000000002';
const privateUserId = 'a2000000-0000-4000-8000-000000000003';
const incompleteUserId = 'a2000000-0000-4000-8000-000000000004';
const communityId = 'b2000000-0000-4000-8000-000000000001';

function user(
  id: string,
  visibility: 'PUBLIC' | 'PRIVATE',
  complete = true,
): AuthenticatedUser {
  return {
    id,
    displayName: complete ? `User ${id.slice(-1)}` : null,
    birthDate: complete ? new Date('1995-01-10T00:00:00.000Z') : null,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: complete
      ? {
          profilePhotoStorageKey: null,
          homeCity: 'Delhi',
          homeRegion: 'Delhi NCR',
          biography: 'A complete profile for community content tests.',
          languages: ['English'],
          travelInterests: ['mountains'],
          pastTripsVisibility: 'MEMBERS_ONLY',
          communityActivityVisibility: visibility,
        }
      : null,
  };
}

const users: Record<string, AuthenticatedUser> = {
  'author-token': user(authorId, 'PUBLIC'),
  'outsider-token': user(outsiderId, 'PUBLIC'),
  'private-token': user(privateUserId, 'PRIVATE'),
  'incomplete-token': user(incompleteUserId, 'PUBLIC', false),
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

const posts = new Map<string, CommunityContentPostRecord>();
const comments = new Map<string, CommunityCommentRecord>();

const repository: CommunityContentRepository = {
  async createPost(input) {
    if (input.communityId !== communityId) return null;
    const post: CommunityContentPostRecord = {
      id: randomUUID(),
      communityId: input.communityId,
      type: input.type,
      title: input.title,
      body: input.body,
      author: {
        id: input.authorId,
        displayName: users['author-token']!.displayName,
      },
      publishedAt: input.now,
      editedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    posts.set(post.id, post);
    return post;
  },
  async findPublicPost(postId) {
    return posts.get(postId) ?? null;
  },
  async updateOwnPost(input) {
    const post = posts.get(input.postId);
    if (!post || post.author.id !== input.authorId) return null;
    const updated = {
      ...post,
      ...(input.type && { type: input.type }),
      ...(input.title && { title: input.title }),
      ...(input.body && { body: input.body }),
      editedAt: input.now,
      updatedAt: input.now,
    };
    posts.set(post.id, updated);
    return updated;
  },
  async removeOwnPost(postId, id) {
    const post = posts.get(postId);
    return Boolean(post && post.author.id === id && posts.delete(postId));
  },
  async listComments(postId, query) {
    if (!posts.has(postId)) return null;
    const matching = [...comments.values()].filter(
      (comment) => comment.postId === postId,
    );
    return {
      comments: matching.slice(
        (query.page - 1) * query.pageSize,
        query.page * query.pageSize,
      ),
      totalItems: matching.length,
    };
  },
  async createComment(postId, id, body) {
    if (!posts.has(postId)) return null;
    const now = new Date();
    const comment: CommunityCommentRecord = {
      id: randomUUID(),
      postId,
      body,
      status: 'ACTIVE',
      author: { id, displayName: users['author-token']!.displayName },
      editedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    comments.set(comment.id, comment);
    return comment;
  },
  async updateOwnComment(commentId, id, body, now) {
    const comment = comments.get(commentId);
    if (!comment || comment.author.id !== id) return null;
    const updated: CommunityCommentRecord = {
      ...comment,
      body,
      status: 'EDITED',
      editedAt: now,
      updatedAt: now,
    };
    comments.set(comment.id, updated);
    return updated;
  },
  async removeOwnComment(commentId, id) {
    const comment = comments.get(commentId);
    return Boolean(
      comment && comment.author.id === id && comments.delete(commentId),
    );
  },
};

const app = buildApp({
  logger: false,
  health: { checkReadiness: async () => undefined },
  auth: { tokenVerifier, repository: authRepository },
  communityContent: { repository },
});

const headers = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe('community content HTTP contract', () => {
  let postId = '';
  let commentId = '';

  it('requires authentication and a public complete profile', async () => {
    const body = {
      type: 'QUESTION',
      title: 'Transport around Manali',
      body: 'What are the practical transport options around Manali?',
    };
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/posts`,
      payload: body,
    });
    const incomplete = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/posts`,
      headers: headers('incomplete-token'),
      payload: body,
    });
    const privateActivity = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/posts`,
      headers: headers('private-token'),
      payload: body,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(incomplete.json().error.code).toBe('PROFILE_INCOMPLETE');
    expect(privateActivity.json().error.code).toBe(
      'COMMUNITY_ACTIVITY_PRIVATE',
    );
  });

  it('creates, reads, and edits an owned post', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/posts`,
      headers: headers('author-token'),
      payload: {
        type: 'DISCUSSION',
        title: '  October road conditions  ',
        body: '  Share factual preparation tips for an October road trip.  ',
      },
    });
    expect(created.statusCode).toBe(201);
    postId = created.json().data.id;
    expect(created.json().data.title).toBe('October road conditions');

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/community-posts/${postId}`,
    });
    expect(read.statusCode).toBe(200);

    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/community-posts/${postId}`,
      headers: headers('outsider-token'),
      payload: { title: 'Attempted outsider edit' },
    });
    expect(forbidden.statusCode).toBe(404);

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/community-posts/${postId}`,
      headers: headers('author-token'),
      payload: { title: 'Updated October road conditions' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data.editedAt).not.toBeNull();
  });

  it('creates, lists, edits, and removes an owned comment', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/community-posts/${postId}/comments`,
      headers: headers('author-token'),
      payload: { body: '  Useful route information.  ' },
    });
    expect(created.statusCode).toBe(201);
    commentId = created.json().data.id;
    expect(created.json().data.body).toBe('Useful route information.');

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/community-posts/${postId}/comments`,
    });
    expect(listed.json().data).toHaveLength(1);

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/community-comments/${commentId}`,
      headers: headers('author-token'),
      payload: { body: 'Updated route information.' },
    });
    expect(edited.json().data.status).toBe('EDITED');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/community-comments/${commentId}`,
      headers: headers('author-token'),
    });
    expect(removed.statusCode).toBe(204);
  });

  it('soft-removes an owned post from public access', async () => {
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/community-posts/${postId}`,
      headers: headers('author-token'),
    });
    expect(removed.statusCode).toBe(204);
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/community-posts/${postId}`,
    });
    expect(hidden.statusCode).toBe(404);
  });
});
