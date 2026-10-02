import type {
  AccountDataRequestStatus,
  AccountDataRequestType,
} from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import {
  authenticateRequest,
  authenticateRequestIncludingSuspended,
} from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  requireAdmin,
  requireStaff,
} from '../moderation/moderation.repository.js';
import {
  cancelDataRequest,
  createDataRequest,
  listAdminDataRequests,
  listMyDataRequests,
} from './data-request.repository.js';

interface CreateBody {
  type: AccountDataRequestType;
}

interface RequestParams {
  requestId: string;
}

interface PageQuery {
  page?: number;
  pageSize?: number;
}

interface AdminPageQuery extends PageQuery {
  status?: AccountDataRequestStatus;
}

const pageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
} as const;

const dataRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'userId', 'type', 'status', 'createdAt', 'cancelledAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: ['ACCESS', 'ACCOUNT_DELETION'] },
    status: { type: 'string', enum: ['OPEN', 'CANCELLED'] },
    createdAt: { type: 'string', format: 'date-time' },
    cancelledAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
  },
} as const;

const singleResponseSchema = {
  type: 'object',
  required: ['data'],
  properties: { data: dataRequestSchema },
} as const;

const listResponseSchema = {
  type: 'object',
  required: ['data', 'pagination'],
  properties: {
    data: { type: 'array', items: dataRequestSchema },
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
} as const;

function pagination(page: number, pageSize: number, totalItems: number) {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}

function presentRequest(request: {
  id: string;
  userId: string;
  type: AccountDataRequestType;
  status: AccountDataRequestStatus;
  createdAt: Date;
  cancelledAt: Date | null;
}) {
  return {
    id: request.id,
    userId: request.userId,
    type: request.type,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    cancelledAt: request.cancelledAt?.toISOString() ?? null,
  };
}

export async function registerDataRequestRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
): Promise<void> {
  app.post<{ Body: CreateBody }>(
    '/me/data-requests',
    {
      schema: {
        tags: ['Account data'],
        summary:
          'Request additional account data or request account deletion review',
        description:
          'Creates an operator-review request only. This endpoint never deletes account data or sends the request automatically to an external service.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['ACCESS', 'ACCOUNT_DELETION'] },
          },
        },
        response: { 200: singleResponseSchema, 201: singleResponseSchema },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequestIncludingSuspended(request, auth);
      const result = await createDataRequest(user.id, request.body.type);
      return reply
        .code(result.created ? 201 : 200)
        .send({ data: presentRequest(result.request) });
    },
  );

  app.get<{ Querystring: PageQuery }>(
    '/me/data-requests',
    {
      schema: {
        tags: ['Account data'],
        summary: 'List your account data and deletion requests',
        security: [{ bearerAuth: [] }],
        querystring: pageSchema,
        response: { 200: listResponseSchema },
      },
    },
    async (request) => {
      const user = await authenticateRequestIncludingSuspended(request, auth);
      const { page = 1, pageSize = 20 } = request.query;
      const result = await listMyDataRequests(user.id, page, pageSize);
      return {
        data: result.requests.map(presentRequest),
        pagination: pagination(page, pageSize, result.totalItems),
      };
    },
  );

  app.post<{ Params: RequestParams }>(
    '/me/data-requests/:requestId/cancel',
    {
      schema: {
        tags: ['Account data'],
        summary: 'Cancel your open request without deleting any account data',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
        response: { 200: singleResponseSchema },
      },
    },
    async (request) => {
      const user = await authenticateRequestIncludingSuspended(request, auth);
      const cancelled = await cancelDataRequest(
        user.id,
        request.params.requestId,
      );
      return { data: presentRequest(cancelled) };
    },
  );

  app.get<{ Querystring: AdminPageQuery }>(
    '/admin/data-requests',
    {
      schema: {
        tags: ['Account data'],
        summary:
          'List account data requests for founders with administrator access',
        security: [{ bearerAuth: [] }],
        querystring: {
          ...pageSchema,
          properties: {
            ...pageSchema.properties,
            status: { type: 'string', enum: ['OPEN', 'CANCELLED'] },
          },
        },
        response: { 200: listResponseSchema },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      requireAdmin(await requireStaff(user.id));
      const { page = 1, pageSize = 20, status } = request.query;
      const result = await listAdminDataRequests(status, page, pageSize);
      return {
        data: result.requests.map(presentRequest),
        pagination: pagination(page, pageSize, result.totalItems),
      };
    },
  );
}
