import type { Notification } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notification.repository.js';
import { notificationTitles } from './notification-titles.js';

function presentNotification(record: Notification) {
  return {
    id: record.id,
    type: record.type,
    title: notificationTitles[record.type],
    sourceId: record.sourceId,
    tripId: record.tripId,
    actorId: record.actorId,
    createdAt: record.createdAt.toISOString(),
    readAt: record.readAt?.toISOString() ?? null,
  };
}

export async function registerNotificationRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
): Promise<void> {
  app.get<{
    Querystring: { page?: number; pageSize?: number; unreadOnly?: boolean };
  }>(
    '/me/notifications',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'List your durable in-app notifications',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 20,
            },
            unreadOnly: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 20;
      const result = await listNotifications(
        actor.id,
        page,
        pageSize,
        request.query.unreadOnly ?? false,
      );
      return {
        data: result.records.map(presentNotification),
        pagination: { page, pageSize, total: result.total },
        unreadCount: result.unreadCount,
      };
    },
  );

  app.get(
    '/me/notifications/unread-count',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'Count unread notifications',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      return { data: { count: await countUnreadNotifications(actor.id) } };
    },
  );

  app.post<{ Params: { notificationId: string } }>(
    '/me/notifications/:notificationId/read',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'Mark one of your notifications as read',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['notificationId'],
          properties: { notificationId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      return {
        data: presentNotification(
          await markNotificationRead(actor.id, request.params.notificationId),
        ),
      };
    },
  );

  app.post(
    '/me/notifications/read-all',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'Mark all your notifications as read',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      return {
        data: { updated: await markAllNotificationsRead(actor.id) },
      };
    },
  );
}
