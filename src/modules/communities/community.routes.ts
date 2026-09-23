import type { CommunityPostType, TripTransport } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import {
  authenticateRequest,
  authenticateRequestIfPresent,
} from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { publicTripSchema } from '../trips/trip.routes.js';
import { presentTrip } from '../trips/trip.presenter.js';
import { prismaTripRepository } from '../trips/trip.repository.js';
import type { ListTripsQuery } from '../trips/trip.types.js';
import {
  presentCommunity,
  presentCommunityPost,
  presentFollowedCommunity,
} from './community.presenter.js';
import { prismaCommunityRepository } from './community.repository.js';
import {
  followCommunity,
  listCommunities,
  listCommunityPosts,
  listCommunityTrips,
  requireActiveCommunity,
  unfollowCommunity,
} from './community.service.js';
import type {
  CommunityRouteDependencies,
  ListCommunitiesQuery,
  ListCommunityPostsQuery,
} from './community.types.js';

interface SlugParams {
  slug: string;
}

interface CommunityIdParams {
  communityId: string;
}

interface PageQuery {
  page?: number;
  pageSize?: number;
}

interface CommunityListQuery extends PageQuery {
  search?: string;
}

interface CommunityPostListQuery extends PageQuery {
  type?: CommunityPostType;
}

interface CommunityTripListQuery extends PageQuery {
  origin?: string;
  departureFrom?: string;
  departureTo?: string;
  minBudget?: number;
  maxBudget?: number;
  transport?: TripTransport;
  sort?: 'newest' | 'departure_asc';
}

const postTypes = ['DISCUSSION', 'QUESTION', 'EXPERIENCE'] as const;
const transportValues = [
  'BUS',
  'TRAIN',
  'FLIGHT',
  'CAR',
  'MOTORCYCLE',
  'OTHER',
  'UNDECIDED',
] as const;

const paginationQuerySchema = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
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

const communitySchema = {
  type: 'object',
  required: [
    'id',
    'slug',
    'name',
    'region',
    'countryCode',
    'description',
    'activity',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    region: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    countryCode: { type: 'string' },
    description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    activity: {
      type: 'object',
      required: ['followers', 'upcomingTrips', 'posts'],
      properties: {
        followers: { type: 'integer', minimum: 0 },
        upcomingTrips: { type: 'integer', minimum: 0 },
        posts: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;

const communityPostSchema = {
  type: 'object',
  required: [
    'id',
    'communityId',
    'type',
    'title',
    'body',
    'author',
    'publishedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    communityId: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: postTypes },
    title: { type: 'string' },
    body: { type: 'string' },
    author: {
      type: 'object',
      required: ['id', 'displayName'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    publishedAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const slugParamsSchema = {
  type: 'object',
  required: ['slug'],
  properties: {
    slug: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      pattern: '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$',
    },
  },
} as const;

function pagination(page: number, pageSize: number, totalItems: number) {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}

function validateTripRanges(query: CommunityTripListQuery): void {
  if (
    query.departureFrom &&
    query.departureTo &&
    query.departureFrom > query.departureTo
  ) {
    throw Object.assign(
      new Error('departureFrom must be on or before departureTo.'),
      { statusCode: 400 },
    );
  }
  if (
    query.minBudget !== undefined &&
    query.maxBudget !== undefined &&
    query.minBudget > query.maxBudget
  ) {
    throw Object.assign(
      new Error('minBudget must be less than or equal to maxBudget.'),
      { statusCode: 400 },
    );
  }
}

export async function registerCommunityRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<CommunityRouteDependencies> = {},
): Promise<void> {
  const repository = overrides.repository ?? prismaCommunityRepository;
  const tripRepository = overrides.tripRepository ?? prismaTripRepository;

  app.get<{ Querystring: CommunityListQuery }>(
    '/communities',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Browse active destination communities',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            search: { type: 'string', minLength: 1, maxLength: 120 },
            ...paginationQuerySchema,
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: communitySchema },
              pagination: paginationSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const query: ListCommunitiesQuery = {
        ...(request.query.search && { search: request.query.search }),
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
      };
      const result = await listCommunities(query, repository);
      return {
        data: result.communities.map(presentCommunity),
        pagination: pagination(query.page, query.pageSize, result.totalItems),
      };
    },
  );

  app.get<{ Params: SlugParams }>(
    '/communities/:slug',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Get one active destination community',
        params: slugParamsSchema,
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: communitySchema },
          },
        },
      },
    },
    async (request) => ({
      data: presentCommunity(
        await requireActiveCommunity(request.params.slug, repository),
      ),
    }),
  );

  app.get<{
    Params: SlugParams;
    Querystring: CommunityTripListQuery;
  }>(
    '/communities/:slug/trips',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Browse public trips for a destination community',
        params: slugParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            origin: { type: 'string', minLength: 1, maxLength: 120 },
            departureFrom: { type: 'string', format: 'date' },
            departureTo: { type: 'string', format: 'date' },
            minBudget: { type: 'number', minimum: 0 },
            maxBudget: { type: 'number', minimum: 0 },
            transport: { type: 'string', enum: transportValues },
            sort: {
              type: 'string',
              enum: ['newest', 'departure_asc'],
              default: 'newest',
            },
            ...paginationQuerySchema,
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: publicTripSchema },
              pagination: paginationSchema,
            },
          },
        },
      },
    },
    async (request) => {
      validateTripRanges(request.query);
      const query: ListTripsQuery & {
        page: number;
        pageSize: number;
        sort: 'newest' | 'departure_asc';
      } = {
        ...request.query,
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
        sort: request.query.sort ?? 'newest',
      };
      const result = await listCommunityTrips(
        request.params.slug,
        query,
        repository,
        tripRepository,
      );
      return {
        data: result.trips.map(presentTrip),
        pagination: pagination(query.page, query.pageSize, result.totalItems),
      };
    },
  );

  app.get<{
    Params: SlugParams;
    Querystring: CommunityPostListQuery;
  }>(
    '/communities/:slug/posts',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Browse public posts for a destination community',
        params: slugParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: postTypes },
            ...paginationQuerySchema,
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: communityPostSchema },
              pagination: paginationSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const viewer = await authenticateRequestIfPresent(request, auth);
      const query: ListCommunityPostsQuery = {
        ...(viewer && { viewerId: viewer.id }),
        ...(request.query.type && { type: request.query.type }),
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
      };
      const result = await listCommunityPosts(
        request.params.slug,
        query,
        repository,
      );
      return {
        data: result.posts.map(presentCommunityPost),
        pagination: pagination(query.page, query.pageSize, result.totalItems),
      };
    },
  );

  app.post<{ Params: CommunityIdParams }>(
    '/communities/:communityId/follow',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Follow an active destination community',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['communityId'],
          properties: { communityId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['communityId', 'following', 'followedAt'],
                properties: {
                  communityId: { type: 'string', format: 'uuid' },
                  following: { type: 'boolean' },
                  followedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const follow = await followCommunity(
        user.id,
        request.params.communityId,
        repository,
      );
      return {
        data: {
          communityId: follow.communityId,
          following: true,
          followedAt: follow.followedAt.toISOString(),
        },
      };
    },
  );

  app.delete<{ Params: CommunityIdParams }>(
    '/communities/:communityId/follow',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Unfollow an active destination community',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['communityId'],
          properties: { communityId: { type: 'string', format: 'uuid' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      await unfollowCommunity(user.id, request.params.communityId, repository);
      return reply.code(204).send();
    },
  );

  app.get<{ Querystring: PageQuery }>(
    '/me/followed-communities',
    {
      schema: {
        tags: ['Communities'],
        summary: 'List communities followed by the authenticated user',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: paginationQuerySchema,
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['followedAt', 'community'],
                  properties: {
                    followedAt: { type: 'string', format: 'date-time' },
                    community: communitySchema,
                  },
                },
              },
              pagination: paginationSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const query = {
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
      };
      const result = await repository.listFollowed(user.id, query);
      return {
        data: result.follows.map(presentFollowedCommunity),
        pagination: pagination(query.page, query.pageSize, result.totalItems),
      };
    },
  );
}
