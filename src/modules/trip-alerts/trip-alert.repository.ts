import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { lockActiveCommunity } from '../communities/community-lock.js';
import type { TripAlertRepository } from './trip-alert.types.js';

export const maximumTripAlerts = 20;

async function lockAccount(tx: Prisma.TransactionClient, userId: string) {
  // Serializes quota checks/updates and prevents stale authenticated writes
  // from recreating saved preferences after account deletion starts.
  const result = await tx.user.updateMany({
    where: { id: userId, status: 'ACTIVE', deletedAt: null },
    data: { updatedAt: new Date() },
  });
  if (result.count !== 1)
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is not active.');
}

function notFound(): never {
  throw new AppError(
    404,
    'TRIP_ALERT_NOT_FOUND',
    'Saved trip alert not found.',
  );
}

export const prismaTripAlertRepository: TripAlertRepository = {
  list(userId) {
    return database.tripAlertSubscription.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: maximumTripAlerts,
    });
  },
  create(userId, input) {
    return database.$transaction(async (tx) => {
      await lockAccount(tx, userId);
      if (!(await lockActiveCommunity(tx, input.communityId)))
        throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
      if (
        (await tx.tripAlertSubscription.count({ where: { userId } })) >=
        maximumTripAlerts
      )
        throw new AppError(
          409,
          'TRIP_ALERT_LIMIT_REACHED',
          'Keep at most 20 saved alerts, including paused alerts.',
        );
      return tx.tripAlertSubscription.create({ data: { userId, ...input } });
    });
  },
  replace(userId, id, version, input) {
    return database.$transaction(async (tx) => {
      await lockAccount(tx, userId);
      const record = await tx.tripAlertSubscription.findFirst({
        where: { id, userId },
      });
      if (!record) notFound();
      if (record.version !== version)
        throw new AppError(
          409,
          'TRIP_ALERT_VERSION_CONFLICT',
          'The saved alert changed. Refresh it before editing.',
        );
      // Pausing is always possible, even after a destination is archived.
      if (input.enabled && !(await lockActiveCommunity(tx, input.communityId)))
        throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
      if (
        !input.enabled &&
        !(await tx.community.findUnique({
          where: { id: input.communityId },
          select: { id: true },
        }))
      )
        throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
      return tx.tripAlertSubscription.update({
        where: { id },
        data: { ...input, version: { increment: 1 } },
      });
    });
  },
  remove(userId, id) {
    return database.$transaction(async (tx) => {
      await lockAccount(tx, userId);
      const result = await tx.tripAlertSubscription.deleteMany({
        where: { id, userId },
      });
      if (result.count !== 1) notFound();
    });
  },
};
