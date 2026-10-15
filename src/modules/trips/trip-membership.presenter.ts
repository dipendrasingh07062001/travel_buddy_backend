import type { TripMembershipListItem } from './trip-membership.types.js';
import { presentTrip } from './trip.presenter.js';

export function presentTripMembership(item: TripMembershipListItem) {
  const { membership, trip } = item;
  return {
    id: membership.id,
    tripId: membership.tripId,
    role: membership.role,
    status: membership.status,
    joinedAt: membership.joinedAt.toISOString(),
    leftAt: membership.leftAt?.toISOString() ?? null,
    removedAt: membership.removedAt?.toISOString() ?? null,
    trip: membership.status === 'ACTIVE' && trip ? presentTrip(trip) : null,
  };
}
