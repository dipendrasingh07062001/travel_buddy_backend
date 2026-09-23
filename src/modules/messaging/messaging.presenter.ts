import { presentPublicProfile } from '../profiles/profile.presenter.js';
import { presentChecklistItem } from '../trip-room/trip-room.presenter.js';
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
    plan: {
      originCity: room.trip.originCity,
      destination: {
        ...room.trip.community,
        countryCode: room.trip.community.countryCode.trim(),
      },
      startDate: room.trip.startDate.toISOString().slice(0, 10),
      endDate: room.trip.endDate.toISOString().slice(0, 10),
      flexibilityDays: room.trip.flexibilityDays,
      durationDays: room.trip.durationDays,
      transport: room.trip.transport,
      description: room.trip.description,
      status: room.trip.status,
      version: room.trip.version,
    },
    members: room.trip.memberships.map((membership) => ({
      role: membership.role,
      joinedAt: membership.joinedAt.toISOString(),
      user: presentPublicProfile(membership.user),
    })),
    preferences: {
      muted: Boolean(viewerState?.mutedAt),
      lastReadAt: viewerState?.lastReadAt?.toISOString() ?? null,
    },
    checklist: room.trip.checklistItems.map(presentChecklistItem),
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
