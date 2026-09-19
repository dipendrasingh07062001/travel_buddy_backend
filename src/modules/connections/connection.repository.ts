import { Prisma } from '@prisma/client';

import { database } from '../../database/client.js';
import {
  connectionRequestInclude,
  membershipInclude,
  type AcceptResult,
  type ConnectionRepository,
} from './connection.types.js';

class RetryAcceptance extends Error {}

async function acceptOnce(
  id: string,
  recipientId: string,
  now: Date,
): Promise<AcceptResult> {
  return database.$transaction(
    async (transaction) => {
      const request = await transaction.connectionRequest.findUnique({
        where: { id },
        include: connectionRequestInclude,
      });
      if (!request || request.recipientId !== recipientId) {
        return { kind: 'not_found' };
      }
      if (request.status !== 'PENDING') {
        return { kind: 'not_pending', request };
      }

      const trip = await transaction.trip.findUnique({
        where: { id: request.tripId },
        select: {
          id: true,
          version: true,
          status: true,
          currentGroupSize: true,
          desiredGroupSize: true,
        },
      });
      if (!trip || trip.status !== 'PUBLISHED') {
        return { kind: 'trip_unavailable' };
      }
      if (trip.currentGroupSize >= trip.desiredGroupSize) {
        return { kind: 'trip_full' };
      }

      const requestUpdate = await transaction.connectionRequest.updateMany({
        where: { id, recipientId, status: 'PENDING' },
        data: {
          status: 'ACCEPTED',
          decidedById: recipientId,
          decidedAt: now,
        },
      });
      if (requestUpdate.count !== 1) throw new RetryAcceptance();

      await transaction.tripMembership.create({
        data: {
          tripId: request.tripId,
          userId: request.requesterId,
          connectionRequestId: request.id,
          role: 'MEMBER',
          joinedAt: now,
        },
      });

      const nextGroupSize = trip.currentGroupSize + 1;
      const tripUpdate = await transaction.trip.updateMany({
        where: {
          id: trip.id,
          version: trip.version,
          status: 'PUBLISHED',
        },
        data: {
          currentGroupSize: nextGroupSize,
          version: { increment: 1 },
          ...(nextGroupSize >= trip.desiredGroupSize && { status: 'FULL' }),
        },
      });
      if (tripUpdate.count !== 1) throw new RetryAcceptance();

      const accepted = await transaction.connectionRequest.findUniqueOrThrow({
        where: { id },
        include: connectionRequestInclude,
      });
      return { kind: 'accepted', request: accepted };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export const prismaConnectionRepository: ConnectionRepository = {
  findRequestableTrip(tripId) {
    return database.trip.findFirst({
      where: {
        id: tripId,
        status: 'PUBLISHED',
        owner: { status: 'ACTIVE' },
      },
      select: {
        id: true,
        ownerId: true,
        status: true,
        currentGroupSize: true,
        desiredGroupSize: true,
      },
    });
  },

  async isOwnedPublicTrip(tripId, ownerId) {
    return (
      (await database.trip.count({
        where: {
          id: tripId,
          ownerId,
          status: { in: ['PUBLISHED', 'FULL'] },
        },
      })) === 1
    );
  },

  findExisting(tripId, requesterId) {
    return database.connectionRequest.findUnique({
      where: { tripId_requesterId: { tripId, requesterId } },
      include: connectionRequestInclude,
    });
  },

  countRecentByRequester(requesterId, since) {
    return database.connectionRequest.count({
      where: { requesterId, createdAt: { gte: since } },
    });
  },

  create(input) {
    return database.connectionRequest.create({
      data: input,
      include: connectionRequestInclude,
    });
  },

  async list(userId, query) {
    const where = {
      [query.box === 'received' ? 'recipientId' : 'requesterId']: userId,
      ...(query.status && { status: query.status }),
    };
    const [requests, totalItems] = await database.$transaction([
      database.connectionRequest.findMany({
        where,
        include: connectionRequestInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      database.connectionRequest.count({ where }),
    ]);
    return { requests, totalItems };
  },

  findById(id) {
    return database.connectionRequest.findUnique({
      where: { id },
      include: connectionRequestInclude,
    });
  },

  async setPendingStatus(id, actorId, actorField, status, now) {
    const result = await database.connectionRequest.updateMany({
      where: { id, [actorField]: actorId, status: 'PENDING' },
      data: {
        status,
        ...(status === 'DECLINED'
          ? { decidedById: actorId, decidedAt: now }
          : { withdrawnAt: now }),
      },
    });
    if (result.count !== 1) return null;
    return database.connectionRequest.findUnique({
      where: { id },
      include: connectionRequestInclude,
    });
  },

  async accept(id, recipientId, now) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await acceptOnce(id, recipientId, now);
      } catch (error) {
        const retryable =
          error instanceof RetryAcceptance ||
          (error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2034');
        if (!retryable) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            return { kind: 'conflict' };
          }
          throw error;
        }
      }
    }
    return { kind: 'conflict' };
  },

  async listActiveMembers(tripId, viewerId) {
    const viewer = await database.tripMembership.findUnique({
      where: { tripId_userId: { tripId, userId: viewerId } },
      select: { status: true },
    });
    if (viewer?.status !== 'ACTIVE') return null;
    return database.tripMembership.findMany({
      where: { tripId, status: 'ACTIVE' },
      include: membershipInclude,
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }, { id: 'asc' }],
    });
  },
};
