import type { FastifyInstance } from 'fastify';

import type {
  AccountDataRequestStatus,
  AccountDataRequestType,
} from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import {
  authenticateRequest,
  authenticateRequestIncludingSuspended,
  verifyRequestIdentity,
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
  confirm?: boolean;
}

// Deleting an account needs a fresh sign-in, so a device left signed in is
// not enough.
const recentSignInMs = 10 * 60 * 1000;
const requestStatuses = ['OPEN', 'CANCELLED', 'COMPLETED'] as const;

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
  required: [
    'id',
    'userId',
    'type',
    'status',
    'createdAt',
    'cancelledAt',
    'scheduledFor',
    'completedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: ['ACCESS', 'ACCOUNT_DELETION'] },
    status: { type: 'string', enum: requestStatuses },
    createdAt: { type: 'string', format: 'date-time' },
    cancelledAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    scheduledFor: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    completedAt: {
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
  scheduledFor: Date | null;
  completedAt: Date | null;
}) {
  return {
    id: request.id,
    userId: request.userId,
    type: request.type,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    cancelledAt: request.cancelledAt?.toISOString() ?? null,
    scheduledFor: request.scheduledFor?.toISOString() ?? null,
    completedAt: request.completedAt?.toISOString() ?? null,
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
        summary: 'Request additional account data or delete your account',
        description:
          'ACCESS creates a request for the founders to review. ACCOUNT_DELETION needs { "confirm": true } and a sign-in within the last 10 minutes; it locks the account at once and erases it at scheduledFor, 30 days later, unless the request is cancelled first.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['ACCESS', 'ACCOUNT_DELETION'] },
            confirm: { type: 'boolean' },
          },
        },
        response: { 200: singleResponseSchema, 201: singleResponseSchema },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequestIncludingSuspended(request, auth);
      if (request.body.type === 'ACCOUNT_DELETION') {
        if (request.body.confirm !== true) {
          throw new AppError(
            400,
            'DELETION_NOT_CONFIRMED',
            'Send "confirm": true to delete this account.',
          );
        }
        const { authTime } = await verifyRequestIdentity(
          request,
          auth.tokenVerifier,
        );
        if (authTime && Date.now() - authTime.getTime() > recentSignInMs) {
          throw new AppError(
            403,
            'RECENT_SIGN_IN_REQUIRED',
            'Sign in again before deleting this account.',
          );
        }
      }
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
        summary:
          'Cancel your open request; cancelling a deletion restores the account',
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
            status: { type: 'string', enum: requestStatuses },
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
