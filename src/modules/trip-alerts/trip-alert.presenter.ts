import type { TripAlertSubscription } from '../../generated/prisma/client.js';

export function presentTripAlert(record: TripAlertSubscription) {
  return {
    id: record.id,
    name: record.name,
    communityId: record.communityId,
    enabled: record.enabled,
    version: record.version,
    origin: record.origin,
    departureFrom: record.departureFrom?.toISOString().slice(0, 10) ?? null,
    departureTo: record.departureTo?.toISOString().slice(0, 10) ?? null,
    minBudget: record.minBudget?.toFixed(2) ?? null,
    maxBudget: record.maxBudget?.toFixed(2) ?? null,
    currency: 'INR',
    minDuration: record.minDuration,
    maxDuration: record.maxDuration,
    transport: record.transport,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
