import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors/app-error.js';
import { authenticateRequestIfPresent } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { publicTripSchema } from '../trips/trip.routes.js';
import { prismaProfileActivityRepository } from './profile-activity.repository.js';
import {
  presentProfileTrip,
  presentProfilePost,
  presentProfileComment,
} from './profile-activity.presenter.js';
import type {
  ActivityPage,
  ActivityResult,
  ProfileTripQuery,
  ProfileActivityDependencies,
} from './profile-activity.types.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const text = { type: 'string' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { anyOf: [dateTime, { type: 'null' }] } as const;
const community = publicTripSchema.properties.destination;
const tripCard = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'originCity',
    'destination',
    'startDate',
    'endDate',
    'dateMode',
    'weekendsOnly',
    'durationDays',
    'status',
    'publishedAt',
  ],
  properties: {
    id: uuid,
    originCity: text,
    destination: community,
    startDate: publicTripSchema.properties.startDate,
    endDate: publicTripSchema.properties.endDate,
    dateMode: publicTripSchema.properties.dateMode,
    weekendsOnly: publicTripSchema.properties.weekendsOnly,
    durationDays: { type: 'integer' },
    status: { type: 'string', enum: ['PUBLISHED', 'FULL', 'COMPLETED'] },
    publishedAt: nullableDateTime,
  },
};
const postCard = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'title', 'community', 'publishedAt'],
  properties: {
    id: uuid,
    type: { type: 'string', enum: ['DISCUSSION', 'QUESTION', 'EXPERIENCE'] },
    title: text,
    community,
    publishedAt: nullableDateTime,
  },
};
const commentCard = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'post', 'community', 'createdAt', 'editedAt'],
  properties: {
    id: uuid,
    post: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title'],
      properties: { id: uuid, title: text },
    },
    community,
    createdAt: dateTime,
    editedAt: nullableDateTime,
  },
};

export async function registerProfileActivityRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<ProfileActivityDependencies> = {},
) {
  const repository = overrides.repository ?? prismaProfileActivityRepository;
  function register<T>(
    suffix: string,
    itemSchema: object,
    read: (
      id: string,
      viewerId: string | undefined,
      query: ProfileTripQuery,
    ) => Promise<ActivityResult<T> | null>,
    present: (item: T) => unknown,
  ) {
    app.get<{
      Params: { userId: string };
      Querystring: Partial<ProfileTripQuery>;
    }>(
      `/users/:userId/${suffix}`,
      {
        schema: {
          tags: ['Profiles'],
          summary: `List visible profile ${suffix} activity cards`,
          params: {
            type: 'object',
            required: ['userId'],
            properties: { userId: uuid },
          },
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              page: {
                type: 'integer',
                minimum: 1,
                maximum: Number.MAX_SAFE_INTEGER,
                default: 1,
              },
              pageSize: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                default: 20,
              },
              ...(suffix === 'trips' && {
                period: {
                  type: 'string',
                  enum: ['upcoming', 'past'],
                  default: 'upcoming',
                },
              }),
            },
          },
          response: {
            200: {
              type: 'object',
              required: ['data', 'pagination'],
              properties: {
                data: { type: 'array', items: itemSchema },
                pagination: {
                  type: 'object',
                  required: ['page', 'pageSize', 'totalItems', 'totalPages'],
                  properties: {
                    page: { type: 'integer' },
                    pageSize: { type: 'integer' },
                    totalItems: { type: 'integer' },
                    totalPages: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const viewer = await authenticateRequestIfPresent(request, auth);
        reply.header('Cache-Control', 'private, no-store');
        const query: ProfileTripQuery = {
          page: request.query.page ?? 1,
          pageSize: request.query.pageSize ?? 20,
          period: request.query.period ?? 'upcoming',
        };
        if (!Number.isSafeInteger((query.page - 1) * query.pageSize))
          throw new AppError(
            400,
            'INVALID_PAGINATION',
            'The requested pagination offset is too large.',
          );
        const result = await read(request.params.userId, viewer?.id, query);
        if (!result)
          throw new AppError(404, 'NOT_FOUND', 'User profile not found.');
        return {
          data: result.items.map(present),
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            totalItems: result.totalItems,
            totalPages: Math.ceil(result.totalItems / query.pageSize),
          },
        };
      },
    );
  }
  register(
    'trips',
    tripCard,
    (id, viewer, query) => repository.listTrips(id, viewer, query),
    presentProfileTrip,
  );
  register(
    'community-posts',
    postCard,
    (id, viewer, query: ActivityPage) =>
      repository.listPosts(id, viewer, query),
    presentProfilePost,
  );
  register(
    'community-comments',
    commentCard,
    (id, viewer, query: ActivityPage) =>
      repository.listComments(id, viewer, query),
    presentProfileComment,
  );
}
