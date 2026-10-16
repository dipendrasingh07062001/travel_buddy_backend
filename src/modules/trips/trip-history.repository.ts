import { database } from '../../database/client.js';
import { Prisma } from '../../generated/prisma/client.js';

export interface TripHistoryQuery {
  pageSize: number;
  beforeVersion?: number;
}

export interface TripHistoryPage {
  currentVersion: number;
  data: Array<{
    id: string;
    version: number;
    action: string;
    changes: Prisma.JsonValue;
    createdAt: string;
    actor: { id: string; displayName: string | null } | null;
  }>;
  pagination: { pageSize: number; nextBeforeVersion: number | null };
}

export interface TripHistoryRepository {
  list(
    tripId: string,
    userId: string,
    query: TripHistoryQuery,
  ): Promise<TripHistoryPage | null>;
}

export const prismaTripHistoryRepository: TripHistoryRepository = {
  list(tripId, userId, query) {
    return database.$transaction(
      async (tx) => {
        const trip = await tx.trip.findUnique({
          where: { id: tripId },
          select: {
            ownerId: true,
            version: true,
            publishedAt: true,
            moderationRemovedAt: true,
            memberships: {
              where: { userId, status: 'ACTIVE' },
              select: { joinedAt: true, historyFromVersion: true },
            },
          },
        });
        if (!trip || trip.moderationRemovedAt) return null;
        const owner = trip.ownerId === userId;
        const member = trip.memberships[0];
        if (!owner && (!member || !trip.publishedAt)) return null;
        if (
          !owner &&
          (await tx.userBlock.count({
            where: {
              OR: [
                { blockerId: userId, blockedId: trip.ownerId },
                { blockerId: trip.ownerId, blockedId: userId },
              ],
            },
          }))
        )
          return null;

        const minimumVersion = owner
          ? undefined
          : (member?.historyFromVersion ?? undefined);
        const since =
          !owner && minimumVersion === undefined && member && trip.publishedAt
            ? new Date(
                Math.max(member.joinedAt.getTime(), trip.publishedAt.getTime()),
              )
            : undefined;
        const where: Prisma.TripChangeWhereInput = {
          tripId,
          version: {
            lte: trip.version,
            ...(query.beforeVersion !== undefined && {
              lt: query.beforeVersion,
            }),
            ...(minimumVersion !== undefined && { gte: minimumVersion }),
          },
          // Old memberships have no version boundary. Only post-join,
          // post-publication records are visible; no invented legacy history.
          ...(since && { createdAt: { gte: since } }),
        };
        const rows = await tx.tripChange.findMany({
          where,
          orderBy: { version: 'desc' },
          take: query.pageSize + 1,
        });
        const more = rows.length > query.pageSize;
        const page = rows.slice(0, query.pageSize);
        const actorIds = [
          ...new Set(page.flatMap((row) => (row.actorId ? [row.actorId] : []))),
        ];
        const actors = await tx.user.findMany({
          where: {
            id: { in: actorIds },
            status: 'ACTIVE',
            deletedAt: null,
            tripMemberships: { some: { tripId, status: 'ACTIVE' } },
            blocksCreated: { none: { blockedId: userId } },
            blocksReceived: { none: { blockerId: userId } },
          },
          select: { id: true, displayName: true },
        });
        const byId = new Map(actors.map((actor) => [actor.id, actor]));
        return {
          currentVersion: trip.version,
          data: page.map((row) => ({
            id: row.id,
            version: row.version,
            action: row.action,
            changes: row.changes,
            createdAt: row.createdAt.toISOString(),
            actor: row.actorId ? (byId.get(row.actorId) ?? null) : null,
          })),
          pagination: {
            pageSize: query.pageSize,
            nextBeforeVersion: more ? page.at(-1)!.version : null,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  },
};
