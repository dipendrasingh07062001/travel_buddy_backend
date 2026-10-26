import type { FastifyInstance } from 'fastify';

import type { AccountRestriction } from '../../generated/prisma/client.js';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  cleanReason,
  reasonSchema,
  restrictionInputSchema,
  staffIdentity,
  userParams,
} from './moderation.routes.js';
import {
  isActive,
  listAccountRestrictions,
  listActiveRestrictions,
  liftRestriction,
  restrictFeatureDirect,
  restrictedFeatures,
  type RestrictionInput,
} from './restriction.repository.js';

interface UserParams {
  userId: string;
}

interface RestrictionParams {
  restrictionId: string;
}

type RestrictBody = RestrictionInput & { reason: string };

const timestamp = { type: 'string', format: 'date-time' } as const;
const nullableTimestamp = { anyOf: [timestamp, { type: 'null' }] } as const;
const nullableUuid = {
  anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
} as const;

const userRestrictionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'feature', 'startsAt', 'endsAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    feature: { type: 'string', enum: restrictedFeatures },
    startsAt: timestamp,
    endsAt: {
      ...nullableTimestamp,
      description: 'null: until a moderator lifts it.',
    },
  },
} as const;

const staffRestrictionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...userRestrictionSchema.required,
    'userId',
    'active',
    'reason',
    'reportId',
    'createdById',
    'liftedAt',
    'liftedById',
    'liftReason',
  ],
  properties: {
    ...userRestrictionSchema.properties,
    userId: { type: 'string', format: 'uuid' },
    active: { type: 'boolean' },
    reason: { type: 'string' },
    reportId: nullableUuid,
    createdById: { type: 'string', format: 'uuid' },
    liftedAt: nullableTimestamp,
    liftedById: nullableUuid,
    liftReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const;

function presentForStaff(restriction: AccountRestriction) {
  return {
    id: restriction.id,
    userId: restriction.userId,
    feature: restriction.feature,
    active: isActive(restriction),
    startsAt: restriction.startsAt.toISOString(),
    endsAt: restriction.endsAt?.toISOString() ?? null,
    reason: restriction.reason,
    reportId: restriction.reportId,
    createdById: restriction.createdById,
    liftedAt: restriction.liftedAt?.toISOString() ?? null,
    liftedById: restriction.liftedById,
    liftReason: restriction.liftReason,
  };
}

export async function registerRestrictionRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
) {
  app.post<{ Params: UserParams; Body: RestrictBody }>(
    '/admin/users/:userId/restrictions',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'Restrict one feature for an account, with an audit reason',
        description:
          'Blocks one feature for 1–90 days, or until lifted when durationDays is omitted. One active restriction per feature. The account is notified without the reason.',
        security: [{ bearerAuth: [] }],
        params: userParams,
        body: {
          ...restrictionInputSchema,
          required: ['feature', 'reason'],
          properties: {
            ...restrictionInputSchema.properties,
            ...reasonSchema.properties,
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['data'],
            properties: { data: staffRestrictionSchema },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId, role } = await staffIdentity(request, auth);
      const restriction = await restrictFeatureDirect({
        userId: request.params.userId,
        actorId: userId,
        actorRole: role,
        feature: request.body.feature,
        ...(request.body.durationDays !== undefined && {
          durationDays: request.body.durationDays,
        }),
        reason: cleanReason(request.body.reason),
      });
      return reply.code(201).send({ data: presentForStaff(restriction) });
    },
  );

  app.get<{ Params: UserParams }>(
    '/admin/users/:userId/restrictions',
    {
      schema: {
        tags: ['Moderation'],
        summary: "List an account's current and past feature restrictions",
        security: [{ bearerAuth: [] }],
        params: userParams,
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: { type: 'array', items: staffRestrictionSchema },
            },
          },
        },
      },
    },
    async (request) => {
      await staffIdentity(request, auth);
      const restrictions = await listAccountRestrictions(request.params.userId);
      return { data: restrictions.map(presentForStaff) };
    },
  );

  app.post<{ Params: RestrictionParams; Body: { reason: string } }>(
    '/admin/restrictions/:restrictionId/lift',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'Lift an active feature restriction early',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['restrictionId'],
          properties: { restrictionId: { type: 'string', format: 'uuid' } },
        },
        body: reasonSchema,
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: staffRestrictionSchema },
          },
        },
      },
    },
    async (request) => {
      const { userId, role } = await staffIdentity(request, auth);
      const restriction = await liftRestriction({
        restrictionId: request.params.restrictionId,
        actorId: userId,
        actorRole: role,
        reason: cleanReason(request.body.reason),
      });
      return { data: presentForStaff(restriction) };
    },
  );

  app.get(
    '/me/restrictions',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'List the active feature restrictions on your account',
        description:
          'Shows which features are restricted and until when. Reasons and staff details are not included.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: { type: 'array', items: userRestrictionSchema },
            },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const restrictions = await listActiveRestrictions(user.id);
      return {
        data: restrictions.map((restriction) => ({
          id: restriction.id,
          feature: restriction.feature,
          startsAt: restriction.startsAt.toISOString(),
          endsAt: restriction.endsAt?.toISOString() ?? null,
        })),
      };
    },
  );
}
