import { Prisma, type TripMembershipStatus } from '@prisma/client';

import { database } from '../../database/client.js';
import {
  checklistItemInclude,
  type MembershipMutationResult,
  type TripRoomRepository,
} from './trip-room.types.js';

class RetryMembershipMutation extends Error {}

function isReadOnly(status: string): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED';
}

async function changeMembershipOnce(
  tripId: string,
  actorId: string,
  memberId: string,
  status: Extract<TripMembershipStatus, 'LEFT' | 'REMOVED'>,
  now: Date,
): Promise<MembershipMutationResult> {
  return database.$transaction(
    async (transaction) => {
      const trip = await transaction.trip.findUnique({
        where: { id: tripId },
        select: {
          ownerId: true,
          status: true,
          version: true,
          currentGroupSize: true,
          memberships: {
            where: { userId: { in: [actorId, memberId] } },
            select: { id: true, userId: true, role: true, status: true },
          },
        },
      });
      if (!trip) return { kind: 'not_found' };

      const actor = trip.memberships.find(
        (membership) => membership.userId === actorId,
      );
      const member = trip.memberships.find(
        (membership) => membership.userId === memberId,
      );
      if (actor?.status !== 'ACTIVE' || member?.status !== 'ACTIVE') {
        return { kind: 'not_found' };
      }

      if (status === 'LEFT') {
        if (actorId !== memberId) return { kind: 'not_found' };
        if (member.role === 'OWNER') return { kind: 'owner_cannot_leave' };
      } else {
        if (trip.ownerId !== actorId || actor.role !== 'OWNER') {
          return { kind: 'not_found' };
        }
        if (member.role === 'OWNER') {
          return { kind: 'owner_cannot_be_removed' };
        }
      }

      if (isReadOnly(trip.status)) return { kind: 'read_only' };

      const membershipUpdate = await transaction.tripMembership.updateMany({
        where: { id: member.id, status: 'ACTIVE' },
        data:
          status === 'LEFT'
            ? { status, leftAt: now }
            : { status, removedAt: now },
      });
      if (membershipUpdate.count !== 1) throw new RetryMembershipMutation();

      const nextGroupSize = Math.max(1, trip.currentGroupSize - 1);
      const tripUpdate = await transaction.trip.updateMany({
        where: { id: tripId, version: trip.version },
        data: {
          currentGroupSize: nextGroupSize,
          version: { increment: 1 },
          ...(trip.status === 'FULL' && { status: 'PUBLISHED' }),
        },
      });
      if (tripUpdate.count !== 1) throw new RetryMembershipMutation();
      return { kind: 'updated' };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function changeMembership(
  tripId: string,
  actorId: string,
  memberId: string,
  status: Extract<TripMembershipStatus, 'LEFT' | 'REMOVED'>,
  now: Date,
): Promise<MembershipMutationResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await changeMembershipOnce(tripId, actorId, memberId, status, now);
    } catch (error) {
      const retryable =
        error instanceof RetryMembershipMutation ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034');
      if (!retryable) throw error;
    }
  }
  return { kind: 'conflict' };
}

export const prismaTripRoomRepository: TripRoomRepository = {
  createChecklistItem(input) {
    return database.$transaction(async (transaction) => {
      const trip = await transaction.trip.findFirst({
        where: {
          id: input.tripId,
          memberships: {
            some: { userId: input.actorId, status: 'ACTIVE' },
          },
        },
        select: { status: true },
      });
      if (!trip) return { kind: 'not_found' } as const;
      if (isReadOnly(trip.status)) return { kind: 'read_only' } as const;
      const item = await transaction.tripChecklistItem.create({
        data: {
          tripId: input.tripId,
          createdById: input.actorId,
          title: input.title,
          createdAt: input.now,
        },
        include: checklistItemInclude,
      });
      return { kind: 'updated', item } as const;
    });
  },

  updateChecklistItem(input) {
    return database.$transaction(async (transaction) => {
      const item = await transaction.tripChecklistItem.findFirst({
        where: {
          id: input.itemId,
          status: { not: 'REMOVED' },
          trip: {
            memberships: {
              some: { userId: input.actorId, status: 'ACTIVE' },
            },
          },
        },
        select: { id: true, trip: { select: { status: true } } },
      });
      if (!item) return { kind: 'not_found' } as const;
      if (isReadOnly(item.trip.status)) return { kind: 'read_only' } as const;

      const updated = await transaction.tripChecklistItem.update({
        where: { id: input.itemId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.completed === true && {
            status: 'COMPLETED',
            completedById: input.actorId,
            completedAt: input.now,
          }),
          ...(input.completed === false && {
            status: 'OPEN',
            completedById: null,
            completedAt: null,
          }),
        },
        include: checklistItemInclude,
      });
      return { kind: 'updated', item: updated } as const;
    });
  },

  removeChecklistItem(itemId, actorId, now) {
    return database.$transaction(async (transaction) => {
      const item = await transaction.tripChecklistItem.findFirst({
        where: {
          id: itemId,
          status: { not: 'REMOVED' },
          OR: [{ createdById: actorId }, { trip: { ownerId: actorId } }],
          trip: {
            memberships: { some: { userId: actorId, status: 'ACTIVE' } },
          },
        },
        select: { id: true, trip: { select: { status: true } } },
      });
      if (!item) return { kind: 'not_found' } as const;
      if (isReadOnly(item.trip.status)) return { kind: 'read_only' } as const;
      const updated = await transaction.tripChecklistItem.update({
        where: { id: itemId },
        data: { status: 'REMOVED', removedAt: now },
        include: checklistItemInclude,
      });
      return { kind: 'updated', item: updated } as const;
    });
  },

  leaveTrip(tripId, userId, now) {
    return changeMembership(tripId, userId, userId, 'LEFT', now);
  },

  removeMember(tripId, actorId, memberId, now) {
    return changeMembership(tripId, actorId, memberId, 'REMOVED', now);
  },
};
