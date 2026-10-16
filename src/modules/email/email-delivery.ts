import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { database, databaseSchema } from '../../database/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { notificationTitles } from '../notifications/notification-titles.js';
import { emailCategory } from './email-policy.js';
import {
  emailCategoryFields,
  type EmailDeliveryDependencies,
} from './email.types.js';

const maximumAttempts = 4;
const leaseMs = 2 * 60_000;
const maximumAgeMs = 24 * 60 * 60_000;
const retryDelaysMs = [30_000, 2 * 60_000, 5 * 60_000];
const pollMs = 5_000;
const table = Prisma.raw(
  `"${databaseSchema.replace(/"/g, '""')}"."email_deliveries"`,
);

export interface EmailBatchResult {
  claimed: number;
  accepted: number;
  skipped: number;
  retrying: number;
  failed: number;
}
interface Claimed {
  id: string;
  notification_id: string;
  attempts: number;
}

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('EMAIL_OPERATION_TIMEOUT'));
      }, timeoutMs);
    });
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function eligible(id: string, claimToken: string, now: Date) {
  const row = await database.emailDelivery.findFirst({
    where: { id, status: 'SENDING', claimToken },
    include: {
      notification: {
        include: {
          recipient: {
            select: { status: true, deletedAt: true, emailPreference: true },
          },
        },
      },
    },
  });
  if (!row) return null;
  const notification = row.notification;
  const preference = notification.recipient.emailPreference;
  if (
    notification.recipient.status !== 'ACTIVE' ||
    notification.recipient.deletedAt ||
    notification.readAt ||
    notification.createdAt < new Date(now.getTime() - maximumAgeMs) ||
    emailCategory(notification.type) !== row.category ||
    !preference ||
    preference.version !== row.preferenceVersion ||
    !preference[emailCategoryFields[row.category]]
  )
    return null;
  if (notification.actorId) {
    const blocks = await database.userBlock.count({
      where: {
        OR: [
          {
            blockerId: notification.actorId,
            blockedId: notification.recipientId,
          },
          {
            blockerId: notification.recipientId,
            blockedId: notification.actorId,
          },
        ],
      },
    });
    if (blocks) return null;
  }
  if (row.category === 'TRIPS' || row.category === 'FINANCES') {
    if (
      !notification.tripId ||
      !(await database.tripMembership.count({
        where: {
          tripId: notification.tripId,
          userId: notification.recipientId,
          status: 'ACTIVE',
        },
      }))
    )
      return null;
  }
  return row;
}

// No network calls inside a database transaction. Short row claims allow
// multiple workers; attempts are bounded and stale claims recover after a crash.
export async function processEmailBatch(
  dependencies: EmailDeliveryDependencies,
  options: { now?: Date; batchSize?: number } = {},
): Promise<EmailBatchResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 10;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20)
    throw new Error('Email batchSize must be between 1 and 20.');
  const abandoned = {
    status: 'SENDING' as const,
    claimedAt: { lt: new Date(now.getTime() - leaseMs) },
  };
  await database.$transaction([
    database.emailDelivery.updateMany({
      where: { ...abandoned, attempts: { lt: maximumAttempts } },
      data: {
        status: 'PENDING',
        claimToken: null,
        claimedAt: null,
        nextAttemptAt: now,
      },
    }),
    database.emailDelivery.updateMany({
      where: { ...abandoned, attempts: { gte: maximumAttempts } },
      data: { status: 'FAILED', claimToken: null, claimedAt: null },
    }),
  ]);
  const expired = await database.emailDelivery.updateMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: new Date(now.getTime() - maximumAgeMs) },
    },
    data: { status: 'SKIPPED' },
  });
  const claimToken = randomUUID();
  const claimed = await database.$queryRaw<Claimed[]>`
    UPDATE ${table} SET "status" = 'SENDING', "claim_token" = ${claimToken}::uuid,
      "claimed_at" = ${now}, "attempts" = "attempts" + 1
    WHERE "id" IN (
      SELECT "id" FROM ${table} WHERE "status" = 'PENDING' AND "next_attempt_at" <= ${now}
      ORDER BY "created_at", "id" LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    ) RETURNING "id", "notification_id", "attempts"
  `;
  const result: EmailBatchResult = {
    claimed: claimed.length,
    accepted: 0,
    skipped: expired.count,
    retrying: 0,
    failed: 0,
  };
  await Promise.all(
    claimed.map(async (item) => {
      const where = { id: item.id, status: 'SENDING' as const, claimToken };
      let outcome: 'accepted' | 'retry' | 'rejected' | 'skipped';
      try {
        const row = await eligible(item.id, claimToken, now);
        if (!row) outcome = 'skipped';
        else {
          const address = await bounded(
            () => dependencies.recipients.resolve(row.notification.recipientId),
            5_000,
          );
          if (
            !address ||
            !/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(address) ||
            !(await eligible(item.id, claimToken, now))
          )
            outcome = 'skipped';
          else
            outcome = await bounded(
              (signal) =>
                dependencies.sender.send({
                  to: address,
                  subject: notificationTitles[row.notification.type],
                  text: 'You have a new update in Travel Buddy. Open the app to view details and manage your email preferences.',
                  idempotencyKey: `email-notification:${item.notification_id}`,
                  signal,
                }),
              10_000,
            );
        }
      } catch {
        // Provider errors may contain addresses or credentials. Keep only the
        // generic retry result; never log/store the raw error or response.
        outcome = 'retry';
      }
      const retrying = outcome === 'retry' && item.attempts < maximumAttempts;
      const status =
        outcome === 'accepted'
          ? 'SENT'
          : outcome === 'skipped'
            ? 'SKIPPED'
            : retrying
              ? 'PENDING'
              : 'FAILED';
      const changed = await database.emailDelivery.updateMany({
        where,
        data: {
          status,
          claimToken: null,
          claimedAt: null,
          ...(outcome === 'accepted' && { sentAt: now }),
          ...(retrying && {
            nextAttemptAt: new Date(
              now.getTime() + (retryDelaysMs[item.attempts - 1] ?? 0),
            ),
          }),
        },
      });
      if (changed.count) {
        if (status === 'SENT') result.accepted++;
        else if (status === 'SKIPPED') result.skipped++;
        else if (status === 'PENDING') result.retrying++;
        else result.failed++;
      }
    }),
  );
  return result;
}

export interface EmailDeliveryWorker {
  stop(): Promise<void>;
}
export function startEmailDelivery(
  dependencies: EmailDeliveryDependencies,
  logger: FastifyBaseLogger,
): EmailDeliveryWorker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const schedule = (delay: number) => {
    if (!stopped)
      timer = setTimeout(() => {
        running = deliver();
      }, delay);
  };
  const deliver = async () => {
    try {
      const result = await processEmailBatch(dependencies);
      if (result.claimed || result.skipped)
        logger.info({ email: result }, 'Email notification batch processed');
      schedule(result.claimed ? 0 : pollMs);
    } catch {
      logger.error(
        { code: 'EMAIL_BATCH_FAILED' },
        'Email notification batch failed',
      );
      schedule(pollMs);
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
