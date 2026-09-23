import type { FastifyInstance } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { prismaTripManagementRepository } from './trip-management.repository.js';
import {
  createTrip,
  transitionTrip,
  updateTrip,
  type CreateTripBody,
  type TripAction,
  type UpdateTripBody,
  type VersionBody,
} from './trip-management.service.js';
import type {
  ListOwnedTripsQuery,
  TripManagementRepository,
} from './trip-management.types.js';
import { presentOwnedTrip, presentTrip } from './trip.presenter.js';
import { prismaTripRepository } from './trip.repository.js';
import type { ListTripsQuery, TripRepository } from './trip.types.js';

export interface TripRouteDependencies {
  repository: TripRepository;
  managementRepository: TripManagementRepository;
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

const tripStatusValues = [
  'DRAFT',
  'PUBLISHED',
  'PAUSED',
  'FULL',
  'COMPLETED',
  'CANCELLED',
] as const;

export const publicTripSchema = {
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

const ownedTripSchema = {
  ...publicTripSchema,
  required: [...publicTripSchema.required, 'version', 'createdAt', 'updatedAt'],
  properties: {
    ...publicTripSchema.properties,
    status: { type: 'string', enum: tripStatusValues },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const nullableBudget = {
  anyOf: [
    { type: 'number', minimum: 0, maximum: 9999999999.99 },
    { type: 'null' },
  ],
} as const;

const tripWriteProperties = {
  communityId: { type: 'string', format: 'uuid' },
  originCity: { type: 'string', minLength: 1, maxLength: 120 },
  startDate: { type: 'string', format: 'date' },
  endDate: { type: 'string', format: 'date' },
  flexibilityDays: { type: 'integer', minimum: 0, maximum: 30 },
  budgetMin: nullableBudget,
  budgetMax: nullableBudget,
  currentGroupSize: { type: 'integer', minimum: 1, maximum: 100 },
  desiredGroupSize: { type: 'integer', minimum: 1, maximum: 100 },
  transport: { type: 'string', enum: transportValues },
  description: { type: 'string', minLength: 20, maxLength: 2000 },
} as const;

const ownedTripResponse = {
  type: 'object',
  required: ['data'],
  properties: { data: ownedTripSchema },
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
  auth: AuthRouteDependencies,
  dependencies: Partial<TripRouteDependencies> = {},
): Promise<void> {
  const repository = dependencies.repository ?? prismaTripRepository;
  const managementRepository =
    dependencies.managementRepository ?? prismaTripManagementRepository;

  app.post<{ Body: CreateTripBody }>(
    '/trips',
    {
      schema: {
        tags: ['Trips'],
        summary: 'Create a private draft trip',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'communityId',
            'originCity',
            'startDate',
            'endDate',
            'desiredGroupSize',
            'description',
          ],
          properties: {
            ...tripWriteProperties,
            currency: { type: 'string', enum: ['INR'], default: 'INR' },
          },
        },
        response: { 201: ownedTripResponse },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      const trip = await createTrip(
        user.id,
        request.body,
        managementRepository,
      );
      return reply.code(201).send({ data: presentOwnedTrip(trip) });
    },
  );

  app.get<{ Querystring: ListOwnedTripsQuery }>(
    '/me/trips',
    {
      schema: {
        tags: ['Trips'],
        summary: 'List trips owned by the current user',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: tripStatusValues },
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
              data: { type: 'array', items: ownedTripSchema },
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
      const user = await authenticateRequest(request, auth);
      const query = {
        ...(request.query.status && { status: request.query.status }),
        page: request.query.page ?? 1,
        pageSize: request.query.pageSize ?? 20,
      };
      const result = await managementRepository.listOwned(user.id, query);
      return {
        data: result.trips.map(presentOwnedTrip),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / query.pageSize),
        },
      };
    },
  );

  app.patch<{ Params: TripParams; Body: UpdateTripBody }>(
    '/trips/:tripId',
    {
      schema: {
        tags: ['Trips'],
        summary: 'Edit a trip owned by the current user',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['tripId'],
          properties: { tripId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          minProperties: 2,
          additionalProperties: false,
          required: ['expectedVersion'],
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            ...tripWriteProperties,
          },
        },
        response: { 200: ownedTripResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const trip = await updateTrip(
        user.id,
        request.params.tripId,
        request.body,
        managementRepository,
      );
      return { data: presentOwnedTrip(trip) };
    },
  );

  const actionSummaries: Record<TripAction, string> = {
    publish: 'Publish a draft or paused trip',
    pause: 'Pause a published trip',
    'mark-full': 'Mark a published trip as full',
    cancel: 'Cancel a trip',
    complete: 'Complete a trip after its end date',
  };
  const actions = Object.keys(actionSummaries) as TripAction[];
  for (const action of actions) {
    app.post<{ Params: TripParams; Body: VersionBody }>(
      `/trips/:tripId/${action}`,
      {
        schema: {
          tags: ['Trips'],
          summary: actionSummaries[action],
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['tripId'],
            properties: { tripId: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedVersion'],
            properties: { expectedVersion: { type: 'integer', minimum: 1 } },
          },
          response: { 200: ownedTripResponse },
        },
      },
      async (request) => {
        const user = await authenticateRequest(request, auth);
        const trip = await transitionTrip(
          user.id,
          request.params.tripId,
          action,
          request.body.expectedVersion,
          managementRepository,
        );
        return { data: presentOwnedTrip(trip) };
      },
    );
  }

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
              data: { type: 'array', items: publicTripSchema },
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
            properties: { data: publicTripSchema },
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
