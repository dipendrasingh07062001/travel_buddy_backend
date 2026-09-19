import { AppError } from '../../errors/app-error.js';
import type {
  ListMessagesQuery,
  MessageRecord,
  MessagingRepository,
  RoomRecord,
} from './messaging.types.js';

function cleanBody(value: string): string {
  const body = value.trim();
  if (body.length === 0) {
    throw new AppError(
      400,
      'INVALID_MESSAGE_BODY',
      'A message must contain at least one non-space character.',
    );
  }
  return body;
}

function roomNotFound(): never {
  throw new AppError(
    404,
    'TRIP_ROOM_NOT_FOUND',
    'Private trip room not found.',
  );
}

export async function getRoom(
  tripId: string,
  userId: string,
  repository: MessagingRepository,
): Promise<RoomRecord> {
  const room = await repository.findRoom(tripId, userId);
  if (!room) roomNotFound();
  return room;
}

export async function listMessages(
  tripId: string,
  userId: string,
  query: ListMessagesQuery,
  repository: MessagingRepository,
): Promise<{ messages: MessageRecord[]; nextCursor: string | null }> {
  const result = await repository.listMessages(tripId, userId, query);
  if (result.kind === 'room_not_found') roomNotFound();
  if (result.kind === 'invalid_cursor') {
    throw new AppError(
      400,
      'INVALID_MESSAGE_CURSOR',
      'The message cursor is invalid for this trip room.',
    );
  }
  return result;
}

export async function sendMessage(
  tripId: string,
  senderId: string,
  rawBody: string,
  repository: MessagingRepository,
  now = new Date(),
): Promise<MessageRecord> {
  const result = await repository.createMessage(
    tripId,
    senderId,
    cleanBody(rawBody),
    now,
  );
  switch (result.kind) {
    case 'created':
      return result.message;
    case 'room_not_found':
      return roomNotFound();
    case 'read_only':
      throw new AppError(
        409,
        'TRIP_ROOM_READ_ONLY',
        'Messages cannot be sent after a trip is completed or cancelled.',
      );
    case 'no_recipients':
      throw new AppError(
        409,
        'TRIP_ROOM_NO_RECIPIENTS',
        'At least one other active trip member is required before messaging.',
      );
    case 'blocked':
      throw new AppError(
        403,
        'CONTACT_BLOCKED',
        'This messaging action is unavailable.',
      );
  }
}

async function changeMessage(
  messageId: string,
  senderId: string,
  action: 'EDIT' | 'DELETE',
  body: string | null,
  repository: MessagingRepository,
  now = new Date(),
): Promise<MessageRecord> {
  const result = await repository.changeMessage(
    messageId,
    senderId,
    action,
    body,
    now,
  );
  switch (result.kind) {
    case 'updated':
      return result.message;
    case 'not_found':
      throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    case 'read_only':
      throw new AppError(
        409,
        'TRIP_ROOM_READ_ONLY',
        'Messages cannot be changed after a trip is completed or cancelled.',
      );
    case 'invalid_state':
      throw new AppError(
        409,
        'MESSAGE_ALREADY_DELETED',
        'A deleted message cannot be changed.',
      );
  }
}

export function editMessage(
  messageId: string,
  senderId: string,
  rawBody: string,
  repository: MessagingRepository,
  now = new Date(),
): Promise<MessageRecord> {
  return changeMessage(
    messageId,
    senderId,
    'EDIT',
    cleanBody(rawBody),
    repository,
    now,
  );
}

export function deleteMessage(
  messageId: string,
  senderId: string,
  repository: MessagingRepository,
  now = new Date(),
): Promise<MessageRecord> {
  return changeMessage(messageId, senderId, 'DELETE', null, repository, now);
}

export async function markRoomRead(
  tripId: string,
  userId: string,
  repository: MessagingRepository,
  now = new Date(),
): Promise<void> {
  if (!(await repository.markRead(tripId, userId, now))) roomNotFound();
}

export async function setRoomMuted(
  tripId: string,
  userId: string,
  muted: boolean,
  repository: MessagingRepository,
  now = new Date(),
): Promise<RoomRecord> {
  const room = await repository.setMuted(tripId, userId, muted, now);
  if (!room) roomNotFound();
  return room;
}
