import type { ConnectionRequestStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../errors/app-error.js';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { publicUserSchema } from '../profiles/profile.schemas.js';
import {
  presentConnectionRequest,
  presentMembership,
} from './connection.presenter.js';
import { prismaConnectionRepository } from './connection.repository.js';
import {
  acceptConnectionRequest,
  declineConnectionRequest,
  sendConnectionRequest,
  withdrawConnectionRequest,
  type CreateConnectionRequestBody,
} from './connection.service.js';
import type {
  ConnectionRouteDependencies,
  ListConnectionRequestsQuery,
} from './connection.types.js';

interface TripParams {
  tripId: string;
}

interface RequestParams {
  requestId: string;
}

interface RequestListQuery {
  box?: 'received' | 'sent';
  status?: ConnectionRequestStatus;
  page?: number;
  pageSize?: number;
}

const requestStatuses = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'WITHDRAWN',
  'BLOCKED',
] as const;

const tripReferenceSchema = {
  type: 'object',
  required: ['id', 'destination', 'startDate', 'endDate', 'status'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    destination: {
      type: 'object',
      required: ['slug', 'name'],
      properties: { slug: { type: 'string' }, name: { type: 'string' } },
    },
    startDate: { type: 'string', format: 'date' },
    endDate: { type: 'string', format: 'date' },
    status: { type: 'string' },
  },
} as const;

const connectionRequestSchema = {
  type: 'object',
  required: [
    'id',
    'status',
    'message',
    'trip',
    'relatedTrip',
    'requester',
    'recipient',
    'createdAt',
    'updatedAt',
    'decidedAt',
    'withdrawnAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: requestStatuses },
    message: { type: 'string' },
    trip: tripReferenceSchema,
    relatedTrip: { anyOf: [tripReferenceSchema, { type: 'null' }] },
    requester: publicUserSchema,
    recipient: {
      type: 'object',
      required: ['id', 'displayName'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    decidedAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    withdrawnAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
  },
} as const;

const requestResponse = {
  type: 'object',
  required: ['data'],
  properties: { data: connectionRequestSchema },
} as const;

export async function registerConnectionRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<ConnectionRouteDependencies> = {},
): Promise<void> {
  const repository = overrides.repository ?? prismaConnectionRepository;

  app.post<{ Params: TripParams; Body: CreateConnectionRequestBody }>(
    '/trips/:tripId/connection-requests',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        tags: ['Connections'],
        summary: 'Request a trip-specific connection',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['tripId'],
          properties: { tripId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['message'],
          properties: {
            message: { type: 'string', minLength: 20, maxLength: 500 },
            relatedTripId: { type: 'string', format: 'uuid' },
          },
        },
        response: { 201: requestResponse },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      const connection = await sendConnectionRequest(
        user,
        request.params.tripId,
        request.body,
        repository,
      );
      return reply
        .code(201)
        .send({ data: presentConnectionRequest(connection) });
    },
  );

  app.get<{ Querystring: RequestListQuery }>(
    '/me/connection-requests',
    {
      schema: {
        tags: ['Connections'],
        summary: 'List sent or received connection requests',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            box: {
              type: 'string',
              enum: ['received', 'sent'],
              default: 'received',
            },
            status: { type: 'string', enum: requestStatuses },
            page: { type: 'integer', minimum: 1, default: 1 },
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
              data: { type: 'array', items: connectionRequestSchema },
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
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const query: ListConnectionRequestsQuery = {
        box: request.query.box ?? 'received',
        ...(request.query.status && { status: request.query.status }),
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
      };
      const result = await repository.list(user.id, query);
      return {
        data: result.requests.map(presentConnectionRequest),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / query.pageSize),
        },
      };
    },
  );

  const actions = {
    accept: acceptConnectionRequest,
    decline: declineConnectionRequest,
  } as const;
  for (const [action, service] of Object.entries(actions)) {
    app.post<{ Params: RequestParams }>(
      `/connection-requests/:requestId/${action}`,
      {
        schema: {
          tags: ['Connections'],
          summary: `${action === 'accept' ? 'Accept' : 'Decline'} a received connection request`,
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['requestId'],
            properties: { requestId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: requestResponse },
        },
      },
      async (request) => {
        const user = await authenticateRequest(request, auth);
        const connection = await service(
          user.id,
          request.params.requestId,
          repository,
        );
        return { data: presentConnectionRequest(connection) };
      },
    );
  }

  app.post<{ Params: RequestParams }>(
    '/connection-requests/:requestId/withdraw',
    {
      schema: {
        tags: ['Connections'],
        summary: 'Withdraw a sent pending connection request',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
        response: { 200: requestResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const connection = await withdrawConnectionRequest(
        user.id,
        request.params.requestId,
        repository,
      );
      return { data: presentConnectionRequest(connection) };
    },
  );

  app.get<{ Params: TripParams }>(
    '/trips/:tripId/members',
    {
      schema: {
        tags: ['Connections'],
        summary: 'List the private active membership of a trip',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['tripId'],
          properties: { tripId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const members = await repository.listActiveMembers(
        request.params.tripId,
        user.id,
      );
      if (!members) {
        throw new AppError(
          403,
          'TRIP_MEMBERSHIP_REQUIRED',
          'Only active trip members can view this member list.',
        );
      }
      return { data: members.map(presentMembership) };
    },
  );
}
