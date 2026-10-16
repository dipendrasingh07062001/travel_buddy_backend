import { database, databaseSchema } from '../../database/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { createNotifications } from '../notifications/notification.repository.js';
import { utcStartOfToday } from '../trips/trip.types.js';
import { recordTripChange, tripHistorySelect } from '../trips/trip-history.js';
import {
  connectionRequestInclude,
  membershipInclude,
  type AcceptResult,
  type ConnectionRepository,
} from './connection.types.js';

class RetryAcceptance extends Error {}

const maximumRequestsPerDay = 20;
const requestWindowMilliseconds = 24 * 60 * 60 * 1000;
const quotaUsersTable = Prisma.raw(
  `"${databaseSchema.replace(/"/g, '""')}"."users"`,
);

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
          ...tripHistorySelect,
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

      // Someone who left and asked to join again gets their old membership
      // back, now linked to the new request.
      const previous = await transaction.tripMembership.findUnique({
        where: {
          tripId_userId: {
            tripId: request.tripId,
            userId: request.requesterId,
          },
        },
        select: { id: true, status: true },
      });
      if (previous && previous.status !== 'LEFT') return { kind: 'conflict' };
      if (previous) {
        await transaction.tripMembership.update({
          where: { id: previous.id },
          data: {
            status: 'ACTIVE',
            role: 'MEMBER',
            connectionRequestId: request.id,
            joinedAt: now,
            historyFromVersion: trip.version + 1,
            leftAt: null,
          },
        });
      } else {
        await transaction.tripMembership.create({
          data: {
            tripId: request.tripId,
            userId: request.requesterId,
            connectionRequestId: request.id,
            role: 'MEMBER',
            joinedAt: now,
            historyFromVersion: trip.version + 1,
          },
        });
      }

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
      await recordTripChange(
        transaction,
        trip,
        {
          ...trip,
          version: trip.version + 1,
          currentGroupSize: nextGroupSize,
          status: nextGroupSize >= trip.desiredGroupSize ? 'FULL' : trip.status,
        },
        'MEMBER_JOINED',
        recipientId,
        now,
      );

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
        endDate: { gte: utcStartOfToday() },
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

  findLatest(tripId, requesterId) {
    return database.connectionRequest.findFirst({
      where: { tripId, requesterId },
      include: connectionRequestInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  async findMembershipStatus(tripId, userId) {
    const membership = await database.tripMembership.findUnique({
      where: { tripId_userId: { tripId, userId } },
      select: { status: true },
    });
    return membership?.status ?? null;
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

  createWithinDailyLimit(input) {
    return database.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        // One quota decision per requester, across trips and API instances.
        // NO KEY UPDATE still permits the FK key-share locks taken when two
        // travellers request each other's trips at the same time.
        await transaction.$queryRaw`SELECT id FROM ${quotaUsersTable} WHERE id = ${input.requesterId}::uuid FOR NO KEY UPDATE`;

        // Read the database clock after waiting for the lock. Transaction-start
        // time and API-machine clocks could otherwise make this window stale.
        const [clock] = await transaction.$queryRaw<{ now: Date }[]>`
          SELECT clock_timestamp() AS now
        `;
        if (!clock) throw new Error('Database clock unavailable.');
        const since = new Date(clock.now.getTime() - requestWindowMilliseconds);
        const recent = await transaction.connectionRequest.count({
          where: { requesterId: input.requesterId, createdAt: { gte: since } },
        });
        if (recent >= maximumRequestsPerDay) return null;

        const request = await transaction.connectionRequest.create({
          data: { ...input, createdAt: clock.now },
          include: connectionRequestInclude,
        });
        await createNotifications(transaction, {
          recipientIds: [request.recipientId],
          type: 'CONNECTION_REQUEST_RECEIVED',
          eventKey: `connection-request:${request.id}:received`,
          sourceId: request.id,
          tripId: request.tripId,
          actorId: request.requesterId,
          createdAt: clock.now,
        });
        return request;
      },
      {
        // Each count must see the previous lock holder's committed insert.
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 15_000,
      },
    );
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
