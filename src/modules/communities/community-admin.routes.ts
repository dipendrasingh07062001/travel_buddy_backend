import type { FastifyInstance, FastifyRequest } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  requireAdmin,
  requireStaff,
} from '../moderation/moderation.repository.js';
import {
  changeCommunityStatus,
  createAdminCommunity,
  findAdminCommunity,
  listAdminCommunities,
  listCommunityAdminActions,
  mergeAdminCommunities,
  updateAdminCommunity,
} from './community-admin.repository.js';
import {
  cleanAdminReason,
  cleanCreateMetadata,
  cleanMetadataPatch,
  cleanSlug,
  type CommunityMetadataBody,
  type CreateCommunityBody,
} from './community-admin.service.js';

interface PageQuery {
  page?: number;
  pageSize?: number;
}

interface CommunityListQuery extends PageQuery {
  search?: string;
  status?: 'ACTIVE' | 'ARCHIVED';
}

interface ActionListQuery extends PageQuery {
  communityId?: string;
}

interface CommunityParams {
  communityId: string;
}

interface ChangeBody {
  expectedVersion: number;
  reason: string;
}

interface UpdateBody extends CommunityMetadataBody, ChangeBody {}

interface MergeBody extends ChangeBody {
  targetCommunityId: string;
  expectedTargetVersion: number;
}

const pageProperties = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
} as const;

const metadataProperties = {
  name: { type: 'string', minLength: 2, maxLength: 120 },
  region: {
    anyOf: [{ type: 'string', minLength: 2, maxLength: 120 }, { type: 'null' }],
  },
  countryCode: { type: 'string', pattern: '^[A-Za-z]{2}$' },
  description: {
    anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }],
  },
} as const;

const changeProperties = {
  expectedVersion: { type: 'integer', minimum: 1 },
  reason: { type: 'string', minLength: 10, maxLength: 1000 },
} as const;

const communityParams = {
  type: 'object',
  required: ['communityId'],
  properties: { communityId: { type: 'string', format: 'uuid' } },
} as const;

const adminCommunitySchema = {
  type: 'object',
  required: [
    'id',
    'slug',
    'name',
    'region',
    'countryCode',
    'description',
    'status',
    'version',
    'mergedIntoId',
    'createdAt',
    'updatedAt',
    '_count',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    region: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    countryCode: { type: 'string' },
    description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] },
    version: { type: 'integer' },
    mergedIntoId: {
      anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    _count: {
      type: 'object',
      required: ['trips', 'posts', 'followers', 'mergedFrom'],
      properties: {
        trips: { type: 'integer' },
        posts: { type: 'integer' },
        followers: { type: 'integer' },
        mergedFrom: { type: 'integer' },
      },
    },
  },
} as const;

const oneCommunityResponse = {
  type: 'object',
  required: ['data'],
  properties: { data: adminCommunitySchema },
} as const;

async function adminIdentity(
  request: FastifyRequest,
  auth: AuthRouteDependencies,
): Promise<string> {
  const user = await authenticateRequest(request, auth);
  requireAdmin(await requireStaff(user.id));
  return user.id;
}

function pagination(page: number, pageSize: number, totalItems: number) {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}

export async function registerCommunityAdminRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
): Promise<void> {
  app.get<{ Querystring: CommunityListQuery }>(
    '/admin/communities',
    {
      schema: {
        tags: ['Community administration'],
        summary: 'List active and archived destination communities',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...pageProperties,
            search: { type: 'string', minLength: 1, maxLength: 120 },
            status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: adminCommunitySchema },
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
      await adminIdentity(request, auth);
      const { page = 1, pageSize = 20, status, search } = request.query;
      const result = await listAdminCommunities(
        status,
        search?.trim() || undefined,
        page,
        pageSize,
      );
      return {
        data: result.communities,
        pagination: pagination(page, pageSize, result.totalItems),
      };
    },
  );

  app.get<{ Params: CommunityParams }>(
    '/admin/communities/:communityId',
    {
      schema: {
        tags: ['Community administration'],
        summary: 'Inspect one destination community',
        security: [{ bearerAuth: [] }],
        params: communityParams,
        response: { 200: oneCommunityResponse },
      },
    },
    async (request) => {
      await adminIdentity(request, auth);
      return { data: await findAdminCommunity(request.params.communityId) };
    },
  );

  app.post<{ Body: CreateCommunityBody }>(
    '/admin/communities',
    {
      schema: {
        tags: ['Community administration'],
        summary: 'Create an active destination community',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['slug', 'name'],
          properties: {
            slug: { type: 'string', minLength: 1, maxLength: 120 },
            ...metadataProperties,
          },
        },
        response: { 201: oneCommunityResponse },
      },
    },
    async (request, reply) => {
      const actorId = await adminIdentity(request, auth);
      const community = await createAdminCommunity(
        actorId,
        cleanSlug(request.body.slug),
        cleanCreateMetadata(request.body),
      );
      return reply.code(201).send({ data: community });
    },
  );

  app.patch<{ Params: CommunityParams; Body: UpdateBody }>(
    '/admin/communities/:communityId',
    {
      schema: {
        tags: ['Community administration'],
        summary: 'Update destination metadata (slug remains stable)',
        security: [{ bearerAuth: [] }],
        params: communityParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion', 'reason'],
          properties: { ...metadataProperties, ...changeProperties },
        },
        response: { 200: oneCommunityResponse },
      },
    },
    async (request) => {
      const actorId = await adminIdentity(request, auth);
      return {
        data: await updateAdminCommunity(
          actorId,
          request.params.communityId,
          request.body.expectedVersion,
          cleanMetadataPatch(request.body),
          cleanAdminReason(request.body.reason),
        ),
      };
    },
  );

  for (const [path, status] of [
    ['archive', 'ARCHIVED'],
    ['reactivate', 'ACTIVE'],
  ] as const) {
    app.post<{ Params: CommunityParams; Body: ChangeBody }>(
      `/admin/communities/:communityId/${path}`,
      {
        schema: {
          tags: ['Community administration'],
          summary: `${path === 'archive' ? 'Archive an empty' : 'Reactivate an archived'} destination community`,
          security: [{ bearerAuth: [] }],
          params: communityParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedVersion', 'reason'],
            properties: changeProperties,
          },
          response: { 200: oneCommunityResponse },
        },
      },
      async (request) => {
        const actorId = await adminIdentity(request, auth);
        return {
          data: await changeCommunityStatus(
            actorId,
            request.params.communityId,
            request.body.expectedVersion,
            status,
            cleanAdminReason(request.body.reason),
          ),
        };
      },
    );
  }

  app.post<{ Params: CommunityParams; Body: MergeBody }>(
    '/admin/communities/:communityId/merge',
    {
      schema: {
        tags: ['Community administration'],
        summary:
          'Merge a duplicate destination into an active canonical community',
        security: [{ bearerAuth: [] }],
        params: communityParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'targetCommunityId',
            'expectedVersion',
            'expectedTargetVersion',
            'reason',
          ],
          properties: {
            ...changeProperties,
            targetCommunityId: { type: 'string', format: 'uuid' },
            expectedTargetVersion: { type: 'integer', minimum: 1 },
          },
        },
        response: { 200: oneCommunityResponse },
      },
    },
    async (request) => {
      const actorId = await adminIdentity(request, auth);
      return {
        data: await mergeAdminCommunities(
          actorId,
          request.params.communityId,
          request.body.targetCommunityId,
          request.body.expectedVersion,
          request.body.expectedTargetVersion,
          cleanAdminReason(request.body.reason),
        ),
      };
    },
  );

  app.get<{ Querystring: ActionListQuery }>(
    '/admin/community-actions',
    {
      schema: {
        tags: ['Community administration'],
        summary: 'Read the destination administration audit trail',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...pageProperties,
            communityId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      await adminIdentity(request, auth);
      const { page = 1, pageSize = 20, communityId } = request.query;
      const result = await listCommunityAdminActions(
        communityId,
        page,
        pageSize,
      );
      return {
        data: result.actions,
        pagination: pagination(page, pageSize, result.totalItems),
      };
    },
  );
}
