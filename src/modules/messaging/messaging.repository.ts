import type { TripStatus } from '@prisma/client';

import { database } from '../../database/client.js';
import {
  messageInclude,
  roomSelect,
  type MessagingRepository,
} from './messaging.types.js';

function isReadOnlyTrip(status: TripStatus): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED';
}

function activeMemberWhere(tripId: string, userId: string) {
  return { tripId, userId, status: 'ACTIVE' as const };
}

export const prismaMessagingRepository: MessagingRepository = {
  findRoom(tripId, userId) {
    return database.conversation.findFirst({
      where: {
        tripId,
        trip: { memberships: { some: activeMemberWhere(tripId, userId) } },
      },
      select: roomSelect,
    });
  },

  async listMessages(tripId, userId, query) {
    const room = await database.conversation.findFirst({
      where: {
        tripId,
        trip: { memberships: { some: activeMemberWhere(tripId, userId) } },
      },
      select: { id: true },
    });
    if (!room) return { kind: 'room_not_found' };

    const blocks = await database.userBlock.findMany({
      where: {
        OR: [{ blockerId: userId }, { blockedId: userId }],
      },
      select: { blockerId: true, blockedId: true },
    });
    const blockedUserIds = blocks.map((block) =>
      block.blockerId === userId ? block.blockedId : block.blockerId,
    );

    let cursorBoundary: { createdAt: Date; id: string } | null | undefined =
      undefined;
    if (query.cursor) {
      cursorBoundary = await database.message.findFirst({
        where: {
          id: query.cursor,
          conversationId: room.id,
        },
        select: { createdAt: true, id: true },
      });
      if (!cursorBoundary) return { kind: 'invalid_cursor' };
    }

    const messages = await database.message.findMany({
      where: {
        conversationId: room.id,
        senderId: { notIn: blockedUserIds },
        ...(cursorBoundary && {
          OR: [
            { createdAt: { lt: cursorBoundary.createdAt } },
            {
              createdAt: cursorBoundary.createdAt,
              id: { lt: cursorBoundary.id },
            },
          ],
        }),
      },
      include: messageInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.pageSize + 1,
    });
    const hasMore = messages.length > query.pageSize;
    const page = hasMore ? messages.slice(0, query.pageSize) : messages;
    return {
      kind: 'ok',
      messages: page,
      nextCursor: hasMore ? page.at(-1)!.id : null,
    };
  },

  createMessage(tripId, senderId, body, now) {
    return database.$transaction(async (transaction) => {
      const room = await transaction.conversation.findFirst({
        where: {
          tripId,
          trip: {
            memberships: { some: activeMemberWhere(tripId, senderId) },
          },
        },
        select: {
          id: true,
          trip: {
            select: {
              status: true,
              memberships: {
                where: { status: 'ACTIVE' },
                select: { userId: true },
              },
            },
          },
        },
      });
      if (!room) return { kind: 'room_not_found' } as const;
      if (isReadOnlyTrip(room.trip.status)) {
        return { kind: 'read_only' } as const;
      }

      const recipientIds = room.trip.memberships
        .map((membership) => membership.userId)
        .filter((userId) => userId !== senderId);
      if (recipientIds.length === 0) return { kind: 'no_recipients' } as const;
      const blocks = await transaction.userBlock.findMany({
        where: {
          OR: [
            { blockerId: senderId, blockedId: { in: recipientIds } },
            { blockedId: senderId, blockerId: { in: recipientIds } },
          ],
        },
        select: { blockerId: true, blockedId: true },
      });
      const blockedIds = new Set(
        blocks.map((block) =>
          block.blockerId === senderId ? block.blockedId : block.blockerId,
        ),
      );
      if (recipientIds.every((id) => blockedIds.has(id))) {
        return { kind: 'blocked' } as const;
      }

      const message = await transaction.message.create({
        data: { conversationId: room.id, senderId, body, createdAt: now },
        include: messageInclude,
      });
      await transaction.conversation.update({
        where: { id: room.id },
        data: { updatedAt: now },
      });
      return { kind: 'created', message } as const;
    });
  },

  changeMessage(messageId, senderId, action, body, now) {
    return database.$transaction(async (transaction) => {
      const message = await transaction.message.findFirst({
        where: {
          id: messageId,
          senderId,
          conversation: {
            trip: {
              memberships: { some: { userId: senderId, status: 'ACTIVE' } },
            },
          },
        },
        include: {
          ...messageInclude,
          conversation: { select: { trip: { select: { status: true } } } },
        },
      });
      if (!message) return { kind: 'not_found' } as const;
      if (isReadOnlyTrip(message.conversation.trip.status)) {
        return { kind: 'read_only' } as const;
      }
      if (message.status === 'DELETED') {
        return { kind: 'invalid_state', status: message.status } as const;
      }

      await transaction.messageRevision.create({
        data: {
          messageId,
          editorId: senderId,
          action,
          previousBody: message.body,
          createdAt: now,
        },
      });
      const updated = await transaction.message.update({
        where: { id: messageId },
        data:
          action === 'EDIT'
            ? { body: body!, status: 'EDITED', editedAt: now }
            : { status: 'DELETED', deletedAt: now },
        include: messageInclude,
      });
      return { kind: 'updated', message: updated } as const;
    });
  },

  async markRead(tripId, userId, now) {
    const room = await database.conversation.findFirst({
      where: {
        tripId,
        trip: { memberships: { some: activeMemberWhere(tripId, userId) } },
      },
      select: { id: true },
    });
    if (!room) return false;
    await database.conversationParticipant.upsert({
      where: {
        conversationId_userId: { conversationId: room.id, userId },
      },
      create: { conversationId: room.id, userId, lastReadAt: now },
      update: { lastReadAt: now },
    });
    return true;
  },

  async setMuted(tripId, userId, muted, now) {
    const room = await database.conversation.findFirst({
      where: {
        tripId,
        trip: { memberships: { some: activeMemberWhere(tripId, userId) } },
      },
      select: { id: true },
    });
    if (!room) return null;
    await database.conversationParticipant.upsert({
      where: {
        conversationId_userId: { conversationId: room.id, userId },
      },
      create: {
        conversationId: room.id,
        userId,
        mutedAt: muted ? now : null,
      },
      update: { mutedAt: muted ? now : null },
    });
    return database.conversation.findUnique({
      where: { id: room.id },
      select: roomSelect,
    });
  },
};
