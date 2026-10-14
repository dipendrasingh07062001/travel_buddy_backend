import type { FastifyBaseLogger } from 'fastify';

import { database } from '../database/client.js';
import { presentMessage } from '../modules/messaging/messaging.presenter.js';
import { messageInclude } from '../modules/messaging/messaging.types.js';
import type { RealtimeEvent } from './realtime-events.js';

export interface RealtimeSubscriber {
  userId: string;
  send(event: string, data: unknown): void;
  close(): void;
}

// Who should see a message right now: active members of its trip whose
// accounts are active, minus anyone with a block in either direction with the
// sender. This mirrors the visibility rules of the message history endpoint.
async function loadMessageDelivery(messageId: string) {
  const message = await database.message.findUnique({
    where: { id: messageId },
    include: {
      ...messageInclude,
      conversation: {
        select: {
          tripId: true,
          trip: {
            select: {
              memberships: {
                where: { status: 'ACTIVE', user: { status: 'ACTIVE' } },
                select: { userId: true },
              },
            },
          },
        },
      },
    },
  });
  if (!message) return null;
  const memberIds = message.conversation.trip.memberships.map(
    (membership) => membership.userId,
  );
  const blocks = await database.userBlock.findMany({
    where: {
      OR: [
        { blockerId: message.senderId, blockedId: { in: memberIds } },
        { blockedId: message.senderId, blockerId: { in: memberIds } },
      ],
    },
    select: { blockerId: true, blockedId: true },
  });
  const blocked = new Set(
    blocks.map((block) =>
      block.blockerId === message.senderId ? block.blockedId : block.blockerId,
    ),
  );
  return {
    message,
    tripId: message.conversation.tripId,
    recipientIds: memberIds.filter((id) => !blocked.has(id)),
  };
}

// Tracks the streams connected to this API instance and delivers events to
// them. Events are processed one at a time so each stream sees them in the
// order they were committed.
export class RealtimeHub {
  private readonly subscribers = new Map<string, Set<RealtimeSubscriber>>();
  private queue: Promise<void> = Promise.resolve();
  // Set by buildApp to the application logger.
  logger: FastifyBaseLogger | undefined;

  add(subscriber: RealtimeSubscriber): void {
    const existing = this.subscribers.get(subscriber.userId) ?? new Set();
    existing.add(subscriber);
    this.subscribers.set(subscriber.userId, existing);
  }

  remove(subscriber: RealtimeSubscriber): void {
    const existing = this.subscribers.get(subscriber.userId);
    existing?.delete(subscriber);
    if (existing?.size === 0) this.subscribers.delete(subscriber.userId);
  }

  connectionCount(userId: string): number {
    return this.subscribers.get(userId)?.size ?? 0;
  }

  dispatch(event: RealtimeEvent): void {
    this.queue = this.queue
      .then(() => this.deliver(event))
      .catch((error: unknown) => {
        this.logger?.error({ err: error }, 'Realtime event delivery failed');
      });
  }

  // Tells every stream that events may have been missed, for example after
  // the database connection dropped, so clients refetch what they show.
  broadcast(event: string): void {
    for (const subscribers of this.subscribers.values()) {
      for (const subscriber of subscribers) subscriber.send(event, {});
    }
  }

  closeAll(): void {
    for (const subscribers of [...this.subscribers.values()]) {
      for (const subscriber of [...subscribers]) subscriber.close();
    }
  }

  // Resolves once every event dispatched so far has been delivered.
  idle(): Promise<void> {
    return this.queue;
  }

  private async deliver(event: RealtimeEvent): Promise<void> {
    if (this.subscribers.size === 0) return;
    if (event.type === 'notifications.changed') {
      for (const userId of event.userIds) {
        for (const subscriber of this.subscribers.get(userId) ?? []) {
          subscriber.send('notifications.changed', {});
        }
      }
      return;
    }

    const delivery = await loadMessageDelivery(event.messageId);
    if (!delivery) return;
    for (const userId of delivery.recipientIds) {
      for (const subscriber of this.subscribers.get(userId) ?? []) {
        subscriber.send(event.type, {
          tripId: delivery.tripId,
          message: presentMessage(delivery.message, userId),
        });
      }
    }
  }
}
