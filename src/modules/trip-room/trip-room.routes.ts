import type { FastifyInstance } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { presentChecklistItem } from './trip-room.presenter.js';
import { prismaTripRoomRepository } from './trip-room.repository.js';
import {
  createChecklistItem,
  leaveTrip,
  removeChecklistItem,
  removeTripMember,
  updateChecklistItem,
} from './trip-room.service.js';
import type {
  TripRoomRouteDependencies,
  UpdateChecklistItemBody,
} from './trip-room.types.js';

interface TripParams {
  tripId: string;
}

interface ChecklistItemParams {
  itemId: string;
}

interface MemberParams extends TripParams {
  memberId: string;
}

const tripParamsSchema = {
  type: 'object',
  required: ['tripId'],
  properties: { tripId: { type: 'string', format: 'uuid' } },
} as const;

const checklistItemParamsSchema = {
  type: 'object',
  required: ['itemId'],
  properties: { itemId: { type: 'string', format: 'uuid' } },
} as const;

const memberParamsSchema = {
  type: 'object',
  required: ['tripId', 'memberId'],
  properties: {
    tripId: { type: 'string', format: 'uuid' },
    memberId: { type: 'string', format: 'uuid' },
  },
} as const;

export const checklistItemSchema = {
  type: 'object',
  required: [
    'id',
    'tripId',
    'title',
    'status',
    'createdBy',
    'completedBy',
    'completedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tripId: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    status: { type: 'string', enum: ['OPEN', 'COMPLETED', 'REMOVED'] },
    createdBy: {
      type: 'object',
      required: ['id', 'displayName'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    completedBy: {
      anyOf: [
        {
          type: 'object',
          required: ['id', 'displayName'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        { type: 'null' },
      ],
    },
    completedAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const checklistItemResponse = {
  type: 'object',
  required: ['data'],
  properties: { data: checklistItemSchema },
} as const;

export async function registerTripRoomRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<TripRoomRouteDependencies> = {},
): Promise<void> {
  const repository = overrides.repository ?? prismaTripRoomRepository;

  app.post<{ Params: TripParams; Body: { title: string } }>(
    '/trips/:tripId/checklist-items',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Trip Room'],
        summary: 'Create a planning item in an active private trip room',
        security: [{ bearerAuth: [] }],
        params: tripParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['title'],
          properties: {
            title: { type: 'string', minLength: 2, maxLength: 200 },
          },
        },
        response: { 201: checklistItemResponse },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      const item = await createChecklistItem(
        request.params.tripId,
        user.id,
        request.body.title,
        repository,
      );
      return reply.code(201).send({ data: presentChecklistItem(item) });
    },
  );

  app.patch<{
    Params: ChecklistItemParams;
    Body: UpdateChecklistItemBody;
  }>(
    '/checklist-items/:itemId',
    {
      schema: {
        tags: ['Trip Room'],
        summary: 'Edit or complete a private trip-room checklist item',
        security: [{ bearerAuth: [] }],
        params: checklistItemParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: 'string', minLength: 2, maxLength: 200 },
            completed: { type: 'boolean' },
          },
        },
        response: { 200: checklistItemResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const item = await updateChecklistItem(
        request.params.itemId,
        user.id,
        request.body,
        repository,
      );
      return { data: presentChecklistItem(item) };
    },
  );

  app.delete<{ Params: ChecklistItemParams }>(
    '/checklist-items/:itemId',
    {
      schema: {
        tags: ['Trip Room'],
        summary: 'Remove an owned checklist item as its creator or trip owner',
        security: [{ bearerAuth: [] }],
        params: checklistItemParamsSchema,
        response: { 200: checklistItemResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const item = await removeChecklistItem(
        request.params.itemId,
        user.id,
        repository,
      );
      return { data: presentChecklistItem(item) };
    },
  );

  app.post<{ Params: TripParams }>(
    '/trips/:tripId/leave',
    {
      schema: {
        tags: ['Trip Room'],
        summary: 'Leave an active trip membership while retaining history',
        security: [{ bearerAuth: [] }],
        params: tripParamsSchema,
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      await leaveTrip(request.params.tripId, user.id, repository);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: MemberParams }>(
    '/trips/:tripId/members/:memberId/remove',
    {
      schema: {
        tags: ['Trip Room'],
        summary: 'Remove an active member as the trip owner',
        security: [{ bearerAuth: [] }],
        params: memberParamsSchema,
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      await removeTripMember(
        request.params.tripId,
        user.id,
        request.params.memberId,
        repository,
      );
      return reply.code(204).send();
    },
  );
}
