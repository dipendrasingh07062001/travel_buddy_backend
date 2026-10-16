import type { FastifyBaseLogger } from 'fastify';
import { database, databaseSchema } from '../../database/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { createNotifications } from '../notifications/notification.repository.js';
import { utcStartOfToday } from '../trips/trip.types.js';
import { matchesTripAlert } from './trip-alert.matcher.js';

const defaultBatchSize = 100;
const intervalMs = 5_000;

function table(
  name: 'trip_publication_alerts' | 'trip_alert_subscriptions' | 'trips',
) {
  return Prisma.raw(`"${databaseSchema.replace(/"/g, '""')}"."${name}"`);
}

export interface TripAlertBatchResult {
  tripId: string | null;
  examined: number;
  matchedRecipients: number;
  hasMore: boolean;
}

// Each batch and its cursor commit together. A crash rolls back both, and the
// unique notification event key deduplicates overlapping subscriptions/batches.
export async function processTripAlertBatch(
  options: { now?: Date; batchSize?: number } = {},
): Promise<TripAlertBatchResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? defaultBatchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error('Trip alert batchSize must be between 1 and 100.');
  let claimedId: string | undefined;
  try {
    return await database.$transaction(
      async (tx) => {
        const result: TripAlertBatchResult = {
          tripId: null,
          examined: 0,
          matchedRecipients: 0,
          hasMore: false,
        };
        const [job] = await tx.$queryRaw<
          {
            trip_id: string;
            community_id: string;
            published_at: Date;
            cursor_id: string | null;
          }[]
        >`
        SELECT "trip_id", "community_id", "published_at", "cursor_id" FROM ${table('trip_publication_alerts')}
        WHERE "completed_at" IS NULL AND "next_attempt_at" <= ${now}
        ORDER BY "next_attempt_at", "published_at", "trip_id"
        LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
        if (!job) return result;
        claimedId = job.trip_id;
        result.tripId = job.trip_id;
        // Serialize with publication, cancellation, membership capacity and
        // moderation changes. Eligibility is rechecked on every batch.
        await tx.$queryRaw`SELECT "id" FROM ${table('trips')} WHERE "id" = ${job.trip_id}::uuid FOR UPDATE`;
        const trip = await tx.trip.findUniqueOrThrow({
          where: { id: job.trip_id },
          include: {
            owner: { select: { status: true, deletedAt: true } },
            community: { select: { status: true } },
          },
        });
        if (
          trip.status !== 'PUBLISHED' ||
          trip.communityId !== job.community_id ||
          trip.currentGroupSize >= trip.desiredGroupSize ||
          trip.moderationRemovedAt ||
          trip.endDate < utcStartOfToday(now) ||
          trip.owner.status !== 'ACTIVE' ||
          trip.owner.deletedAt ||
          trip.community.status !== 'ACTIVE'
        ) {
          await tx.tripPublicationAlert.update({
            where: { tripId: trip.id },
            data: { completedAt: now },
          });
          return result;
        }
        // Lock the selected saved searches before checking their current state.
        // Pause/delete that committed first wins; once this transaction commits,
        // an unsubscribe stops future batches, not already-created inbox entries.
        const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM ${table('trip_alert_subscriptions')}
        WHERE "community_id" = ${trip.communityId}::uuid AND "enabled" = true
          AND "updated_at" <= ${job.published_at}
          ${job.cursor_id ? Prisma.sql`AND "id" > ${job.cursor_id}::uuid` : Prisma.empty}
        ORDER BY "id" LIMIT ${batchSize} FOR UPDATE
      `;
        const subscriptions = await tx.tripAlertSubscription.findMany({
          where: {
            id: { in: candidates.map((row) => row.id) },
            enabled: true,
            communityId: trip.communityId,
            updatedAt: { lte: job.published_at },
            userId: { not: trip.ownerId },
            user: {
              status: 'ACTIVE',
              deletedAt: null,
              blocksCreated: { none: { blockedId: trip.ownerId } },
              blocksReceived: { none: { blockerId: trip.ownerId } },
              tripMemberships: { none: { tripId: trip.id, status: 'ACTIVE' } },
            },
          },
        });
        const recipients = [
          ...new Set(
            subscriptions
              .filter((item) => matchesTripAlert(item, trip))
              .map((item) => item.userId),
          ),
        ];
        await createNotifications(tx, {
          recipientIds: recipients,
          type: 'MATCHING_TRIP_PUBLISHED',
          eventKey: `trip:${trip.id}:matching-published`,
          sourceId: trip.id,
          tripId: trip.id,
          actorId: trip.ownerId,
          createdAt: now,
          pushEligible: false,
        });
        result.examined = candidates.length;
        result.matchedRecipients = recipients.length;
        result.hasMore = candidates.length === batchSize;
        await tx.tripPublicationAlert.update({
          where: { tripId: trip.id },
          data: {
            cursorId: candidates.at(-1)?.id ?? job.cursor_id,
            nextAttemptAt: now,
            ...(!result.hasMore && { completedAt: now }),
          },
        });
        return result;
      },
      { timeout: 15_000 },
    );
  } catch (error) {
    // Rollback leaves the cursor unchanged. Back off this job so one failed
    // event cannot indefinitely starve other publications. No criteria in logs.
    if (claimedId)
      await database.tripPublicationAlert.updateMany({
        where: { tripId: claimedId, completedAt: null },
        data: {
          failedAttempts: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + 60_000),
        },
      });
    throw error;
  }
}

export interface TripAlertWorker {
  stop(): Promise<void>;
}

export function startTripAlerts(logger: FastifyBaseLogger): TripAlertWorker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const schedule = (delay: number) => {
    if (!stopped)
      timer = setTimeout(() => {
        running = process();
      }, delay);
  };
  const process = async () => {
    try {
      const result = await processTripAlertBatch();
      if (result.tripId)
        logger.info(
          { tripAlerts: result },
          'Matching-trip alert batch processed',
        );
      schedule(result.tripId ? 0 : intervalMs);
    } catch (error) {
      logger.error({ err: error }, 'Matching-trip alert batch failed');
      schedule(intervalMs);
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
