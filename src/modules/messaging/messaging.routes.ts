import type { FastifyInstance } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { publicUserSchema } from '../profiles/profile.schemas.js';
import { presentMessage, presentRoom } from './messaging.presenter.js';
import { prismaMessagingRepository } from './messaging.repository.js';
import {
  deleteMessage,
  editMessage,
  getRoom,
  listMessages,
  markRoomRead,
  sendMessage,
  setRoomMuted,
} from './messaging.service.js';
import type {
  ListMessagesQuery,
  MessagingRouteDependencies,
} from './messaging.types.js';

interface TripParams {
  tripId: string;
}

interface MessageParams {
  messageId: string;
}

interface MessageBody {
  body: string;
}

interface MessageListQuery {
  cursor?: string;
  pageSize?: number;
}

const messageStatuses = ['ACTIVE', 'EDITED', 'DELETED'] as const;

const memberSchema = {
  type: 'object',
  required: ['role', 'joinedAt', 'user'],
  properties: {
    role: { type: 'string', enum: ['OWNER', 'MEMBER'] },
    joinedAt: { type: 'string', format: 'date-time' },
    user: publicUserSchema,
  },
} as const;

const roomSchema = {
  type: 'object',
  required: [
    'id',
    'tripId',
    'status',
    'members',
    'preferences',
    'safetyNotice',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tripId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['ACTIVE', 'READ_ONLY'] },
    members: { type: 'array', items: memberSchema },
    preferences: {
      type: 'object',
      required: ['muted', 'lastReadAt'],
      properties: {
        muted: { type: 'boolean' },
        lastReadAt: {
          anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
        },
      },
    },
    safetyNotice: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const messageSchema = {
  type: 'object',
  required: [
    'id',
    'body',
    'status',
    'sender',
    'isOwn',
    'createdAt',
    'updatedAt',
    'editedAt',
    'deletedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    body: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    status: { type: 'string', enum: messageStatuses },
    sender: publicUserSchema,
    isOwn: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    editedAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    deletedAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
  },
} as const;

const tripParamsSchema = {
  type: 'object',
  required: ['tripId'],
  properties: { tripId: { type: 'string', format: 'uuid' } },
} as const;

const messageParamsSchema = {
  type: 'object',
  required: ['messageId'],
  properties: { messageId: { type: 'string', format: 'uuid' } },
} as const;

const messageBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['body'],
  properties: { body: { type: 'string', minLength: 1, maxLength: 2000 } },
} as const;

const roomResponse = {
  type: 'object',
  required: ['data'],
  properties: { data: roomSchema },
} as const;

const messageResponse = {
  type: 'object',
  required: ['data'],
  properties: { data: messageSchema },
} as const;

export async function registerMessagingRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<MessagingRouteDependencies> = {},
): Promise<void> {
  const repository = overrides.repository ?? prismaMessagingRepository;

  app.get<{ Params: TripParams }>(
    '/trips/:tripId/room',
    {
      schema: {
        tags: ['Messaging'],
        summary: 'Open the private room for an active trip member',
        security: [{ bearerAuth: [] }],
        params: tripParamsSchema,
        response: { 200: roomResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const room = await getRoom(request.params.tripId, user.id, repository);
      return { data: presentRoom(room, user.id) };
    },
  );

  app.get<{ Params: TripParams; Querystring: MessageListQuery }>(
    '/trips/:tripId/messages',
    {
      schema: {
        tags: ['Messaging'],
        summary: 'List private trip-room messages, newest first',
        security: [{ bearerAuth: [] }],
        params: tripParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', format: 'uuid' },
            pageSize: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 50,
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: messageSchema },
              pagination: {
                type: 'object',
                required: ['nextCursor'],
                properties: {
                  nextCursor: {
                    anyOf: [
                      { type: 'string', format: 'uuid' },
                      { type: 'null' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const query: ListMessagesQuery = {
        ...(request.query.cursor && { cursor: request.query.cursor }),
        pageSize: request.query.pageSize ?? 50,
      };
      const result = await listMessages(
        request.params.tripId,
        user.id,
        query,
        repository,
      );
      return {
        data: result.messages.map((message) =>
          presentMessage(message, user.id),
        ),
        pagination: { nextCursor: result.nextCursor },
      };
    },
  );

  app.post<{ Params: TripParams; Body: MessageBody }>(
    '/trips/:tripId/messages',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Messaging'],
        summary: 'Send a message to active members of a private trip room',
        security: [{ bearerAuth: [] }],
        params: tripParamsSchema,
        body: messageBodySchema,
        response: { 201: messageResponse },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      const message = await sendMessage(
        request.params.tripId,
        user.id,
        request.body.body,
        repository,
      );
      return reply.code(201).send({ data: presentMessage(message, user.id) });
    },
  );

  app.patch<{ Params: MessageParams; Body: MessageBody }>(
    '/messages/:messageId',
    {
      schema: {
        tags: ['Messaging'],
        summary: 'Edit an owned message while the trip room is active',
        security: [{ bearerAuth: [] }],
        params: messageParamsSchema,
        body: messageBodySchema,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const message = await editMessage(
        request.params.messageId,
        user.id,
        request.body.body,
        repository,
      );
      return { data: presentMessage(message, user.id) };
    },
  );

  app.delete<{ Params: MessageParams }>(
    '/messages/:messageId',
    {
      schema: {
        tags: ['Messaging'],
        summary: 'Soft-delete an owned message while preserving audit history',
        security: [{ bearerAuth: [] }],
        params: messageParamsSchema,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const message = await deleteMessage(
        request.params.messageId,
        user.id,
        repository,
      );
      return { data: presentMessage(message, user.id) };
    },
  );

  app.post<{ Params: TripParams }>(
    '/trips/:tripId/read',
    {
      schema: {
        tags: ['Messaging'],
        summary: 'Mark the private trip room read through the current time',
        security: [{ bearerAuth: [] }],
        params: tripParamsSchema,
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      await markRoomRead(request.params.tripId, user.id, repository);
      return reply.code(204).send();
    },
  );

  app.patch<{ Params: TripParams; Body: { muted: boolean } }>(
    '/trips/:tripId/room/preferences',
    {
      schema: {
        tags: ['Messaging'],
        summary: 'Mute or unmute non-essential trip-room notifications',
        security: [{ bearerAuth: [] }],
        params: tripParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['muted'],
          properties: { muted: { type: 'boolean' } },
        },
        response: { 200: roomResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const room = await setRoomMuted(
        request.params.tripId,
        user.id,
        request.body.muted,
        repository,
      );
      return { data: presentRoom(room, user.id) };
    },
  );
}
