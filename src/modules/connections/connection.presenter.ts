import { presentPublicProfile } from '../profiles/profile.presenter.js';
import type {
  ConnectionRequestRecord,
  MembershipRecord,
} from './connection.types.js';

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function tripReference(
  trip:
    | ConnectionRequestRecord['trip']
    | NonNullable<ConnectionRequestRecord['relatedTrip']>,
) {
  return {
    id: trip.id,
    destination: trip.community,
    startDate: dateOnly(trip.startDate),
    endDate: dateOnly(trip.endDate),
    status: trip.status,
  };
}

export function presentConnectionRequest(request: ConnectionRequestRecord) {
  return {
    id: request.id,
    status: request.status,
    message: request.message,
    trip: tripReference(request.trip),
    relatedTrip: request.relatedTrip
      ? tripReference(request.relatedTrip)
      : null,
    requester: presentPublicProfile(request.requester),
    recipient: request.recipient,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    withdrawnAt: request.withdrawnAt?.toISOString() ?? null,
  };
}

export function presentMembership(membership: MembershipRecord) {
  return {
    id: membership.id,
    role: membership.role,
    status: membership.status,
    user: presentPublicProfile(membership.user),
    joinedAt: membership.joinedAt.toISOString(),
  };
}
