import { database } from '../../database/client.js';
import { createNotifications } from '../notifications/notification.repository.js';
import { lockActiveCommunity } from '../communities/community-lock.js';
import { AppError } from '../../errors/app-error.js';
import { requireFeatureAllowed } from '../moderation/restriction.repository.js';
import {
  alertLimitWindowMs,
  lockOwnerAlertBudget,
  maximumAlertingPublicationsPerOwner,
} from '../trip-alerts/trip-alert.limits.js';
import { publicTripInclude } from './trip.types.js';
import type { TripManagementRepository } from './trip-management.types.js';
import { recordTripChange, tripHistorySelect } from './trip-history.js';

export const prismaTripManagementRepository: TripManagementRepository = {
  async isActiveCommunity(communityId) {
    return (
      (await database.community.count({
        where: { id: communityId, status: 'ACTIVE' },
      })) === 1
    );
  },

  create(input) {
    return database.$transaction(async (transaction) => {
      if (!(await lockActiveCommunity(transaction, input.communityId))) {
        throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
      }
      const trip = await transaction.trip.create({
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
      await recordTripChange(transaction, null, trip, 'CREATED', input.ownerId);
      return trip;
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
      // Publishing and republishing; drafts, edits and closing stay allowed.
      if (data.status === 'PUBLISHED') {
        await requireFeatureAllowed(transaction, ownerId, 'TRIP_PUBLISHING');
      }
      if (
        typeof data.communityId === 'string' &&
        !(await lockActiveCommunity(transaction, data.communityId))
      ) {
        throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
      }
      const before = await transaction.trip.findUnique({
        where: { id },
        select: tripHistorySelect,
      });
      const result = await transaction.trip.updateMany({
        where: {
          id,
          ownerId,
          version: expectedVersion,
          status: { in: allowedStatuses },
          moderationRemovedAt: null,
        },
        data: { ...data, version: { increment: 1 } },
      });
      if (result.count !== 1) return null;
      if (typeof data.currentGroupSize === 'number') {
        // The update above holds the trip row lock. Accept, leave, and remove
        // all update that row too, so they cannot commit a membership change
        // that this count misses.
        const activeMembers = await transaction.tripMembership.count({
          where: { tripId: id, status: 'ACTIVE' },
        });
        if (data.currentGroupSize < activeMembers) {
          throw new AppError(
            409,
            'GROUP_SIZE_BELOW_ACTIVE_MEMBERS',
            `currentGroupSize cannot be lower than the ${activeMembers} active trip members.`,
          );
        }
      }
      const trip = await transaction.trip.findUniqueOrThrow({
        where: { id },
        include: publicTripInclude,
      });
      await recordTripChange(
        transaction,
        before,
        trip,
        data.status !== undefined ? 'STATUS_CHANGED' : 'OWNER_UPDATED',
        ownerId,
      );
      if (data.status === 'PUBLISHED' && data.publishedAt && trip.publishedAt) {
        // Beyond the owner's daily alert budget the trip is still published
        // and searchable; it just does not alert saved searches. The lock
        // makes the owner's concurrent publications count one at a time.
        await lockOwnerAlertBudget(transaction, ownerId);
        const recentAlertingPublications =
          await transaction.tripPublicationAlert.count({
            where: {
              trip: { ownerId },
              publishedAt: {
                gt: new Date(trip.publishedAt.getTime() - alertLimitWindowMs),
              },
            },
          });
        if (recentAlertingPublications < maximumAlertingPublicationsPerOwner) {
          await transaction.tripPublicationAlert.createMany({
            data: [
              {
                tripId: trip.id,
                communityId: trip.communityId,
                publishedAt: trip.publishedAt,
              },
            ],
            skipDuplicates: true,
          });
        }
      }
      const statusChanged = data.status !== undefined;
      const planChanged = Object.keys(data).some((field) =>
        [
          'communityId',
          'originCity',
          'startDate',
          'endDate',
          'flexibilityDays',
          'dateMode',
          'weekendsOnly',
          'durationDays',
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
