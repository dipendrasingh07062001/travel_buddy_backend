import { publicText } from '../../privacy/public-text.js';
import { presentPublicDestination } from '../communities/community.presenter.js';
import type { PublicTripRecord } from './trip.types.js';

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function presentTrip(trip: PublicTripRecord) {
  return {
    id: trip.id,
    originCity: publicText(trip.originCity),
    destination: presentPublicDestination(trip.community),
    startDate: dateOnly(trip.startDate),
    endDate: dateOnly(trip.endDate),
    flexibilityDays: trip.flexibilityDays,
    durationDays: trip.durationDays,
    budget: {
      minimum: trip.budgetMin?.toFixed(2) ?? null,
      maximum: trip.budgetMax?.toFixed(2) ?? null,
      currency: trip.currency.trim(),
    },
    group: {
      currentSize: trip.currentGroupSize,
      desiredSize: trip.desiredGroupSize,
      availableSpaces: Math.max(
        0,
        trip.desiredGroupSize - trip.currentGroupSize,
      ),
    },
    transport: trip.transport,
    description: publicText(trip.description),
    status: trip.status,
    owner: {
      id: trip.owner.id,
      displayName: publicText(trip.owner.displayName),
    },
    publishedAt: trip.publishedAt?.toISOString() ?? null,
  };
}

export function presentOwnedTrip(trip: PublicTripRecord) {
  return {
    ...presentTrip(trip),
    // The authenticated owner needs the original text to correct older data.
    originCity: trip.originCity,
    description: trip.description,
    version: trip.version,
    moderationRemovedAt: trip.moderationRemovedAt?.toISOString() ?? null,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}
