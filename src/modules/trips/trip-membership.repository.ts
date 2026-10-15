import { database } from '../../database/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  ownMembershipSelect,
  type TripMembershipRepository,
} from './trip-membership.types.js';
import { publicTripInclude } from './trip.types.js';

export const prismaTripMembershipRepository: TripMembershipRepository = {
  listForUser(userId, query) {
    const where: Prisma.TripMembershipWhereInput = {
      // Never accept the owner of the history from query parameters.
      userId,
      ...(query.role && { role: query.role }),
      ...(query.view === 'active' && { status: 'ACTIVE' }),
      ...(query.view === 'history' && { status: { in: ['LEFT', 'REMOVED'] } }),
      ...(query.view === 'active' &&
        query.tripStatus && { trip: { status: query.tripStatus } }),
    };

    return database.$transaction(
      async (tx) => {
        const totalItems = await tx.tripMembership.count({ where });
        const memberships = await tx.tripMembership.findMany({
          where,
          select: ownMembershipSelect,
          orderBy: [{ joinedAt: 'desc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });

        // Former members retain their own membership facts, not access to
        // the current trip. Do not even hydrate those trips from the database.
        const activeTripIds = memberships
          .filter((membership) => membership.status === 'ACTIVE')
          .map((membership) => membership.tripId);
        const trips = activeTripIds.length
          ? await tx.trip.findMany({
              where: { id: { in: activeTripIds } },
              include: publicTripInclude,
            })
          : [];
        const byId = new Map(trips.map((trip) => [trip.id, trip]));
        return {
          totalItems,
          items: memberships.map((membership) => ({
            membership,
            trip:
              membership.status === 'ACTIVE'
                ? (byId.get(membership.tripId) ?? null)
                : null,
          })),
        };
      },
      {
        // Counts, membership state and trip details must share a snapshot.
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
  },
};
