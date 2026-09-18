import { database } from '../../database/client.js';
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
    const result = await database.trip.updateMany({
      where: {
        id,
        ownerId,
        version: expectedVersion,
        status: { in: allowedStatuses },
      },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count !== 1) return null;
    return database.trip.findUnique({
      where: { id },
      include: publicTripInclude,
    });
  },
};
