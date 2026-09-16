import type { FastifyInstance } from 'fastify';

export interface HealthRouteDependencies {
  checkReadiness: () => Promise<void>;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: HealthRouteDependencies,
): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Check whether the API process is running',
        response: {
          200: {
            type: 'object',
            required: ['status', 'timestamp', 'uptimeSeconds'],
            properties: {
              status: { type: 'string', const: 'ok' },
              timestamp: { type: 'string', format: 'date-time' },
              uptimeSeconds: { type: 'number' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    }),
  );

  app.get(
    '/readiness',
    {
      schema: {
        tags: ['System'],
        summary: 'Check whether the API dependencies are ready',
        response: {
          200: {
            type: 'object',
            required: ['status', 'checks'],
            properties: {
              status: { type: 'string', const: 'ready' },
              checks: {
                type: 'object',
                required: ['database'],
                properties: {
                  database: { type: 'string', const: 'up' },
                },
              },
            },
          },
          503: {
            type: 'object',
            required: ['status', 'checks'],
            properties: {
              status: { type: 'string', const: 'not_ready' },
              checks: {
                type: 'object',
                required: ['database'],
                properties: {
                  database: { type: 'string', const: 'down' },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      try {
        await dependencies.checkReadiness();
        return {
          status: 'ready' as const,
          checks: { database: 'up' as const },
        };
      } catch (error) {
        app.log.error({ error }, 'Readiness check failed');
        return reply.code(503).send({
          status: 'not_ready' as const,
          checks: { database: 'down' as const },
        });
      }
    },
  );
}
