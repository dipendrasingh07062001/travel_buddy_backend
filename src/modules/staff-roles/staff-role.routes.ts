import type { FastifyInstance } from 'fastify';

import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { staffRoles } from '../admin-users/admin-users.types.js';
import { requireAdmin } from '../moderation/moderation.repository.js';
import {
  cleanReason,
  reasonSchema,
  staffIdentity,
  userParams,
} from '../moderation/moderation.routes.js';
import { prismaStaffRoleRepository } from './staff-role.repository.js';
import {
  assignableRoles,
  type AssignableRole,
  type StaffRoleDependencies,
  type StaffRoleRepository,
} from './staff-role.types.js';

interface UserParams {
  userId: string;
}

interface StaffRoleBody {
  role: AssignableRole;
  reason: string;
}

export async function registerStaffRoleRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<StaffRoleDependencies> = {},
) {
  const repository = overrides.repository ?? prismaStaffRoleRepository;
  // A scope of its own, so the header applies only here.
  await app.register(async (scope) =>
    registerScopedRoutes(scope, auth, repository),
  );
}

async function registerScopedRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  repository: StaffRoleRepository,
) {
  // onSend also runs for error and rate-limit replies.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.post<{ Params: UserParams; Body: StaffRoleBody }>(
    '/admin/users/:userId/staff-role',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Moderation'],
        summary: 'Grant or remove the moderator role (administrators only)',
        description:
          'role MODERATOR grants the moderator role to an active account; role USER removes it. Administrator accounts and your own account cannot be changed here; administrators are managed with the database CLI. Repeating a request changes nothing and returns changed: false. claimedReportCount is the number of reports the account still has under review.',
        security: [{ bearerAuth: [] }],
        params: userParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['role', 'reason'],
          properties: {
            role: { type: 'string', enum: assignableRoles },
            reason: reasonSchema.properties.reason,
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'userId',
                  'staffRole',
                  'changed',
                  'claimedReportCount',
                ],
                properties: {
                  userId: { type: 'string', format: 'uuid' },
                  staffRole: { type: 'string', enum: staffRoles },
                  changed: { type: 'boolean' },
                  claimedReportCount: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { userId, role } = await staffIdentity(request, auth);
      requireAdmin(role);
      const reason = cleanReason(request.body.reason);
      return {
        data: await repository.change({
          actorId: userId,
          targetId: request.params.userId,
          role: request.body.role,
          reason,
        }),
      };
    },
  );
}
