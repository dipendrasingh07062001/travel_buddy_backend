import type { CommunityPostType } from '@prisma/client';

import { AppError } from '../../errors/app-error.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import type {
  CommunityContentRepository,
  ListCommunityCommentsQuery,
} from './community-content.types.js';

export interface CreateCommunityPostBody {
  type: CommunityPostType;
  title: string;
  body: string;
}

export interface UpdateCommunityPostBody {
  type?: CommunityPostType;
  title?: string;
  body?: string;
}

function requireCommunityProfile(user: AuthenticatedUser): void {
  if (
    !user.displayName ||
    !user.birthDate ||
    !user.profile?.homeCity ||
    !user.profile.biography ||
    user.profile.languages.length === 0
  ) {
    throw new AppError(
      409,
      'PROFILE_INCOMPLETE',
      'Complete your display name, birth date, home city, biography, and languages before contributing to a community.',
    );
  }
  if (user.profile.communityActivityVisibility !== 'PUBLIC') {
    throw new AppError(
      409,
      'COMMUNITY_ACTIVITY_PRIVATE',
      'Set community activity visibility to PUBLIC before contributing public content.',
    );
  }
}

function cleanTitle(value: string): string {
  const title = value.trim();
  if (title.length < 5) {
    throw new AppError(
      400,
      'INVALID_POST_TITLE',
      'The post title must contain at least 5 non-space characters.',
    );
  }
  return title;
}

function cleanPostBody(value: string): string {
  const body = value.trim();
  if (body.length < 20) {
    throw new AppError(
      400,
      'INVALID_POST_BODY',
      'The post body must contain at least 20 non-space characters.',
    );
  }
  return body;
}

function cleanCommentBody(value: string): string {
  const body = value.trim();
  if (body.length < 2) {
    throw new AppError(
      400,
      'INVALID_COMMENT_BODY',
      'The comment must contain at least 2 non-space characters.',
    );
  }
  return body;
}

export async function createCommunityPost(
  user: AuthenticatedUser,
  communityId: string,
  body: CreateCommunityPostBody,
  repository: CommunityContentRepository,
  now = new Date(),
) {
  requireCommunityProfile(user);
  const post = await repository.createPost({
    communityId,
    authorId: user.id,
    type: body.type,
    title: cleanTitle(body.title),
    body: cleanPostBody(body.body),
    now,
  });
  if (!post) {
    throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
  }
  return post;
}

export async function getCommunityPost(
  postId: string,
  viewerId: string | undefined,
  repository: CommunityContentRepository,
) {
  const post = await repository.findPublicPost(postId, viewerId);
  if (!post) {
    throw new AppError(
      404,
      'COMMUNITY_POST_NOT_FOUND',
      'Community post not found.',
    );
  }
  return post;
}

export async function updateCommunityPost(
  userId: string,
  postId: string,
  body: UpdateCommunityPostBody,
  repository: CommunityContentRepository,
  now = new Date(),
) {
  const post = await repository.updateOwnPost({
    postId,
    authorId: userId,
    ...(body.type && { type: body.type }),
    ...(body.title !== undefined && { title: cleanTitle(body.title) }),
    ...(body.body !== undefined && { body: cleanPostBody(body.body) }),
    now,
  });
  if (!post) {
    throw new AppError(
      404,
      'COMMUNITY_POST_NOT_FOUND',
      'Community post not found.',
    );
  }
  return post;
}

export async function removeCommunityPost(
  userId: string,
  postId: string,
  repository: CommunityContentRepository,
  now = new Date(),
) {
  if (!(await repository.removeOwnPost(postId, userId, now))) {
    throw new AppError(
      404,
      'COMMUNITY_POST_NOT_FOUND',
      'Community post not found.',
    );
  }
}

export async function listCommunityComments(
  postId: string,
  query: ListCommunityCommentsQuery,
  repository: CommunityContentRepository,
) {
  const result = await repository.listComments(postId, query);
  if (!result) {
    throw new AppError(
      404,
      'COMMUNITY_POST_NOT_FOUND',
      'Community post not found.',
    );
  }
  return result;
}

export async function createCommunityComment(
  user: AuthenticatedUser,
  postId: string,
  body: string,
  repository: CommunityContentRepository,
) {
  requireCommunityProfile(user);
  const comment = await repository.createComment(
    postId,
    user.id,
    cleanCommentBody(body),
  );
  if (!comment) {
    throw new AppError(
      404,
      'COMMUNITY_POST_NOT_FOUND',
      'Community post not found.',
    );
  }
  return comment;
}

export async function updateCommunityComment(
  userId: string,
  commentId: string,
  body: string,
  repository: CommunityContentRepository,
  now = new Date(),
) {
  const comment = await repository.updateOwnComment(
    commentId,
    userId,
    cleanCommentBody(body),
    now,
  );
  if (!comment) {
    throw new AppError(
      404,
      'COMMUNITY_COMMENT_NOT_FOUND',
      'Community comment not found.',
    );
  }
  return comment;
}

export async function removeCommunityComment(
  userId: string,
  commentId: string,
  repository: CommunityContentRepository,
  now = new Date(),
) {
  if (!(await repository.removeOwnComment(commentId, userId, now))) {
    throw new AppError(
      404,
      'COMMUNITY_COMMENT_NOT_FOUND',
      'Community comment not found.',
    );
  }
}
