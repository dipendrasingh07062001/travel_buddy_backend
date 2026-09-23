import type { MessageStatus, Prisma } from '@prisma/client';

import { authenticatedUserSelect } from '../auth/auth.repository.js';
import { checklistItemInclude } from '../trip-room/trip-room.types.js';

export const roomSelect = {
  id: true,
  tripId: true,
  createdAt: true,
  updatedAt: true,
  trip: {
    select: {
      id: true,
      status: true,
      originCity: true,
      startDate: true,
      endDate: true,
      flexibilityDays: true,
      durationDays: true,
      transport: true,
      description: true,
      version: true,
      community: {
        select: {
          id: true,
          slug: true,
          name: true,
          region: true,
          countryCode: true,
        },
      },
      memberships: {
        where: { status: 'ACTIVE' },
        orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
        select: {
          role: true,
          joinedAt: true,
          user: { select: authenticatedUserSelect },
        },
      },
      checklistItems: {
        where: { status: { not: 'REMOVED' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: checklistItemInclude,
      },
    },
  },
  participants: {
    select: {
      userId: true,
      lastReadAt: true,
      mutedAt: true,
      joinedAt: true,
    },
  },
} satisfies Prisma.ConversationSelect;

export type RoomRecord = Prisma.ConversationGetPayload<{
  select: typeof roomSelect;
}>;

export const messageInclude = {
  sender: { select: authenticatedUserSelect },
} satisfies Prisma.MessageInclude;

export type MessageRecord = Prisma.MessageGetPayload<{
  include: typeof messageInclude;
}>;

export interface ListMessagesQuery {
  cursor?: string;
  pageSize: number;
}

export type ListMessagesResult =
  | { kind: 'ok'; messages: MessageRecord[]; nextCursor: string | null }
  | { kind: 'room_not_found' }
  | { kind: 'invalid_cursor' };

export type CreateMessageResult =
  | { kind: 'created'; message: MessageRecord }
  | { kind: 'room_not_found' }
  | { kind: 'read_only' }
  | { kind: 'no_recipients' }
  | { kind: 'blocked' };

export type ChangeMessageResult =
  | { kind: 'updated'; message: MessageRecord }
  | { kind: 'not_found' }
  | { kind: 'read_only' }
  | { kind: 'invalid_state'; status: MessageStatus };

export interface MessagingRepository {
  findRoom(tripId: string, userId: string): Promise<RoomRecord | null>;
  listMessages(
    tripId: string,
    userId: string,
    query: ListMessagesQuery,
  ): Promise<ListMessagesResult>;
  createMessage(
    tripId: string,
    senderId: string,
    body: string,
    now: Date,
  ): Promise<CreateMessageResult>;
  changeMessage(
    messageId: string,
    senderId: string,
    action: 'EDIT' | 'DELETE',
    body: string | null,
    now: Date,
  ): Promise<ChangeMessageResult>;
  markRead(tripId: string, userId: string, now: Date): Promise<boolean>;
  setMuted(
    tripId: string,
    userId: string,
    muted: boolean,
    now: Date,
  ): Promise<RoomRecord | null>;
}

export interface MessagingRouteDependencies {
  repository: MessagingRepository;
}
