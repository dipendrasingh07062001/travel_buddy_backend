import { database } from '../../database/client.js';
import { createNotifications } from '../notifications/notification.repository.js';
import { publicTripInclude } from './trip.types.js';
import type { TripManagementRepository } from './trip-management.types.js';

export const prismaTripManagementRepository: TripManagementRepository = {
  async isActiveCommunity(communityId) {
    return (
      (await database.community.count({
        where: { id: communityId, status: 'ACTIVE' },
      })) === 1
    );
  },

  create(input) {
    return database.trip.create({
      data: {
        ...input,
        memberships: {
          create: { userId: input.ownerId, role: 'OWNER' },
        },
        conversation: {
          create: {
            participants: { create: { userId: input.ownerId } },
          },
        },
      },
      include: publicTripInclude,
    });
  },

  async listOwned(ownerId, query) {
    const where = {
      ownerId,
      ...(query.status && { status: query.status }),
    };
    const [trips, totalItems] = await database.$transaction([
      database.trip.findMany({
        where,
        include: publicTripInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      database.trip.count({ where }),
    ]);
    return { trips, totalItems };
  },

  findById(id) {
    return database.trip.findUnique({
      where: { id },
      include: publicTripInclude,
    });
  },

  async updateOwned(id, ownerId, expectedVersion, allowedStatuses, data) {
    return database.$transaction(async (transaction) => {
      const result = await transaction.trip.updateMany({
        where: {
          id,
          ownerId,
          version: expectedVersion,
          status: { in: allowedStatuses },
        },
        data: { ...data, version: { increment: 1 } },
      });
      if (result.count !== 1) return null;
      const trip = await transaction.trip.findUniqueOrThrow({
        where: { id },
        include: publicTripInclude,
      });
      const statusChanged = data.status !== undefined;
      const planChanged = Object.keys(data).some((field) =>
        [
          'communityId',
          'originCity',
          'startDate',
          'endDate',
          'desiredGroupSize',
          'currentGroupSize',
          'budgetMin',
          'budgetMax',
          'transport',
          'description',
        ].includes(field),
      );
      if (statusChanged || planChanged) {
        const members = await transaction.tripMembership.findMany({
          where: { tripId: id, status: 'ACTIVE' },
          select: { userId: true },
        });
        await createNotifications(transaction, {
          recipientIds: members.map((member) => member.userId),
          type: statusChanged ? 'TRIP_STATUS_CHANGED' : 'TRIP_UPDATED',
          eventKey: `trip:${id}:version:${trip.version}`,
          sourceId: id,
          tripId: id,
          actorId: ownerId,
        });
      }
      return trip;
    });
  },
};
