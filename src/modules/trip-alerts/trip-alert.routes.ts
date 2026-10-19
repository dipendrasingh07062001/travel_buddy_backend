import type { FastifyInstance } from 'fastify';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { tripTransportValues } from '../trips/trip.types.js';
import { presentTripAlert } from './trip-alert.presenter.js';
import { prismaTripAlertRepository } from './trip-alert.repository.js';
import { normalizeTripAlert } from './trip-alert.service.js';
import type {
  TripAlertBody,
  TripAlertDependencies,
} from './trip-alert.types.js';

const properties = {
  name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
  communityId: { type: 'string', format: 'uuid' },
  enabled: {
    type: 'boolean',
    description: 'Explicit opt-in. Required; never enabled by default.',
  },
  origin: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
  departureFrom: { type: 'string', format: 'date' },
  departureTo: { type: 'string', format: 'date' },
  // At most two decimal places, checked in normalizeTripAlert: JSON Schema's
  // multipleOf: 0.01 rejects values like 19.99 through floating-point error.
  minBudget: { type: 'number', minimum: 0, maximum: 9999999999.99 },
  maxBudget: { type: 'number', minimum: 0, maximum: 9999999999.99 },
  minDuration: { type: 'integer', minimum: 1, maximum: 365 },
  maxDuration: { type: 'integer', minimum: 1, maximum: 365 },
  transport: { type: 'string', enum: tripTransportValues },
} as const;
const params = {
  type: 'object',
  required: ['alertId'],
  additionalProperties: false,
  properties: { alertId: { type: 'string', format: 'uuid' } },
} as const;
const common = { tags: ['Trip alerts'], security: [{ bearerAuth: [] }] };

export async function registerTripAlertRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<TripAlertDependencies> = {},
) {
  const repository = overrides.repository ?? prismaTripAlertRepository;
  app.get(
    '/me/trip-alerts',
    {
      schema: {
        ...common,
        summary: 'List only your saved matching-trip alerts (at most 20)',
      },
    },
    async (request, reply) => {
      const actor = await authenticateRequest(request, auth);
      reply.header('Cache-Control', 'private, no-store');
      return { data: (await repository.list(actor.id)).map(presentTripAlert) };
    },
  );
  app.post<{ Body: TripAlertBody }>(
    '/me/trip-alerts',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        ...common,
        summary: 'Save an explicitly opted-in matching-trip alert',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'communityId', 'enabled'],
          properties,
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticateRequest(request, auth);
      const input = normalizeTripAlert(request.body);
      reply.header('Cache-Control', 'private, no-store');
      const record = await repository.create(actor.id, input);
      return reply.code(201).send({ data: presentTripAlert(record) });
    },
  );
  app.put<{
    Params: { alertId: string };
    Body: TripAlertBody & { expectedVersion: number };
  }>(
    '/me/trip-alerts/:alertId',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        ...common,
        summary:
          'Replace all alert criteria or pause/resume it; omitted optional criteria are cleared',
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'communityId', 'enabled', 'expectedVersion'],
          properties: {
            ...properties,
            expectedVersion: {
              type: 'integer',
              minimum: 1,
              maximum: 2147483646,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticateRequest(request, auth);
      const input = normalizeTripAlert(request.body);
      reply.header('Cache-Control', 'private, no-store');
      return {
        data: presentTripAlert(
          await repository.replace(
            actor.id,
            request.params.alertId,
            request.body.expectedVersion,
            input,
          ),
        ),
      };
    },
  );
  app.delete<{ Params: { alertId: string } }>(
    '/me/trip-alerts/:alertId',
    {
      schema: {
        ...common,
        summary: 'Unsubscribe and delete your saved criteria',
        params,
      },
    },
    async (request, reply) => {
      const actor = await authenticateRequest(request, auth);
      await repository.remove(actor.id, request.params.alertId);
      return reply
        .header('Cache-Control', 'private, no-store')
        .code(204)
        .send();
    },
  );
}
