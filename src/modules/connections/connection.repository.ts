import { Prisma } from '@prisma/client';

import { database } from '../../database/client.js';
import { createNotifications } from '../notifications/notification.repository.js';
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

      const requesterActive = await transaction.user.count({
        where: { id: request.requesterId, status: 'ACTIVE', deletedAt: null },
      });
      if (requesterActive !== 1) return { kind: 'requester_unavailable' };

      const blockCount = await transaction.userBlock.count({
        where: {
          OR: [
            {
              blockerId: request.requesterId,
              blockedId: request.recipientId,
            },
            {
              blockerId: request.recipientId,
              blockedId: request.requesterId,
            },
          ],
        },
      });
      if (blockCount > 0) {
        await transaction.connectionRequest.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            status: 'BLOCKED',
            decidedById: recipientId,
            decidedAt: now,
          },
        });
        return { kind: 'blocked' };
      }

      const trip = await transaction.trip.findUnique({
        where: { id: request.tripId },
        select: {
          id: true,
          ownerId: true,
          version: true,
          status: true,
          moderationRemovedAt: true,
          currentGroupSize: true,
          desiredGroupSize: true,
        },
      });
      if (!trip || trip.status !== 'PUBLISHED' || trip.moderationRemovedAt) {
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

      const conversation = await transaction.conversation.upsert({
        where: { tripId: request.tripId },
        create: { tripId: request.tripId },
        update: {},
        select: { id: true },
      });
      for (const userId of [trip.ownerId, request.requesterId]) {
        await transaction.conversationParticipant.upsert({
          where: {
            conversationId_userId: {
              conversationId: conversation.id,
              userId,
            },
          },
          create: { conversationId: conversation.id, userId, joinedAt: now },
          update: {},
        });
      }

      const nextGroupSize = trip.currentGroupSize + 1;
      const tripUpdate = await transaction.trip.updateMany({
        where: {
          id: trip.id,
          version: trip.version,
          status: 'PUBLISHED',
          moderationRemovedAt: null,
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
      await createNotifications(transaction, {
        recipientIds: [request.requesterId],
        type: 'CONNECTION_REQUEST_ACCEPTED',
        eventKey: `connection-request:${id}:accepted`,
        sourceId: id,
        tripId: request.tripId,
        actorId: recipientId,
        createdAt: now,
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
        moderationRemovedAt: null,
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
          moderationRemovedAt: null,
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

  async isBlockedEitherDirection(userAId, userBId) {
    return (
      (await database.userBlock.count({
        where: {
          OR: [
            { blockerId: userAId, blockedId: userBId },
            { blockerId: userBId, blockedId: userAId },
          ],
        },
      })) > 0
    );
  },

  create(input) {
    return database.$transaction(async (transaction) => {
      const request = await transaction.connectionRequest.create({
        data: input,
        include: connectionRequestInclude,
      });
      await createNotifications(transaction, {
        recipientIds: [request.recipientId],
        type: 'CONNECTION_REQUEST_RECEIVED',
        eventKey: `connection-request:${request.id}:received`,
        sourceId: request.id,
        tripId: request.tripId,
        actorId: request.requesterId,
      });
      return request;
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
    return database.$transaction(async (transaction) => {
      const result = await transaction.connectionRequest.updateMany({
        where: { id, [actorField]: actorId, status: 'PENDING' },
        data: {
          status,
          ...(status === 'DECLINED'
            ? { decidedById: actorId, decidedAt: now }
            : { withdrawnAt: now }),
        },
      });
      if (result.count !== 1) return null;
      const request = await transaction.connectionRequest.findUniqueOrThrow({
        where: { id },
        include: connectionRequestInclude,
      });
      await createNotifications(transaction, {
        recipientIds: [
          status === 'DECLINED' ? request.requesterId : request.recipientId,
        ],
        type:
          status === 'DECLINED'
            ? 'CONNECTION_REQUEST_DECLINED'
            : 'CONNECTION_REQUEST_WITHDRAWN',
        eventKey: `connection-request:${id}:${status.toLowerCase()}`,
        sourceId: id,
        tripId: request.tripId,
        actorId,
        createdAt: now,
      });
      return request;
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
