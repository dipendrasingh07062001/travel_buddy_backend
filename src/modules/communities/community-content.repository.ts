import type { Prisma } from '@prisma/client';

import { database } from '../../database/client.js';
import type { CommunityContentRepository } from './community-content.types.js';

const authorSelect = { id: true, displayName: true } as const;

const postSelect = {
  id: true,
  communityId: true,
  type: true,
  title: true,
  body: true,
  publishedAt: true,
  editedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: authorSelect },
} satisfies Prisma.CommunityPostSelect;

const commentSelect = {
  id: true,
  postId: true,
  body: true,
  status: true,
  editedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: authorSelect },
} satisfies Prisma.CommunityCommentSelect;

function visibleAuthor(viewerId?: string): Prisma.UserWhereInput {
  return {
    status: 'ACTIVE',
    deletedAt: null,
    OR: [
      { profile: null },
      { profile: { communityActivityVisibility: 'PUBLIC' } },
    ],
    ...(viewerId && {
      blocksCreated: { none: { blockedId: viewerId } },
      blocksReceived: { none: { blockerId: viewerId } },
    }),
  };
}

function publicPostWhere(
  postId: string,
  viewerId?: string,
): Prisma.CommunityPostWhereInput {
  return {
    id: postId,
    status: 'PUBLISHED',
    removedAt: null,
    community: { status: 'ACTIVE' },
    author: visibleAuthor(viewerId),
  };
}

function withPublishedAt<T extends { publishedAt: Date | null }>(
  post: T | null,
): (T & { publishedAt: Date }) | null {
  return post?.publishedAt ? { ...post, publishedAt: post.publishedAt } : null;
}

export const prismaCommunityContentRepository: CommunityContentRepository = {
  createPost(input) {
    return database.$transaction(async (transaction) => {
      const community = await transaction.community.findFirst({
        where: { id: input.communityId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!community) return null;
      const post = await transaction.communityPost.create({
        data: {
          communityId: input.communityId,
          authorId: input.authorId,
          type: input.type,
          title: input.title,
          body: input.body,
          status: 'PUBLISHED',
          publishedAt: input.now,
        },
        select: postSelect,
      });
      return withPublishedAt(post);
    });
  },

  async findPublicPost(postId, viewerId) {
    const post = await database.communityPost.findFirst({
      where: publicPostWhere(postId, viewerId),
      select: postSelect,
    });
    return withPublishedAt(post);
  },

  updateOwnPost(input) {
    return database.$transaction(async (transaction) => {
      const current = await transaction.communityPost.findFirst({
        where: {
          id: input.postId,
          authorId: input.authorId,
          status: 'PUBLISHED',
          removedAt: null,
        },
        select: { id: true },
      });
      if (!current) return null;
      const post = await transaction.communityPost.update({
        where: { id: input.postId },
        data: {
          ...(input.type && { type: input.type }),
          ...(input.title && { title: input.title }),
          ...(input.body && { body: input.body }),
          editedAt: input.now,
        },
        select: postSelect,
      });
      return withPublishedAt(post);
    });
  },

  async removeOwnPost(postId, authorId, now) {
    const result = await database.communityPost.updateMany({
      where: { id: postId, authorId, status: 'PUBLISHED', removedAt: null },
      data: { status: 'REMOVED', removedAt: now },
    });
    return result.count === 1;
  },

  async listComments(postId, query) {
    if (
      (await database.communityPost.count({
        where: publicPostWhere(postId, query.viewerId),
      })) !== 1
    ) {
      return null;
    }
    const where: Prisma.CommunityCommentWhereInput = {
      postId,
      status: { in: ['ACTIVE', 'EDITED'] },
      removedAt: null,
      author: visibleAuthor(query.viewerId),
    };
    const [comments, totalItems] = await database.$transaction([
      database.communityComment.findMany({
        where,
        select: commentSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      database.communityComment.count({ where }),
    ]);
    return { comments, totalItems };
  },

  createComment(postId, authorId, body) {
    return database.$transaction(async (transaction) => {
      if (
        (await transaction.communityPost.count({
          where: publicPostWhere(postId, authorId),
        })) !== 1
      ) {
        return null;
      }
      return transaction.communityComment.create({
        data: { postId, authorId, body },
        select: commentSelect,
      });
    });
  },

  updateOwnComment(commentId, authorId, body, now) {
    return database.$transaction(async (transaction) => {
      const current = await transaction.communityComment.findFirst({
        where: {
          id: commentId,
          authorId,
          status: { in: ['ACTIVE', 'EDITED'] },
          removedAt: null,
          post: { status: 'PUBLISHED', removedAt: null },
        },
        select: { id: true },
      });
      if (!current) return null;
      return transaction.communityComment.update({
        where: { id: commentId },
        data: { body, status: 'EDITED', editedAt: now },
        select: commentSelect,
      });
    });
  },

  async removeOwnComment(commentId, authorId, now) {
    const result = await database.communityComment.updateMany({
      where: {
        id: commentId,
        authorId,
        status: { in: ['ACTIVE', 'EDITED'] },
        removedAt: null,
      },
      data: { status: 'REMOVED', removedAt: now },
    });
    return result.count === 1;
  },
};
