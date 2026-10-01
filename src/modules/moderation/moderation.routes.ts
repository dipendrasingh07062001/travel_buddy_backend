import type { ReportStatus } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/app-error.js';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  findStaffReportDetail,
  listModerationActions,
  listStaffReports,
  requireAdmin,
  requireStaff,
  resolveReport,
  restoreAccount,
  startReportReview,
  suspendAccountDirect,
} from './moderation.repository.js';

interface PageQuery {
  page?: number;
  pageSize?: number;
}

interface ReportQuery extends PageQuery {
  status?: ReportStatus;
}

interface ReportParams {
  reportId: string;
}

interface UserParams {
  userId: string;
}

interface ReasonBody {
  reason: string;
}

interface ResolveBody extends ReasonBody {
  resolution: 'DISMISS' | 'SUSPEND_USER' | 'REMOVE_CONTENT';
}

const pageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
} as const;

const reasonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { type: 'string', minLength: 10, maxLength: 1000 } },
} as const;

const reportParams = {
  type: 'object',
  required: ['reportId'],
  properties: { reportId: { type: 'string', format: 'uuid' } },
} as const;

const userParams = {
  type: 'object',
  required: ['userId'],
  properties: { userId: { type: 'string', format: 'uuid' } },
} as const;

async function staffIdentity(
  request: FastifyRequest,
  auth: AuthRouteDependencies,
) {
  const user = await authenticateRequest(request, auth);
  const role = await requireStaff(user.id);
  return { userId: user.id, role };
}

function pagination(page: number, pageSize: number, totalItems: number) {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}

function cleanReason(reason: string): string {
  const value = reason.trim();
  if (value.length < 10) {
    throw new AppError(
      400,
      'INVALID_MODERATION_REASON',
      'A moderation reason must contain at least 10 non-space characters.',
    );
  }
  return value;
}

export async function registerModerationRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
) {
  app.get<{ Querystring: ReportQuery }>(
    '/admin/reports',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'List reports for authorized staff',
        security: [{ bearerAuth: [] }],
        querystring: {
          ...pageSchema,
          properties: {
            ...pageSchema.properties,
            status: {
              type: 'string',
              enum: ['SUBMITTED', 'UNDER_REVIEW', 'ACTIONED', 'DISMISSED'],
            },
          },
        },
      },
    },
    async (request) => {
      await staffIdentity(request, auth);
      const { page = 1, pageSize = 20, status } = request.query;
      const result = await listStaffReports(status, page, pageSize);
      return {
        data: result.reports,
        pagination: pagination(page, pageSize, result.totalItems),
      };
    },
  );

  app.get<{ Params: ReportParams }>(
    '/admin/reports/:reportId',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'Inspect a report and its target',
        security: [{ bearerAuth: [] }],
        params: reportParams,
      },
    },
    async (request) => {
      const { userId } = await staffIdentity(request, auth);
      return {
        data: await findStaffReportDetail(request.params.reportId, userId),
      };
    },
  );

  app.post<{ Params: ReportParams }>(
    '/admin/reports/:reportId/start-review',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'Claim a submitted report for review',
        security: [{ bearerAuth: [] }],
        params: reportParams,
      },
    },
    async (request) => {
      const { userId } = await staffIdentity(request, auth);
      return { data: await startReportReview(request.params.reportId, userId) };
    },
  );

  app.post<{ Params: ReportParams; Body: ResolveBody }>(
    '/admin/reports/:reportId/resolve',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'Resolve a report with an audited decision',
        security: [{ bearerAuth: [] }],
        params: reportParams,
        body: {
          ...reasonSchema,
          required: ['resolution', 'reason'],
          properties: {
            ...reasonSchema.properties,
            resolution: {
              type: 'string',
              enum: ['DISMISS', 'SUSPEND_USER', 'REMOVE_CONTENT'],
            },
          },
        },
      },
    },
    async (request) => {
      const { userId, role } = await staffIdentity(request, auth);
      return {
        data: await resolveReport(
          request.params.reportId,
          userId,
          role,
          request.body.resolution,
          cleanReason(request.body.reason),
        ),
      };
    },
  );

  app.post<{ Params: UserParams; Body: ReasonBody }>(
    '/admin/users/:userId/suspend',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'Suspend an active account with an audit reason',
        security: [{ bearerAuth: [] }],
        params: userParams,
        body: reasonSchema,
      },
    },
    async (request) => {
      const { userId, role } = await staffIdentity(request, auth);
      return {
        data: await suspendAccountDirect(
          request.params.userId,
          userId,
          role,
          cleanReason(request.body.reason),
        ),
      };
    },
  );

  app.post<{ Params: UserParams; Body: ReasonBody }>(
    '/admin/users/:userId/restore',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'Restore a suspended account (administrators only)',
        security: [{ bearerAuth: [] }],
        params: userParams,
        body: reasonSchema,
      },
    },
    async (request) => {
      const { userId, role } = await staffIdentity(request, auth);
      requireAdmin(role);
      return {
        data: await restoreAccount(
          request.params.userId,
          userId,
          cleanReason(request.body.reason),
        ),
      };
    },
  );

  app.get<{ Querystring: PageQuery }>(
    '/admin/moderation-actions',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'Read the moderation audit trail (administrators only)',
        security: [{ bearerAuth: [] }],
        querystring: pageSchema,
      },
    },
    async (request) => {
      const { role } = await staffIdentity(request, auth);
      requireAdmin(role);
      const { page = 1, pageSize = 20 } = request.query;
      const result = await listModerationActions(page, pageSize);
      return {
        data: result.actions,
        pagination: pagination(page, pageSize, result.totalItems),
      };
    },
  );
}
