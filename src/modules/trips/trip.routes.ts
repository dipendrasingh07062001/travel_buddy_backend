import type { FastifyInstance } from 'fastify';

import { presentTrip } from './trip.presenter.js';
import { prismaTripRepository } from './trip.repository.js';
import type { ListTripsQuery, TripRepository } from './trip.types.js';

export interface TripRouteDependencies {
  repository: TripRepository;
}

interface TripParams {
  tripId: string;
}

const transportValues = [
  'BUS',
  'TRAIN',
  'FLIGHT',
  'CAR',
  'MOTORCYCLE',
  'OTHER',
  'UNDECIDED',
] as const;

const tripSchema = {
  type: 'object',
  required: [
    'id',
    'originCity',
    'destination',
    'startDate',
    'endDate',
    'flexibilityDays',
    'durationDays',
    'budget',
    'group',
    'transport',
    'description',
    'status',
    'owner',
    'publishedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    originCity: { type: 'string' },
    destination: {
      type: 'object',
      required: ['id', 'slug', 'name', 'region', 'countryCode'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        name: { type: 'string' },
        region: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        countryCode: { type: 'string' },
      },
    },
    startDate: { type: 'string', format: 'date' },
    endDate: { type: 'string', format: 'date' },
    flexibilityDays: { type: 'integer' },
    durationDays: { type: 'integer' },
    budget: {
      type: 'object',
      required: ['minimum', 'maximum', 'currency'],
      properties: {
        minimum: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        maximum: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        currency: { type: 'string' },
      },
    },
    group: {
      type: 'object',
      required: ['currentSize', 'desiredSize', 'availableSpaces'],
      properties: {
        currentSize: { type: 'integer' },
        desiredSize: { type: 'integer' },
        availableSpaces: { type: 'integer' },
      },
    },
    transport: { type: 'string', enum: transportValues },
    description: { type: 'string' },
    status: { type: 'string', enum: ['PUBLISHED', 'FULL'] },
    owner: {
      type: 'object',
      required: ['id', 'displayName'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    publishedAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
  },
} as const;

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function validateRange(query: ListTripsQuery): void {
  if (
    query.departureFrom &&
    query.departureTo &&
    query.departureFrom > query.departureTo
  ) {
    throw badRequest('departureFrom must be on or before departureTo.');
  }
  if (
    query.minBudget !== undefined &&
    query.maxBudget !== undefined &&
    query.minBudget > query.maxBudget
  ) {
    throw badRequest('minBudget must be less than or equal to maxBudget.');
  }
}

export async function registerTripRoutes(
  app: FastifyInstance,
  dependencies: Partial<TripRouteDependencies> = {},
): Promise<void> {
  const repository = dependencies.repository ?? prismaTripRepository;

  app.get<{ Querystring: ListTripsQuery }>(
    '/trips',
    {
      schema: {
        tags: ['Trips'],
        summary: 'Browse public trips',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            origin: { type: 'string', minLength: 1, maxLength: 120 },
            destination: {
              type: 'string',
              minLength: 1,
              maxLength: 120,
              pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
            },
            departureFrom: { type: 'string', format: 'date' },
            departureTo: { type: 'string', format: 'date' },
            minBudget: { type: 'number', minimum: 0 },
            maxBudget: { type: 'number', minimum: 0 },
            transport: { type: 'string', enum: transportValues },
            sort: {
              type: 'string',
              enum: ['newest', 'departure_asc'],
              default: 'newest',
            },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 20,
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: tripSchema },
              pagination: {
                type: 'object',
                required: ['page', 'pageSize', 'totalItems', 'totalPages'],
                properties: {
                  page: { type: 'integer' },
                  pageSize: { type: 'integer' },
                  totalItems: { type: 'integer' },
                  totalPages: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      validateRange(request.query);
      const query = {
        ...request.query,
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
        sort: request.query.sort ?? ('newest' as const),
      };
      const result = await repository.listPublic(query);
      return {
        data: result.trips.map(presentTrip),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / query.pageSize),
        },
      };
    },
  );

  app.get<{ Params: TripParams }>(
    '/trips/:tripId',
    {
      schema: {
        tags: ['Trips'],
        summary: 'Get one public trip',
        params: {
          type: 'object',
          required: ['tripId'],
          properties: { tripId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: tripSchema },
          },
        },
      },
    },
    async (request, reply) => {
      const trip = await repository.findPublicById(request.params.tripId);
      if (!trip) {
        return reply.code(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Trip not found.',
            requestId: request.id,
          },
        });
      }
      return { data: presentTrip(trip) };
    },
  );
}
