import type { FastifyInstance } from 'fastify';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { AppError } from '../../errors/app-error.js';
import type { EmailPreference } from '../../generated/prisma/client.js';
import { emailDeliveryConfigured } from './email.configuration.js';
import { prismaEmailPreferenceRepository } from './email-preference.repository.js';
import type {
  EmailPreferenceDependencies,
  EmailPreferencePatch,
} from './email.types.js';

const preferenceResponse = {
  type: 'object',
  required: ['data'],
  additionalProperties: false,
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: [
        'connections',
        'trips',
        'finances',
        'safety',
        'version',
        'updatedAt',
        'deliveryConfigured',
      ],
      properties: {
        connections: { type: 'boolean' },
        trips: { type: 'boolean' },
        finances: { type: 'boolean' },
        safety: { type: 'boolean' },
        version: { type: 'integer', minimum: 0 },
        updatedAt: {
          anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
        },
        deliveryConfigured: { type: 'boolean' },
      },
    },
  },
} as const;

function present(record: EmailPreference | null) {
  return {
    connections: record?.connections ?? false,
    trips: record?.trips ?? false,
    finances: record?.finances ?? false,
    safety: record?.safety ?? false,
    version: record?.version ?? 0,
    updatedAt: record?.updatedAt.toISOString() ?? null,
    deliveryConfigured: emailDeliveryConfigured(),
  };
}

export async function registerEmailPreferenceRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<EmailPreferenceDependencies> = {},
) {
  const repository = overrides.repository ?? prismaEmailPreferenceRepository;
  app.get(
    '/me/email-preferences',
    {
      schema: {
        tags: ['Email notifications'],
        security: [{ bearerAuth: [] }],
        summary:
          'Read your private optional email preferences; everything defaults off',
        response: { 200: preferenceResponse },
      },
    },
    async (request, reply) => {
      const actor = await authenticateRequest(request, auth);
      reply.header('Cache-Control', 'private, no-store');
      return { data: present(await repository.find(actor.id)) };
    },
  );
  app.patch<{ Body: EmailPreferencePatch & { expectedVersion: number } }>(
    '/me/email-preferences',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Email notifications'],
        security: [{ bearerAuth: [] }],
        summary:
          'Explicitly opt into or out of optional email categories; no email address is accepted',
        response: { 200: preferenceResponse },
        body: {
          type: 'object',
          required: ['expectedVersion'],
          additionalProperties: false,
          properties: {
            expectedVersion: {
              type: 'integer',
              minimum: 0,
              maximum: 2147483646,
            },
            connections: { type: 'boolean' },
            trips: { type: 'boolean' },
            finances: { type: 'boolean' },
            safety: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticateRequest(request, auth);
      const { expectedVersion, ...patch } = request.body;
      if (Object.keys(patch).length === 0)
        throw new AppError(
          400,
          'EMPTY_EMAIL_PREFERENCE_UPDATE',
          'Choose at least one email category to change.',
        );
      reply.header('Cache-Control', 'private, no-store');
      return {
        data: present(
          await repository.update(actor.id, expectedVersion, patch),
        ),
      };
    },
  );
}
