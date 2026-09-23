import type {
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { publicUserSchema } from '../profiles/profile.schemas.js';
import { presentBlock, presentReport } from './safety.presenter.js';
import { prismaSafetyRepository } from './safety.repository.js';
import {
  blockUser,
  createReport,
  type CreateReportBody,
} from './safety.service.js';
import type {
  ListBlocksQuery,
  ListReportsQuery,
  SafetyRouteDependencies,
} from './safety.types.js';

interface UserParams {
  userId: string;
}

interface PageQuery {
  page?: number;
  pageSize?: number;
}

interface ReportListQuery extends PageQuery {
  status?: ReportStatus;
}

const reportTargetTypes = [
  'USER',
  'TRIP',
  'CONNECTION_REQUEST',
  'MESSAGE',
  'COMMUNITY_POST',
  'COMMUNITY_COMMENT',
] as const;
const reportReasons = [
  'HARASSMENT',
  'HATE_OR_THREATS',
  'SEXUAL_SOLICITATION',
  'SCAM_OR_FRAUD',
  'IMPERSONATION',
  'COMMERCIAL_TOUR_SPAM',
  'PRIVACY_VIOLATION',
  'OTHER',
] as const;
const reportStatuses = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACTIONED',
  'DISMISSED',
] as const;

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

const paginationQuerySchema = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
} as const;

const blockSchema = {
  type: 'object',
  required: ['user', 'blockedAt'],
  properties: {
    user: publicUserSchema,
    blockedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const reportSchema = {
  type: 'object',
  required: [
    'id',
    'target',
    'reason',
    'details',
    'status',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    target: {
      type: 'object',
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', enum: reportTargetTypes },
        id: { type: 'string', format: 'uuid' },
      },
    },
    reason: { type: 'string', enum: reportReasons },
    details: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    status: { type: 'string', enum: reportStatuses },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
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

export async function registerSafetyRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<SafetyRouteDependencies> = {},
): Promise<void> {
  const repository = overrides.repository ?? prismaSafetyRepository;

  app.post<{ Params: UserParams }>(
    '/users/:userId/block',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      schema: {
        tags: ['Safety'],
        summary: 'Block a user and close pending connection requests',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: blockSchema },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const block = await blockUser(user.id, request.params.userId, repository);
      return { data: presentBlock(block) };
    },
  );

  app.delete<{ Params: UserParams }>(
    '/users/:userId/block',
    {
      schema: {
        tags: ['Safety'],
        summary: 'Unblock a user',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      await repository.unblockUser(user.id, request.params.userId);
      return reply.code(204).send();
    },
  );

  app.get<{ Querystring: PageQuery }>(
    '/me/blocked-users',
    {
      schema: {
        tags: ['Safety'],
        summary: 'List users blocked by the authenticated user',
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
              data: { type: 'array', items: blockSchema },
              pagination: paginationSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const query: ListBlocksQuery = {
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
      };
      const result = await repository.listBlocks(user.id, query);
      return {
        data: result.blocks.map(presentBlock),
        pagination: pagination(query.page, query.pageSize, result.totalItems),
      };
    },
  );

  app.post<{
    Body: {
      targetType: ReportTargetType;
      targetId: string;
      reason: ReportReason;
      details?: string;
    };
  }>(
    '/reports',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        tags: ['Safety'],
        summary: 'Report a user or platform content',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['targetType', 'targetId', 'reason'],
          properties: {
            targetType: { type: 'string', enum: reportTargetTypes },
            targetId: { type: 'string', format: 'uuid' },
            reason: { type: 'string', enum: reportReasons },
            details: { type: 'string', maxLength: 1000 },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['data'],
            properties: { data: reportSchema },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      const report = await createReport(
        user.id,
        request.body as CreateReportBody,
        repository,
      );
      return reply.code(201).send({ data: presentReport(report) });
    },
  );

  app.get<{ Querystring: ReportListQuery }>(
    '/me/reports',
    {
      schema: {
        tags: ['Safety'],
        summary: 'List reports submitted by the authenticated user',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...paginationQuerySchema,
            status: { type: 'string', enum: reportStatuses },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: reportSchema },
              pagination: paginationSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const query: ListReportsQuery = {
        ...(request.query.status && { status: request.query.status }),
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
      };
      const result = await repository.listReports(user.id, query);
      return {
        data: result.reports.map(presentReport),
        pagination: pagination(query.page, query.pageSize, result.totalItems),
      };
    },
  );
}
