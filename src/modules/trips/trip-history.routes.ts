import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors/app-error.js';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  prismaTripHistoryRepository,
  type TripHistoryQuery,
  type TripHistoryRepository,
} from './trip-history.repository.js';

export async function registerTripHistoryRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  repository: TripHistoryRepository = prismaTripHistoryRepository,
) {
  app.get<{
    Params: { tripId: string };
    Querystring: Partial<TripHistoryQuery>;
  }>(
    '/trips/:tripId/history',
    {
      schema: {
        tags: ['Trips'],
        summary: 'Read recorded trip changes as the owner or a current member',
        description:
          'Newest version first. Members see changes only since their latest join; descriptions are never copied. Historical changes before this feature are not backfilled.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['tripId'],
          additionalProperties: false,
          properties: { tripId: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageSize: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 20,
            },
            beforeVersion: { type: 'integer', minimum: 1, maximum: 2147483647 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data', 'currentVersion', 'pagination'],
            properties: {
              currentVersion: { type: 'integer' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'id',
                    'version',
                    'action',
                    'changes',
                    'createdAt',
                    'actor',
                  ],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    version: { type: 'integer' },
                    action: { type: 'string' },
                    changes: { type: 'object', additionalProperties: true },
                    createdAt: { type: 'string', format: 'date-time' },
                    actor: {
                      anyOf: [
                        { type: 'null' },
                        {
                          type: 'object',
                          additionalProperties: false,
                          required: ['id', 'displayName'],
                          properties: {
                            id: { type: 'string', format: 'uuid' },
                            displayName: {
                              anyOf: [{ type: 'null' }, { type: 'string' }],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
              pagination: {
                type: 'object',
                required: ['pageSize', 'nextBeforeVersion'],
                properties: {
                  pageSize: { type: 'integer' },
                  nextBeforeVersion: {
                    anyOf: [{ type: 'null' }, { type: 'integer' }],
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const user = await authenticateRequest(request, auth);
      const result = await repository.list(request.params.tripId, user.id, {
        ...request.query,
        pageSize: request.query.pageSize ?? 20,
      });
      if (!result) throw new AppError(404, 'TRIP_NOT_FOUND', 'Trip not found.');
      return result;
    },
  );
}
