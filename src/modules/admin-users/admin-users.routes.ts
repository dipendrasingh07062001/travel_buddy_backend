import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/app-error.js';
import type {
  IdentityType,
  StaffRole,
  UserStatus,
} from '../../generated/prisma/client.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  pagination,
  staffIdentity,
  userParams,
} from '../moderation/moderation.routes.js';
import { restrictedFeatures } from '../moderation/restriction.repository.js';
import { prismaAdminUserRepository } from './admin-users.repository.js';
import {
  normalizeContact,
  parseSearchQuery,
  safeFailure,
} from './admin-users.service.js';
import {
  contactTypes,
  staffRoles,
  userStatuses,
  type AdminUserDependencies,
  type AdminUserDetail,
  type AdminUserRepository,
  type AdminUserSummary,
} from './admin-users.types.js';

interface SearchQuery {
  query?: string;
  status?: UserStatus;
  staffRole?: StaffRole;
  page?: number;
  pageSize?: number;
}

interface UserParams {
  userId: string;
}

interface LookupBody {
  type: IdentityType;
  value: string;
}

const summarySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'displayName',
    'status',
    'staffRole',
    'createdAt',
    'hasProfilePhoto',
    'activeRestrictions',
    'openReportCount',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    status: { type: 'string', enum: userStatuses },
    staffRole: { type: 'string', enum: staffRoles },
    createdAt: { type: 'string', format: 'date-time' },
    hasProfilePhoto: { type: 'boolean' },
    activeRestrictions: {
      type: 'array',
      items: { type: 'string', enum: restrictedFeatures },
    },
    openReportCount: { type: 'integer', minimum: 0 },
  },
} as const;

const nullableDate = {
  anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
} as const;

function closedObject<const P extends Record<string, unknown>>(properties: P) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties) as Array<keyof P & string>,
    properties,
  } as const;
}

const countSchema = { type: 'integer', minimum: 0 } as const;
const statusCountsSchema = closedObject({
  submitted: countSchema,
  underReview: countSchema,
  actioned: countSchema,
  dismissed: countSchema,
});

const detailSchema = closedObject({
  account: closedObject({
    id: { type: 'string', format: 'uuid' },
    displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    status: { type: 'string', enum: userStatuses },
    staffRole: { type: 'string', enum: staffRoles },
    createdAt: { type: 'string', format: 'date-time' },
    deletedAt: nullableDate,
    recordsPurgedAt: nullableDate,
    statusBeforeDeletion: {
      anyOf: [{ type: 'string', enum: userStatuses }, { type: 'null' }],
    },
    hasProfilePhoto: { type: 'boolean' },
    hasVerifiedEmail: { type: 'boolean' },
    hasVerifiedPhone: { type: 'boolean' },
  }),
  activeRestrictions: {
    type: 'array',
    items: closedObject({
      id: { type: 'string', format: 'uuid' },
      feature: { type: 'string', enum: restrictedFeatures },
      startsAt: { type: 'string', format: 'date-time' },
      endsAt: nullableDate,
    }),
  },
  reports: closedObject({
    aboutAccount: statusCountsSchema,
    filed: statusCountsSchema,
  }),
  claimedReportCount: countSchema,
  content: closedObject({
    trips: countSchema,
    communityPosts: closedObject({
      draft: countSchema,
      published: countSchema,
      removed: countSchema,
    }),
    communityComments: closedObject({
      visible: countSchema,
      removed: countSchema,
    }),
    blockedByCount: countSchema,
  }),
  openDataRequests: {
    anyOf: [
      {
        type: 'array',
        items: closedObject({
          id: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['ACCESS', 'ACCOUNT_DELETION'] },
          createdAt: { type: 'string', format: 'date-time' },
          scheduledFor: nullableDate,
        }),
      },
      { type: 'null' },
    ],
  },
});

const paginationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['page', 'pageSize', 'totalItems', 'totalPages'],
  properties: {
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    totalItems: { type: 'integer' },
    totalPages: { type: 'integer' },
  },
} as const;

// Searched names and contacts must not reach logs, so the request line keeps
// Fastify's default fields but drops the query string from the URL.
const logSerializers = {
  req(request: FastifyRequest) {
    return {
      method: request.method,
      url: request.url.split('?')[0],
      version: request.headers['accept-version'],
      host: request.host,
      remoteAddress: request.ip,
      remotePort: request.socket?.remotePort,
    };
  },
};

// Database errors can quote the searched value, so they are replaced by a
// fixed error before the shared handler logs them.
async function guard<T>(
  request: FastifyRequest,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    request.log.error(
      { event: 'admin_user_query_failed', ...safeFailure(error) },
      'Admin user query failed',
    );
    throw new AppError(
      500,
      'INTERNAL_SERVER_ERROR',
      'An unexpected error occurred.',
    );
  }
}

function present(user: AdminUserSummary) {
  return { ...user, createdAt: user.createdAt.toISOString() };
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

function presentDetail(detail: AdminUserDetail) {
  const { account } = detail;
  return {
    ...detail,
    account: {
      ...account,
      createdAt: account.createdAt.toISOString(),
      deletedAt: iso(account.deletedAt),
      recordsPurgedAt: iso(account.recordsPurgedAt),
    },
    activeRestrictions: detail.activeRestrictions.map((restriction) => ({
      ...restriction,
      startsAt: restriction.startsAt.toISOString(),
      endsAt: iso(restriction.endsAt),
    })),
    openDataRequests:
      detail.openDataRequests?.map((request) => ({
        ...request,
        createdAt: request.createdAt.toISOString(),
        scheduledFor: iso(request.scheduledFor),
      })) ?? null,
  };
}

export async function registerAdminUserRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<AdminUserDependencies> = {},
) {
  const repository = overrides.repository ?? prismaAdminUserRepository;
  // A scope of their own, so the serializer and the header apply only here.
  await app.register(
    async (scope) => registerScopedRoutes(scope, auth, repository),
    {
      // Fastify's types expect string results; pino accepts objects.
      logSerializers: logSerializers as unknown as Record<
        string,
        (value: unknown) => string
      >,
    },
  );
}

async function registerScopedRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  repository: AdminUserRepository,
) {
  // onSend also runs for error and rate-limit replies.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.get<{ Querystring: SearchQuery }>(
    '/admin/users',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Moderation'],
        summary: 'Search accounts by ID or display name (staff only)',
        description:
          'A UUID matches the account ID; other text matches part of the display name, case-insensitively. Deleted accounts are left out unless status=DELETED. Use POST /admin/users/lookup for email or phone. Never returns contact details or moderation reasons.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 100 },
            status: { type: 'string', enum: userStatuses },
            staffRole: { type: 'string', enum: staffRoles },
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
            additionalProperties: false,
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: summarySchema },
              pagination: paginationSchema,
            },
          },
        },
      },
    },
    async (request) => {
      await staffIdentity(request, auth);
      const {
        query,
        status,
        staffRole,
        page = 1,
        pageSize = 20,
      } = request.query;
      const match = parseSearchQuery(query);
      const result = await guard(request, () =>
        repository.search({
          ...(match && { match }),
          ...(status && { status }),
          ...(staffRole && { staffRole }),
          page,
          pageSize,
        }),
      );
      return {
        data: result.users.map(present),
        pagination: pagination(page, pageSize, result.totalItems),
      };
    },
  );

  app.get<{ Params: UserParams }>(
    '/admin/users/:userId',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Moderation'],
        summary: "One account's moderation detail (staff only)",
        description:
          "Account state, verified-contact flags (never the values), active restrictions, counts of reports about the account, filed by it and claimed by it, and content counts. Reports on the account's trips, posts, comments, messages or connection requests are not counted; open a report to see whose content it is. openDataRequests is null for moderators. Views are not audited.",
        security: [{ bearerAuth: [] }],
        params: userParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: { data: detailSchema },
          },
        },
      },
    },
    async (request) => {
      const { role } = await staffIdentity(request, auth);
      const detail = await guard(request, () =>
        repository.detail({
          userId: request.params.userId,
          includeDataRequests: role === 'ADMIN',
        }),
      );
      if (!detail) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
      }
      return { data: presentDetail(detail) };
    },
  );

  app.post<{ Body: LookupBody }>(
    '/admin/users/lookup',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Moderation'],
        summary:
          'Find the account that owns a stored email or phone (staff only)',
        description:
          'Exact match on a stored contact: verified emails (any letter case) and phone numbers in E.164 form. A match is recorded in the moderation audit trail without the searched value. The value is never returned.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'value'],
          properties: {
            type: { type: 'string', enum: contactTypes },
            value: { type: 'string', minLength: 3, maxLength: 320 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: { anyOf: [summarySchema, { type: 'null' }] },
            },
          },
        },
      },
    },
    async (request) => {
      const { userId } = await staffIdentity(request, auth);
      const { type } = request.body;
      const value = normalizeContact(type, request.body.value);
      let outcome: 'hit' | 'miss' | 'failed' = 'failed';
      try {
        const user = await guard(request, () =>
          repository.lookup({ actorId: userId, type, value }),
        );
        outcome = user ? 'hit' : 'miss';
        return { data: user ? present(user) : null };
      } finally {
        request.log.info(
          {
            event: 'admin_user_lookup',
            staffId: userId,
            contactType: type,
            outcome,
          },
          'Admin user lookup',
        );
      }
    },
  );
}
