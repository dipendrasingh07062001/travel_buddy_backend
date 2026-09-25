import type { NotificationType, Prisma } from '@prisma/client';

import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';

interface NotificationEvent {
  recipientIds: string[];
  type: NotificationType;
  eventKey: string;
  sourceId: string;
  tripId?: string;
  actorId?: string;
  createdAt?: Date;
}

// Called inside the source action's transaction so an alert is never saved
// for an event that failed or rolled back.
export async function createNotifications(
  transaction: Prisma.TransactionClient,
  event: NotificationEvent,
): Promise<void> {
  const recipientIds = [...new Set(event.recipientIds)].filter(
    (id) => id !== event.actorId,
  );
  if (recipientIds.length === 0) return;
  await transaction.notification.createMany({
    data: recipientIds.map((recipientId) => ({
      recipientId,
      type: event.type,
      eventKey: event.eventKey,
      sourceId: event.sourceId,
      tripId: event.tripId ?? null,
      actorId: event.actorId ?? null,
      createdAt: event.createdAt ?? new Date(),
    })),
    skipDuplicates: true,
  });
}

export async function listNotifications(
  recipientId: string,
  page: number,
  pageSize: number,
  unreadOnly: boolean,
) {
  const where = { recipientId, ...(unreadOnly && { readAt: null }) };
  return database.$transaction(
    async (transaction) => {
      const [records, total, unreadCount] = await Promise.all([
        transaction.notification.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        transaction.notification.count({ where }),
        transaction.notification.count({
          where: { recipientId, readAt: null },
        }),
      ]);
      return { records, total, unreadCount };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

export function countUnreadNotifications(recipientId: string) {
  return database.notification.count({
    where: { recipientId, readAt: null },
  });
}

export async function markNotificationRead(
  recipientId: string,
  notificationId: string,
  now = new Date(),
) {
  return database.$transaction(async (transaction) => {
    const record = await transaction.notification.findFirst({
      where: { id: notificationId, recipientId },
    });
    if (!record) {
      throw new AppError(
        404,
        'NOTIFICATION_NOT_FOUND',
        'Notification not found.',
      );
    }
    if (record.readAt) return record;
    await transaction.notification.updateMany({
      where: { id: notificationId, recipientId, readAt: null },
      data: { readAt: now },
    });
    return transaction.notification.findUniqueOrThrow({
      where: { id: notificationId },
    });
  });
}

export async function markAllNotificationsRead(
  recipientId: string,
  now = new Date(),
) {
  const result = await database.notification.updateMany({
    where: { recipientId, readAt: null },
    data: { readAt: now },
  });
  return result.count;
}
