import type { FastifyBaseLogger } from 'fastify';

import { database } from '../../database/client.js';
import type { NotificationType } from '../../generated/prisma/client.js';
import { notificationTitles } from './notification-titles.js';

export interface PushMessage {
  token: string;
  title: string;
  data: Record<string, string>;
  // Devices replace an earlier alert with the same ID instead of showing it
  // twice, so a resend after a crash does not duplicate it.
  collapseId: string;
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
  // Failed this time and scheduled for another attempt.
  retrying: number;
  // Failed on the last allowed attempt.
  failed: number;
  removedDevices: number;
}

const defaultBatchSize = 100;
// Older alerts are no longer timely as a push; the inbox still shows them.
const defaultMaximumAgeMs = 15 * 60 * 1000;
const idleIntervalMs = 5_000;
// A failed alert is tried again after each of these delays, then given up.
const retryDelaysMs = [30_000, 2 * 60_000, 5 * 60_000];
const maximumAttempts = retryDelaysMs.length + 1;
// Sending a batch takes seconds; a claim this old belongs to a worker that
// crashed or hung.
const abandonedClaimMs = 5 * 60 * 1000;

interface ClaimedNotification {
  id: string;
  recipient_id: string;
  type: NotificationType;
  source_id: string;
  trip_id: string | null;
  push_attempts: number;
}

// Notification rows are the outbox: actions write them inside their own
// transaction, and this worker delivers them after commit. A failed alert is
// retried a few times. Rows left SENDING by a crashed worker are sent again;
// the collapse ID stops a device from showing the same alert twice.
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
    retrying: 0,
    failed: 0,
    removedDevices: 0,
  };

  // Alerts claimed by a worker that never finished go back in the queue,
  // unless that was already their last attempt.
  const abandoned = {
    pushStatus: 'SENDING',
    pushClaimedAt: { lt: new Date(now.getTime() - abandonedClaimMs) },
  } as const;
  await database.$transaction([
    database.notification.updateMany({
      where: { ...abandoned, pushAttempts: { lt: maximumAttempts } },
      data: { pushStatus: 'PENDING', pushNextAttemptAt: null },
    }),
    database.notification.updateMany({
      where: { ...abandoned, pushAttempts: { gte: maximumAttempts } },
      data: { pushStatus: 'FAILED' },
    }),
  ]);

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
    UPDATE "notifications"
    SET "push_status" = 'SENDING',
        "push_claimed_at" = ${now},
        "push_attempts" = "push_attempts" + 1
    WHERE "id" IN (
      SELECT "id" FROM "notifications"
      WHERE "push_status" = 'PENDING'
        AND ("push_next_attempt_at" IS NULL OR "push_next_attempt_at" <= ${now})
      ORDER BY "created_at", "id"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "recipient_id", "type", "source_id", "trip_id",
      "push_attempts"
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
        collapseId: notification.id,
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
  const attemptsById = new Map(
    claimed.map((item) => [item.id, item.push_attempts]),
  );
  // Groups alerts by the attempt they just failed, which sets the next delay.
  const retryIdsByAttempt = new Map<number, string[]>();
  const failedIds: string[] = [];
  for (const id of attemptedIds) {
    if (deliveredIds.has(id)) continue;
    const attempts = attemptsById.get(id) ?? maximumAttempts;
    if (attempts >= maximumAttempts) {
      failedIds.push(id);
    } else {
      retryIdsByAttempt.set(attempts, [
        ...(retryIdsByAttempt.get(attempts) ?? []),
        id,
      ]);
    }
  }

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
    ...[...retryIdsByAttempt].map(([attempts, ids]) =>
      database.notification.updateMany({
        where: { id: { in: ids } },
        data: {
          pushStatus: 'PENDING',
          pushNextAttemptAt: new Date(
            now.getTime() + (retryDelaysMs[attempts - 1] ?? 0),
          ),
        },
      }),
    ),
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
  result.retrying = [...retryIdsByAttempt.values()].flat().length;
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
