import type { FastifyInstance } from 'fastify';

import {
  authenticateRequest,
  authenticateRequestIfPresent,
} from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  presentCommunityComment,
  presentCommunityContentPost,
} from './community-content.presenter.js';
import { prismaCommunityContentRepository } from './community-content.repository.js';
import {
  createCommunityComment,
  createCommunityPost,
  getCommunityPost,
  listCommunityComments,
  removeCommunityComment,
  removeCommunityPost,
  updateCommunityComment,
  updateCommunityPost,
  type CreateCommunityPostBody,
  type UpdateCommunityPostBody,
} from './community-content.service.js';
import type { CommunityContentRouteDependencies } from './community-content.types.js';

interface CommunityIdParams {
  communityId: string;
}

interface PostIdParams {
  postId: string;
}

interface CommentIdParams {
  commentId: string;
}

interface PageQuery {
  page?: number;
  pageSize?: number;
}

const postTypes = ['DISCUSSION', 'QUESTION', 'EXPERIENCE'] as const;
const commentStatuses = ['ACTIVE', 'EDITED'] as const;

const authorSchema = {
  type: 'object',
  required: ['id', 'displayName'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const;

const contentPostSchema = {
  type: 'object',
  required: [
    'id',
    'communityId',
    'type',
    'title',
    'body',
    'author',
    'publishedAt',
    'editedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    communityId: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: postTypes },
    title: { type: 'string' },
    body: { type: 'string' },
    author: authorSchema,
    publishedAt: { type: 'string', format: 'date-time' },
    editedAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const commentSchema = {
  type: 'object',
  required: [
    'id',
    'postId',
    'body',
    'status',
    'author',
    'editedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    postId: { type: 'string', format: 'uuid' },
    body: { type: 'string' },
    status: { type: 'string', enum: commentStatuses },
    author: authorSchema,
    editedAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const paginationSchema = {
  type: 'object',
  required: ['page', 'pageSize', 'totalItems', 'totalPages'],
  properties: {
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    totalItems: { type: 'integer' },
    totalPages: { type: 'integer' },
  },
} as const;

const pageQuerySchema = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
} as const;

const uuidParams = (name: 'communityId' | 'postId' | 'commentId') => ({
  type: 'object',
  required: [name],
  properties: { [name]: { type: 'string', format: 'uuid' } },
});

function pagination(page: number, pageSize: number, totalItems: number) {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}

export async function registerCommunityContentRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<CommunityContentRouteDependencies> = {},
): Promise<void> {
  const repository = overrides.repository ?? prismaCommunityContentRepository;

  app.post<{
    Params: CommunityIdParams;
    Body: CreateCommunityPostBody;
  }>(
    '/communities/:communityId/posts',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        tags: ['Communities'],
        summary: 'Publish a destination community post',
        security: [{ bearerAuth: [] }],
        params: uuidParams('communityId'),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'title', 'body'],
          properties: {
            type: { type: 'string', enum: postTypes },
            title: { type: 'string', minLength: 5, maxLength: 160 },
            body: { type: 'string', minLength: 20, maxLength: 5000 },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['data'],
            properties: { data: contentPostSchema },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      const post = await createCommunityPost(
        user,
        request.params.communityId,
        request.body,
        repository,
      );
      return reply.code(201).send({ data: presentCommunityContentPost(post) });
    },
  );

  app.get<{ Params: PostIdParams }>(
    '/community-posts/:postId',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Get one public community post',
        params: uuidParams('postId'),
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: contentPostSchema },
          },
        },
      },
    },
    async (request) => {
      const viewer = await authenticateRequestIfPresent(request, auth);
      const post = await getCommunityPost(
        request.params.postId,
        viewer?.id,
        repository,
      );
      return { data: presentCommunityContentPost(post) };
    },
  );

  app.patch<{ Params: PostIdParams; Body: UpdateCommunityPostBody }>(
    '/community-posts/:postId',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Edit an owned community post',
        security: [{ bearerAuth: [] }],
        params: uuidParams('postId'),
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            type: { type: 'string', enum: postTypes },
            title: { type: 'string', minLength: 5, maxLength: 160 },
            body: { type: 'string', minLength: 20, maxLength: 5000 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: contentPostSchema },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const post = await updateCommunityPost(
        user.id,
        request.params.postId,
        request.body,
        repository,
      );
      return { data: presentCommunityContentPost(post) };
    },
  );

  app.delete<{ Params: PostIdParams }>(
    '/community-posts/:postId',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Remove an owned community post',
        security: [{ bearerAuth: [] }],
        params: uuidParams('postId'),
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      await removeCommunityPost(user.id, request.params.postId, repository);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: PostIdParams; Querystring: PageQuery }>(
    '/community-posts/:postId/comments',
    {
      schema: {
        tags: ['Communities'],
        summary: 'List public comments for a community post',
        params: uuidParams('postId'),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: pageQuerySchema,
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: commentSchema },
              pagination: paginationSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const viewer = await authenticateRequestIfPresent(request, auth);
      const query = {
        ...(viewer && { viewerId: viewer.id }),
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
      };
      const result = await listCommunityComments(
        request.params.postId,
        query,
        repository,
      );
      return {
        data: result.comments.map(presentCommunityComment),
        pagination: pagination(query.page, query.pageSize, result.totalItems),
      };
    },
  );

  app.post<{ Params: PostIdParams; Body: { body: string } }>(
    '/community-posts/:postId/comments',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
      schema: {
        tags: ['Communities'],
        summary: 'Add a comment to a public community post',
        security: [{ bearerAuth: [] }],
        params: uuidParams('postId'),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['body'],
          properties: {
            body: { type: 'string', minLength: 2, maxLength: 2000 },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['data'],
            properties: { data: commentSchema },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      const comment = await createCommunityComment(
        user,
        request.params.postId,
        request.body.body,
        repository,
      );
      return reply.code(201).send({ data: presentCommunityComment(comment) });
    },
  );

  app.patch<{ Params: CommentIdParams; Body: { body: string } }>(
    '/community-comments/:commentId',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Edit an owned community comment',
        security: [{ bearerAuth: [] }],
        params: uuidParams('commentId'),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['body'],
          properties: {
            body: { type: 'string', minLength: 2, maxLength: 2000 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: commentSchema },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const comment = await updateCommunityComment(
        user.id,
        request.params.commentId,
        request.body.body,
        repository,
      );
      return { data: presentCommunityComment(comment) };
    },
  );

  app.delete<{ Params: CommentIdParams }>(
    '/community-comments/:commentId',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Remove an owned community comment',
        security: [{ bearerAuth: [] }],
        params: uuidParams('commentId'),
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      await removeCommunityComment(
        user.id,
        request.params.commentId,
        repository,
      );
      return reply.code(204).send();
    },
  );
}
