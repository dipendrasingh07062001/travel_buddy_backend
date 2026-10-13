import type { NotificationType } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { database } from '../../database/client.js';
import { notificationTitles } from './notification-titles.js';

export interface PushMessage {
  token: string;
  title: string;
  data: Record<string, string>;
}

export type PushSendResult = 'sent' | 'invalid_token' | 'failed';

// Returns one result per message, in the same order.
export interface PushSender {
  send(messages: PushMessage[]): Promise<PushSendResult[]>;
}

export interface PushBatchOptions {
  now?: Date;
  batchSize?: number;
  maximumAgeMs?: number;
}

export interface PushBatchResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  removedDevices: number;
}

const defaultBatchSize = 100;
// Older alerts are no longer timely as a push; the inbox still shows them.
const defaultMaximumAgeMs = 15 * 60 * 1000;
const idleIntervalMs = 5_000;

interface ClaimedNotification {
  id: string;
  recipient_id: string;
  type: NotificationType;
  source_id: string;
  trip_id: string | null;
}

// Notification rows are the outbox: actions write them inside their own
// transaction, and this worker delivers them after commit. Delivery is
// at most once; a crash mid-batch leaves rows SENDING rather than risking a
// duplicate alert.
export async function processPushBatch(
  sender: PushSender,
  options: PushBatchOptions = {},
): Promise<PushBatchResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? defaultBatchSize;
  const cutoff = new Date(
    now.getTime() - (options.maximumAgeMs ?? defaultMaximumAgeMs),
  );
  const result: PushBatchResult = {
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    removedDevices: 0,
  };

  // Expired alerts, and alerts the user already read in the inbox, are not
  // worth interrupting them for.
  const expired = await database.notification.updateMany({
    where: {
      pushStatus: 'PENDING',
      OR: [{ createdAt: { lt: cutoff } }, { readAt: { not: null } }],
    },
    data: { pushStatus: 'SKIPPED' },
  });
  result.skipped += expired.count;

  // SKIP LOCKED lets several API instances share the queue without claiming
  // the same row twice.
  const claimed = await database.$queryRaw<ClaimedNotification[]>`
    UPDATE "notifications" SET "push_status" = 'SENDING'
    WHERE "id" IN (
      SELECT "id" FROM "notifications"
      WHERE "push_status" = 'PENDING'
      ORDER BY "created_at", "id"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "recipient_id", "type", "source_id", "trip_id"
  `;
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  // Suspended and deleted accounts receive nothing.
  const devices = await database.pushDevice.findMany({
    where: {
      userId: { in: [...new Set(claimed.map((item) => item.recipient_id))] },
      user: { status: 'ACTIVE' },
    },
    select: { token: true, userId: true },
  });
  const tokensByUser = new Map<string, string[]>();
  for (const device of devices) {
    tokensByUser.set(device.userId, [
      ...(tokensByUser.get(device.userId) ?? []),
      device.token,
    ]);
  }

  const messages: PushMessage[] = [];
  const messageNotificationIds: string[] = [];
  const skippedIds: string[] = [];
  for (const notification of claimed) {
    const tokens = tokensByUser.get(notification.recipient_id) ?? [];
    if (tokens.length === 0) skippedIds.push(notification.id);
    for (const token of tokens) {
      messages.push({
        token,
        title: notificationTitles[notification.type],
        data: {
          notificationId: notification.id,
          type: notification.type,
          sourceId: notification.source_id,
          ...(notification.trip_id && { tripId: notification.trip_id }),
        },
      });
      messageNotificationIds.push(notification.id);
    }
  }

  const deliveredIds = new Set<string>();
  const attemptedIds = new Set(messageNotificationIds);
  const invalidTokens: string[] = [];
  let sendError: unknown;
  if (messages.length > 0) {
    try {
      const outcomes = await sender.send(messages);
      outcomes.forEach((outcome, index) => {
        if (outcome === 'sent') {
          deliveredIds.add(messageNotificationIds[index] as string);
        } else if (outcome === 'invalid_token') {
          invalidTokens.push((messages[index] as PushMessage).token);
        }
      });
    } catch (error) {
      sendError = error;
    }
  }
  const failedIds = [...attemptedIds].filter((id) => !deliveredIds.has(id));

  if (invalidTokens.length > 0) {
    const removed = await database.pushDevice.deleteMany({
      where: { token: { in: invalidTokens } },
    });
    result.removedDevices = removed.count;
  }
  await database.$transaction([
    database.notification.updateMany({
      where: { id: { in: [...deliveredIds] } },
      data: { pushStatus: 'SENT', pushedAt: now },
    }),
    database.notification.updateMany({
      where: { id: { in: failedIds } },
      data: { pushStatus: 'FAILED' },
    }),
    database.notification.updateMany({
      where: { id: { in: skippedIds } },
      data: { pushStatus: 'SKIPPED' },
    }),
  ]);
  result.sent = deliveredIds.size;
  result.failed = failedIds.length;
  result.skipped += skippedIds.length;

  if (sendError) throw sendError;
  return result;
}

export interface PushDeliveryWorker {
  stop(): Promise<void>;
}

// Polls the outbox until stopped. A full batch means more are waiting, so the
// next batch starts at once; otherwise the worker waits a few seconds.
export function startPushDelivery(
  sender: PushSender,
  logger: FastifyBaseLogger,
): PushDeliveryWorker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = deliver();
    }, delayMs);
  };

  const deliver = async () => {
    try {
      const result = await processPushBatch(sender);
      if (result.claimed > 0 || result.skipped > 0) {
        logger.info({ push: result }, 'Push notification batch processed');
      }
      schedule(result.claimed === defaultBatchSize ? 0 : idleIntervalMs);
    } catch (error) {
      logger.error({ err: error }, 'Push notification delivery failed');
      schedule(idleIntervalMs);
    }
  };

  schedule(0);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
