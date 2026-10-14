import type { FastifyBaseLogger } from 'fastify';

import { database } from '../../database/client.js';
import {
  deleteObjectQuietly,
  type ObjectStorage,
} from '../../storage/object-storage.js';
import { createNotifications } from '../notifications/notification.repository.js';

// Moderation records about a deleted account (reports, removed content and
// evidence copies of photos) are kept this long after erasure, then cleared.
export const moderationRecordRetentionMs = 365 * 24 * 60 * 60 * 1000;
const batchSize = 20;
const intervalMs = 10 * 60 * 1000;

// Removes the account from the sign-in provider, so the person's login is
// gone too. A sign-in with the same login later starts a new, empty account.
export interface SignInAccountRemover {
  remove(subject: string): Promise<void>;
}

export interface AccountErasureOptions {
  storage: ObjectStorage | null;
  signInAccounts?: SignInAccountRemover;
  logger: FastifyBaseLogger;
  now?: Date;
}

export interface AccountErasureResult {
  erased: number;
  purged: number;
}

interface ErasedAccount {
  photoKey: string | null;
  firebaseSubjects: string[];
}

function startOfUtcDay(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

// Erases one account whose grace period has ended. Returns null when the
// request is no longer due (cancelled, or erased by another API instance).
async function eraseAccount(
  requestId: string,
  userId: string,
  now: Date,
): Promise<ErasedAccount | null> {
  return database.$transaction(
    async (tx) => {
      const claimed = await tx.accountDataRequest.updateMany({
        where: { id: requestId, status: 'OPEN', scheduledFor: { lte: now } },
        data: { status: 'COMPLETED', completedAt: now },
      });
      if (claimed.count !== 1) return null;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          status: true,
          profile: { select: { profilePhotoStorageKey: true } },
          authAccounts: { select: { provider: true, providerSubject: true } },
        },
      });
      if (user.status !== 'PENDING_DELETION') {
        throw new Error(
          `Account ${userId} has a due deletion request but status ${user.status}.`,
        );
      }
      const today = startOfUtcDay(now);

      // Upcoming trips they own are cancelled, and their members are told.
      const ownedTrips = await tx.trip.findMany({
        where: {
          ownerId: userId,
          status: { in: ['DRAFT', 'PUBLISHED', 'PAUSED', 'FULL'] },
          startDate: { gt: today },
        },
        select: { id: true },
      });
      for (const trip of ownedTrips) {
        const cancelled = await tx.trip.update({
          where: { id: trip.id },
          data: { status: 'CANCELLED', version: { increment: 1 } },
          select: { version: true },
        });
        const members = await tx.tripMembership.findMany({
          where: { tripId: trip.id, status: 'ACTIVE' },
          select: { userId: true },
        });
        await createNotifications(tx, {
          recipientIds: members.map((member) => member.userId),
          type: 'TRIP_STATUS_CHANGED',
          eventKey: `trip:${trip.id}:version:${cancelled.version}`,
          sourceId: trip.id,
          tripId: trip.id,
          actorId: userId,
          createdAt: now,
        });
      }

      // They leave upcoming trips that others own, freeing their places.
      const memberships = await tx.tripMembership.findMany({
        where: {
          userId,
          role: 'MEMBER',
          status: 'ACTIVE',
          trip: {
            startDate: { gt: today },
            status: { in: ['PUBLISHED', 'PAUSED', 'FULL'] },
          },
        },
        select: { id: true, tripId: true },
      });
      for (const membership of memberships) {
        const [trip] = await tx.$queryRaw<
          { current_group_size: number; status: string }[]
        >`
          SELECT "current_group_size", "status" FROM "trips"
          WHERE "id" = ${membership.tripId}::uuid FOR UPDATE
        `;
        if (!trip) continue;
        await tx.tripMembership.update({
          where: { id: membership.id },
          data: { status: 'LEFT', leftAt: now },
        });
        await tx.trip.update({
          where: { id: membership.tripId },
          data: {
            currentGroupSize: Math.max(1, trip.current_group_size - 1),
            version: { increment: 1 },
            ...(trip.status === 'FULL' && { status: 'PUBLISHED' }),
          },
        });
      }

      // Nobody can answer their waiting join requests any more.
      const received = await tx.connectionRequest.findMany({
        where: { recipientId: userId, status: 'PENDING' },
        select: { id: true, requesterId: true, tripId: true },
      });
      for (const request of received) {
        await tx.connectionRequest.update({
          where: { id: request.id },
          data: { status: 'DECLINED', decidedById: userId, decidedAt: now },
        });
        await createNotifications(tx, {
          recipientIds: [request.requesterId],
          type: 'CONNECTION_REQUEST_DECLINED',
          eventKey: `connection-request:${request.id}:declined`,
          sourceId: request.id,
          tripId: request.tripId,
          actorId: userId,
          createdAt: now,
        });
      }
      const sent = await tx.connectionRequest.findMany({
        where: { requesterId: userId, status: 'PENDING' },
        select: { id: true, recipientId: true, tripId: true },
      });
      for (const request of sent) {
        await tx.connectionRequest.update({
          where: { id: request.id },
          data: { status: 'WITHDRAWN', withdrawnAt: now },
        });
        await createNotifications(tx, {
          recipientIds: [request.recipientId],
          type: 'CONNECTION_REQUEST_WITHDRAWN',
          eventKey: `connection-request:${request.id}:withdrawn`,
          sourceId: request.id,
          tripId: request.tripId,
          actorId: userId,
          createdAt: now,
        });
      }

      // Payments waiting for them to confirm, or confirm to them, can never
      // be settled now.
      const settlements = await tx.settlement.findMany({
        where: {
          status: 'PENDING',
          OR: [{ payerId: userId }, { receiverId: userId }],
        },
        select: { id: true, payerId: true, receiverId: true, tripId: true },
      });
      for (const settlement of settlements) {
        await tx.settlement.update({
          where: { id: settlement.id },
          data: { status: 'CANCELLED', cancelledAt: now },
        });
        await createNotifications(tx, {
          recipientIds: [settlement.payerId, settlement.receiverId],
          type: 'SETTLEMENT_CANCELLED',
          eventKey: `settlement:${settlement.id}:cancelled`,
          sourceId: settlement.id,
          tripId: settlement.tripId,
          actorId: userId,
          createdAt: now,
        });
      }

      // Public community content is taken down. The text stays for
      // moderation until the records are purged.
      await tx.communityPost.updateMany({
        where: { authorId: userId, status: { not: 'REMOVED' } },
        data: { status: 'REMOVED', removedAt: now },
      });
      await tx.communityComment.updateMany({
        where: { authorId: userId, status: { not: 'REMOVED' } },
        data: { status: 'REMOVED', removedAt: now },
      });

      // Personal data and sign-in links are deleted. Messages, expenses and
      // other shared trip history stay, attributed to a nameless account.
      await tx.userProfile.deleteMany({ where: { userId } });
      await tx.authAccount.deleteMany({ where: { userId } });
      await tx.authIdentity.deleteMany({ where: { userId } });
      await tx.pushDevice.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { recipientId: userId } });
      await tx.communityFollow.deleteMany({ where: { userId } });
      await tx.userBlock.deleteMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      });
      await tx.policyAcceptance.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'DELETED',
          statusBeforeDeletion: null,
          displayName: null,
          birthDate: null,
          staffRole: 'USER',
          deletedAt: now,
        },
      });

      return {
        photoKey: user.profile?.profilePhotoStorageKey ?? null,
        firebaseSubjects: user.authAccounts
          .filter((account) => account.provider === 'FIREBASE')
          .map((account) => account.providerSubject),
      };
    },
    { timeout: 30_000 },
  );
}

// A year after erasure, clears the deleted account's remaining text and the
// evidence copies of its photos. Returns the evidence objects to delete.
async function purgeModerationRecords(
  userId: string,
  now: Date,
): Promise<string[] | null> {
  return database.$transaction(async (tx) => {
    const claimed = await tx.user.updateMany({
      where: { id: userId, status: 'DELETED', recordsPurgedAt: null },
      data: { recordsPurgedAt: now },
    });
    if (claimed.count !== 1) return null;

    await tx.communityPost.updateMany({
      where: { authorId: userId },
      data: { title: '', body: '' },
    });
    await tx.communityComment.updateMany({
      where: { authorId: userId },
      data: { body: '' },
    });
    await tx.connectionRequest.updateMany({
      where: { requesterId: userId },
      data: { message: '' },
    });

    const reports = await tx.report.findMany({
      where: { reportedUserId: userId, evidenceStorageKey: { not: null } },
      select: { evidenceStorageKey: true },
    });
    const actions = await tx.moderationAction.findMany({
      where: {
        targetType: { in: ['USER', 'PROFILE_PHOTO'] },
        targetId: userId,
        evidenceStorageKey: { not: null },
      },
      select: { evidenceStorageKey: true },
    });
    await tx.report.updateMany({
      where: { reportedUserId: userId, evidenceStorageKey: { not: null } },
      data: { evidenceStorageKey: null },
    });
    await tx.moderationAction.updateMany({
      where: {
        targetType: { in: ['USER', 'PROFILE_PHOTO'] },
        targetId: userId,
        evidenceStorageKey: { not: null },
      },
      data: { evidenceStorageKey: null },
    });
    return [...reports, ...actions].flatMap((record) =>
      record.evidenceStorageKey ? [record.evidenceStorageKey] : [],
    );
  });
}

async function deleteFiles(
  options: AccountErasureOptions,
  bucket: 'public' | 'private',
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  if (!options.storage) {
    options.logger.warn(
      { bucket, keys },
      'File storage is not configured; delete these objects by hand',
    );
    return;
  }
  for (const key of new Set(keys)) {
    await deleteObjectQuietly(options.storage, bucket, key, options.logger);
  }
}

export async function processAccountErasures(
  options: AccountErasureOptions,
): Promise<AccountErasureResult> {
  const now = options.now ?? new Date();
  const result: AccountErasureResult = { erased: 0, purged: 0 };

  const due = await database.accountDataRequest.findMany({
    where: {
      type: 'ACCOUNT_DELETION',
      status: 'OPEN',
      scheduledFor: { lte: now },
    },
    orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
    take: batchSize,
    select: { id: true, userId: true },
  });
  for (const request of due) {
    try {
      const erased = await eraseAccount(request.id, request.userId, now);
      if (!erased) continue;
      result.erased += 1;
      options.logger.info({ userId: request.userId }, 'Account erased');
      await deleteFiles(
        options,
        'public',
        erased.photoKey ? [erased.photoKey] : [],
      );
      for (const subject of erased.firebaseSubjects) {
        try {
          await options.signInAccounts?.remove(subject);
        } catch (error) {
          options.logger.warn(
            { err: error, userId: request.userId },
            'Could not delete the Firebase sign-in account; delete it in the Firebase console',
          );
        }
      }
    } catch (error) {
      options.logger.error(
        { err: error, userId: request.userId },
        'Account erasure failed',
      );
    }
  }

  const purgeDue = await database.user.findMany({
    where: {
      status: 'DELETED',
      recordsPurgedAt: null,
      deletedAt: { lte: new Date(now.getTime() - moderationRecordRetentionMs) },
    },
    orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
    take: batchSize,
    select: { id: true },
  });
  for (const user of purgeDue) {
    try {
      const evidenceKeys = await purgeModerationRecords(user.id, now);
      if (!evidenceKeys) continue;
      result.purged += 1;
      await deleteFiles(options, 'private', evidenceKeys);
    } catch (error) {
      options.logger.error(
        { err: error, userId: user.id },
        'Purging moderation records failed',
      );
    }
  }
  return result;
}

export interface AccountErasureWorker {
  stop(): Promise<void>;
}

export function startAccountErasure(
  options: Omit<AccountErasureOptions, 'now'>,
): AccountErasureWorker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const run = async () => {
    try {
      const result = await processAccountErasures(options);
      if (result.erased > 0 || result.purged > 0) {
        options.logger.info({ accounts: result }, 'Account erasure processed');
      }
    } catch (error) {
      options.logger.error({ err: error }, 'Account erasure failed');
    }
    if (!stopped) {
      timer = setTimeout(() => {
        running = run();
      }, intervalMs);
    }
  };

  running = run();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
