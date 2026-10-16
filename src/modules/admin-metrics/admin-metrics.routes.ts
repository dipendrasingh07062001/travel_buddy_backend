import type { FastifyInstance } from 'fastify';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { prismaAdminMetricsRepository } from './admin-metrics.repository.js';
import {
  accountMetricStatuses,
  connectionMetricStatuses,
  metricWindows,
  reportMetricStatuses,
  tripMetricStatuses,
  type AdminMetricsDependencies,
  type MetricWindowDays,
} from './admin-metrics.types.js';

const countSchema = { type: 'integer', minimum: 0 } as const;
function countsSchema(statuses: readonly string[], withBacklog = false) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'total',
      'byStatus',
      'createdInWindow',
      ...(withBacklog ? ['open'] : []),
    ],
    properties: {
      total: countSchema,
      createdInWindow: countSchema,
      byStatus: {
        type: 'object',
        additionalProperties: false,
        required: [...statuses],
        properties: Object.fromEntries(
          statuses.map((status) => [status, countSchema]),
        ),
      },
      ...(withBacklog && { open: countSchema }),
    },
  };
}

export async function registerAdminMetricsRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<AdminMetricsDependencies> = {},
) {
  const repository = overrides.repository ?? prismaAdminMetricsRepository;
  app.get<{ Querystring: { days?: MetricWindowDays } }>(
    '/admin/metrics/overview',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Admin metrics'],
        summary: 'Read aggregate operational counts as an active administrator',
        description:
          'Current retained-record totals and status breakdowns, plus creations in a rolling 7/30/90-day UTC window. Not DAU, historical status transitions or conversion analytics. Deleted accounts are excluded; retained trips/requests/reports include non-public records. No personal data or user-level filters.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: { type: 'integer', enum: metricWindows, default: 30 },
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
                  'generatedAt',
                  'window',
                  'accounts',
                  'trips',
                  'connectionRequests',
                  'reports',
                ],
                properties: {
                  generatedAt: { type: 'string', format: 'date-time' },
                  window: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['days', 'from', 'to'],
                    properties: {
                      days: { type: 'integer', enum: metricWindows },
                      from: { type: 'string', format: 'date-time' },
                      to: { type: 'string', format: 'date-time' },
                    },
                  },
                  accounts: countsSchema(accountMetricStatuses),
                  trips: countsSchema(tripMetricStatuses),
                  connectionRequests: countsSchema(connectionMetricStatuses),
                  reports: countsSchema(reportMetricStatuses, true),
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
      return {
        data: await repository.readOverview(user.id, request.query.days ?? 30),
      };
    },
  );
}
