import { presentPublicProfile } from '../profiles/profile.presenter.js';
import type { MessageRecord, RoomRecord } from './messaging.types.js';

export function presentRoom(room: RoomRecord, viewerId: string) {
  const viewerState = room.participants.find(
    (participant) => participant.userId === viewerId,
  );
  const readOnly = ['COMPLETED', 'CANCELLED'].includes(room.trip.status);
  return {
    id: room.id,
    tripId: room.tripId,
    status: readOnly ? 'READ_ONLY' : 'ACTIVE',
    members: room.trip.memberships.map((membership) => ({
      role: membership.role,
      joinedAt: membership.joinedAt.toISOString(),
      user: presentPublicProfile(membership.user),
    })),
    preferences: {
      muted: Boolean(viewerState?.mutedAt),
      lastReadAt: viewerState?.lastReadAt?.toISOString() ?? null,
    },
    safetyNotice:
      'Do not share financial credentials, identity documents, or precise home addresses.',
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
  };
}

export function presentMessage(message: MessageRecord, viewerId: string) {
  return {
    id: message.id,
    body: message.status === 'DELETED' ? null : message.body,
    status: message.status,
    sender: presentPublicProfile(message.sender),
    isOwn: message.senderId === viewerId,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  };
}
