import type { CommunityCommentStatus, CommunityPostType } from '@prisma/client';

export interface CommunityContentAuthor {
  id: string;
  displayName: string | null;
}

export interface CommunityContentPostRecord {
  id: string;
  communityId: string;
  type: CommunityPostType;
  title: string;
  body: string;
  author: CommunityContentAuthor;
  publishedAt: Date;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommunityCommentRecord {
  id: string;
  postId: string;
  body: string;
  status: CommunityCommentStatus;
  author: CommunityContentAuthor;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCommunityPostInput {
  communityId: string;
  authorId: string;
  type: CommunityPostType;
  title: string;
  body: string;
  now: Date;
}

export interface UpdateCommunityPostInput {
  postId: string;
  authorId: string;
  type?: CommunityPostType;
  title?: string;
  body?: string;
  now: Date;
}

export interface ListCommunityCommentsQuery {
  viewerId?: string;
  page: number;
  pageSize: number;
}

export interface CommunityContentRepository {
  createPost(
    input: CreateCommunityPostInput,
  ): Promise<CommunityContentPostRecord | null>;
  findPublicPost(
    postId: string,
    viewerId?: string,
  ): Promise<CommunityContentPostRecord | null>;
  updateOwnPost(
    input: UpdateCommunityPostInput,
  ): Promise<CommunityContentPostRecord | null>;
  removeOwnPost(postId: string, authorId: string, now: Date): Promise<boolean>;
  listComments(
    postId: string,
    query: ListCommunityCommentsQuery,
  ): Promise<{ comments: CommunityCommentRecord[]; totalItems: number } | null>;
  createComment(
    postId: string,
    authorId: string,
    body: string,
  ): Promise<CommunityCommentRecord | null>;
  updateOwnComment(
    commentId: string,
    authorId: string,
    body: string,
    now: Date,
  ): Promise<CommunityCommentRecord | null>;
  removeOwnComment(
    commentId: string,
    authorId: string,
    now: Date,
  ): Promise<boolean>;
}

export interface CommunityContentRouteDependencies {
  repository: CommunityContentRepository;
}
