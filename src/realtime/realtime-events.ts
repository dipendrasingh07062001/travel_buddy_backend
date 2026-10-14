import type { Prisma } from '../generated/prisma/client.js';

export const realtimeChannel = 'travel_buddy_realtime';

export type MessageEventType =
  'message.created' | 'message.updated' | 'message.deleted';

// Events carry IDs only: PostgreSQL limits NOTIFY payloads to 8000 bytes, and
// each API instance loads the current record before fanning it out.
export type RealtimeEvent =
  | { type: MessageEventType; messageId: string; tripId: string }
  | { type: 'notifications.changed'; userIds: string[] };

const messageEventTypes = new Set<string>([
  'message.created',
  'message.updated',
  'message.deleted',
]);

// Call inside the transaction that makes the change. PostgreSQL delivers
// NOTIFY only when that transaction commits, so listeners never hear about a
// change that rolled back.
export async function publishRealtimeEvent(
  transaction: Prisma.TransactionClient,
  event: RealtimeEvent,
): Promise<void> {
  await transaction.$executeRaw`SELECT pg_notify(${realtimeChannel}, ${JSON.stringify(event)})`;
}

export function parseRealtimeEvent(payload: string): RealtimeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return null;
  }
  const event = value as Record<string, unknown>;
  if (
    typeof event.type === 'string' &&
    messageEventTypes.has(event.type) &&
    typeof event.messageId === 'string' &&
    typeof event.tripId === 'string'
  ) {
    return {
      type: event.type as MessageEventType,
      messageId: event.messageId,
      tripId: event.tripId,
    };
  }
  if (
    event.type === 'notifications.changed' &&
    Array.isArray(event.userIds) &&
    event.userIds.every((id) => typeof id === 'string')
  ) {
    return { type: 'notifications.changed', userIds: event.userIds };
  }
  return null;
}
