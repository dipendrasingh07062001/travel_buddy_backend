import type { FastifyInstance } from 'fastify';

import { AppError } from '../../errors/app-error.js';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { presentTripMembership } from './trip-membership.presenter.js';
import { prismaTripMembershipRepository } from './trip-membership.repository.js';
import {
  membershipRoles,
  membershipViews,
  type ListTripMembershipsQuery,
  type TripMembershipRouteDependencies,
} from './trip-membership.types.js';
import { publicTripSchema } from './trip.routes.js';
import { tripStatusValues } from './trip.types.js';

type MembershipQuery = Partial<ListTripMembershipsQuery>;

const nullableDateTime = {
  anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
} as const;

const membershipSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'tripId',
    'role',
    'status',
    'joinedAt',
    'leftAt',
    'removedAt',
    'trip',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tripId: { type: 'string', format: 'uuid' },
    role: { type: 'string', enum: membershipRoles },
    status: { type: 'string', enum: ['ACTIVE', 'LEFT', 'REMOVED'] },
    joinedAt: { type: 'string', format: 'date-time' },
    leftAt: nullableDateTime,
    removedAt: nullableDateTime,
    trip: {
      anyOf: [
        {
          ...publicTripSchema,
          properties: {
            ...publicTripSchema.properties,
            status: { type: 'string', enum: tripStatusValues },
          },
        },
        { type: 'null' },
      ],
    },
  },
} as const;

export async function registerTripMembershipRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<TripMembershipRouteDependencies> = {},
) {
  const repository = overrides.repository ?? prismaTripMembershipRepository;
  app.get<{ Querystring: MembershipQuery }>(
    '/me/trip-memberships',
    {
      schema: {
        tags: ['Trips'],
        summary: "List the current user's active trips or membership history",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: { type: 'string', enum: membershipViews, default: 'active' },
            role: { type: 'string', enum: membershipRoles },
            tripStatus: {
              type: 'string',
              enum: tripStatusValues,
              description:
                'Available only with view=active, to protect former-member privacy.',
            },
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
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: membershipSchema },
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
      const user = await authenticateRequest(request, auth);
      reply.header('Cache-Control', 'private, no-store');
      const query: ListTripMembershipsQuery = {
        ...request.query,
        view: request.query.view ?? 'active',
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
      };
      if (query.tripStatus && query.view !== 'active') {
        throw new AppError(
          400,
          'INVALID_MEMBERSHIP_FILTER',
          'tripStatus is available only with view=active.',
        );
      }
      if (!Number.isSafeInteger((query.page - 1) * query.pageSize)) {
        throw new AppError(
          400,
          'INVALID_PAGINATION',
          'The requested pagination offset is too large.',
        );
      }
      const result = await repository.listForUser(user.id, query);
      return {
        data: result.items.map(presentTripMembership),
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
