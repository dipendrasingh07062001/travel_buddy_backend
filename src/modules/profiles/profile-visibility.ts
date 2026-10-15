import { database } from '../../database/client.js';
import { Prisma } from '../../generated/prisma/client.js';

const visibilitySelect = {
  id: true,
  profile: {
    select: { pastTripsVisibility: true, communityActivityVisibility: true },
  },
} satisfies Prisma.UserSelect;

export type ActivityProfile = Prisma.UserGetPayload<{
  select: typeof visibilitySelect;
}>;

export function visibleProfileWhere(
  userId: string,
  viewerId?: string,
): Prisma.UserWhereInput {
  return {
    id: userId,
    status: 'ACTIVE',
    deletedAt: null,
    ...(viewerId && {
      blocksCreated: { none: { blockedId: viewerId } },
      blocksReceived: { none: { blockerId: viewerId } },
    }),
  };
}

export function withVisibleProfile<T>(
  userId: string,
  viewerId: string | undefined,
  read: (tx: Prisma.TransactionClient, profile: ActivityProfile) => Promise<T>,
): Promise<T | null> {
  return database.$transaction(
    async (tx) => {
      const profile = await tx.user.findFirst({
        where: visibleProfileWhere(userId, viewerId),
        select: visibilitySelect,
      });
      if (!profile) return null;
      return read(tx, profile);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
