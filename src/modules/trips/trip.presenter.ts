import type { PublicTripRecord } from './trip.types.js';

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function presentTrip(trip: PublicTripRecord) {
  return {
    id: trip.id,
    originCity: trip.originCity,
    destination: trip.community,
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
    description: trip.description,
    status: trip.status,
    owner: trip.owner,
    publishedAt: trip.publishedAt?.toISOString() ?? null,
  };
}

export function presentOwnedTrip(trip: PublicTripRecord) {
  return {
    ...presentTrip(trip),
    version: trip.version,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}
