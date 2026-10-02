import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { authenticateRequestIncludingSuspended } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { createAccountDataExport } from './data-export.repository.js';

export async function registerDataExportRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
): Promise<void> {
  app.post(
    '/me/data-export',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
          keyGenerator: (request: FastifyRequest) =>
            createHash('sha256')
              .update(request.headers.authorization ?? request.ip)
              .digest('hex'),
        },
      },
      schema: {
        tags: ['Account data'],
        summary: 'Download a JSON copy of data associated with your account',
        description:
          'Requires a Firebase ID token. Available to suspended accounts. The response is private and is not stored by the API.',
        security: [{ bearerAuth: [] }],
        response: {
          200: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequestIncludingSuspended(request, auth);

      const exportData = await createAccountDataExport(user.id);
      request.log.info({ userId: user.id }, 'Account data export generated');
      return reply
        .header('Cache-Control', 'private, no-store, max-age=0')
        .header('Pragma', 'no-cache')
        .header(
          'Content-Disposition',
          `attachment; filename="travel-buddy-data-${new Date().toISOString().slice(0, 10)}.json"`,
        )
        .send(exportData);
    },
  );
}
