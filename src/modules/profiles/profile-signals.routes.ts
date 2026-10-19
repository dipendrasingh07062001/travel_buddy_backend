import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors/app-error.js';
import {
  authenticateRequest,
  authenticateRequestIfPresent,
  verifyRequestIdentity,
} from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { presentVerificationSignals } from './profile-signals.presenter.js';
import { prismaProfileSignalsRepository } from './profile-signals.repository.js';
import type { ProfileSignalsDependencies } from './profile-signals.types.js';

const signalResponse = {
  type: 'object',
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['signals', 'notice'],
      properties: {
        notice: { type: 'string' },
        signals: {
          type: 'array',
          maxItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'type',
              'label',
              'recordedAt',
              'source',
              'explanation',
              'limitations',
            ],
            properties: {
              type: { type: 'string', enum: ['EMAIL', 'PHONE'] },
              label: { type: 'string' },
              recordedAt: { type: 'string', format: 'date-time' },
              source: { type: 'string', enum: ['FIREBASE_SIGN_IN_CLAIM'] },
              explanation: { type: 'string' },
              limitations: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;

export async function registerProfileSignalsRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<ProfileSignalsDependencies> = {},
) {
  const repository = overrides.repository ?? prismaProfileSignalsRepository;
  app.get<{ Params: { userId: string } }>(
    '/users/:userId/verification-signals',
    {
      schema: {
        tags: ['Profiles'],
        summary:
          'Read factual recorded sign-in verification signals without contact details',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        response: { 200: signalResponse },
      },
    },
    async (request, reply) => {
      const viewer = await authenticateRequestIfPresent(request, auth);
      reply.header('Cache-Control', 'private, no-store');
      const records = await repository.findPublic(
        request.params.userId,
        viewer?.id,
      );
      if (!records)
        throw new AppError(404, 'NOT_FOUND', 'User profile not found.');
      return { data: presentVerificationSignals(records) };
    },
  );
  app.post(
    '/me/verification-signals/refresh',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Profiles'],
        summary:
          'Refresh own contact signals using only verified Firebase token claims; send no body',
        security: [{ bearerAuth: [] }],
        response: { 200: signalResponse },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth, { fresh: true });
      reply.header('Cache-Control', 'private, no-store');
      if (request.body !== undefined)
        throw new AppError(
          400,
          'VERIFICATION_BODY_NOT_ALLOWED',
          'Send no body. Verification records come only from authenticated Firebase claims.',
        );
      const identity = await verifyRequestIdentity(
        request,
        auth.tokenVerifier,
        {
          fresh: true,
        },
      );
      const records = await repository.refresh(user.id, identity);
      return { data: presentVerificationSignals(records) };
    },
  );
}
