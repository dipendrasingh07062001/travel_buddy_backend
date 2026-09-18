import type { FastifyInstance } from 'fastify';

import { presentAuthenticatedUser } from './auth.presenter.js';
import {
  authenticateRequest,
  requireActiveUser,
  verifyRequestIdentity,
} from './auth.service.js';
import type { AuthRouteDependencies } from './auth.types.js';
import { privateUserSchema } from '../profiles/profile.schemas.js';

const bearerSecurity = [{ bearerAuth: [] }];

export async function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): Promise<void> {
  app.post(
    '/auth/bootstrap',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Authentication'],
        summary: 'Create or retrieve the local account for a Firebase user',
        security: bearerSecurity,
        response: {
          200: {
            type: 'object',
            required: ['data', 'created'],
            properties: {
              data: privateUserSchema,
              created: { type: 'boolean' },
            },
          },
          201: {
            type: 'object',
            required: ['data', 'created'],
            properties: {
              data: privateUserSchema,
              created: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = await verifyRequestIdentity(
        request,
        dependencies.tokenVerifier,
      );
      const result =
        await dependencies.repository.bootstrapFirebaseUser(identity);
      const user = requireActiveUser(result.user);
      return reply.code(result.created ? 201 : 200).send({
        data: presentAuthenticatedUser(user),
        created: result.created,
      });
    },
  );

  app.get(
    '/me',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Get the current authenticated user',
        security: bearerSecurity,
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: privateUserSchema },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, dependencies);
      return { data: presentAuthenticatedUser(user) };
    },
  );
}
