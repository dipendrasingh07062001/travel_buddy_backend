import type {
  Prisma,
  TripChangeAction,
} from '../../generated/prisma/client.js';

export const tripHistorySelect = {
  id: true,
  version: true,
  communityId: true,
  originCity: true,
  startDate: true,
  endDate: true,
  dateMode: true,
  weekendsOnly: true,
  flexibilityDays: true,
  durationDays: true,
  budgetMin: true,
  budgetMax: true,
  currency: true,
  currentGroupSize: true,
  desiredGroupSize: true,
  transport: true,
  status: true,
  description: true,
  moderationRemovedAt: true,
} satisfies Prisma.TripSelect;

type Snapshot = Prisma.TripGetPayload<{ select: typeof tripHistorySelect }>;

function plan(
  trip: Snapshot,
): Record<string, string | number | boolean | null> {
  return {
    communityId: trip.communityId,
    originCity: trip.originCity,
    startDate: trip.startDate.toISOString().slice(0, 10),
    endDate: trip.endDate.toISOString().slice(0, 10),
    dateMode: trip.dateMode,
    weekendsOnly: trip.weekendsOnly,
    flexibilityDays: trip.flexibilityDays,
    durationDays: trip.durationDays,
    budgetMin: trip.budgetMin?.toFixed(2) ?? null,
    budgetMax: trip.budgetMax?.toFixed(2) ?? null,
    currency: trip.currency,
    currentGroupSize: trip.currentGroupSize,
    desiredGroupSize: trip.desiredGroupSize,
    transport: trip.transport,
    status: trip.status,
    moderationRemoved: trip.moderationRemovedAt !== null,
  };
}

export function tripChanges(before: Snapshot | null, after: Snapshot) {
  const previous = before ? plan(before) : null;
  const changes: Record<string, Prisma.InputJsonValue> = {};
  for (const [field, value] of Object.entries(plan(after))) {
    if (!previous || previous[field] !== value) {
      changes[field] = { before: previous?.[field] ?? null, after: value };
    }
  }
  // Descriptions can contain contact details. Record the edit, never the text.
  if (!before || before.description !== after.description) {
    changes.description = { changed: true };
  }
  return changes;
}

/** Must be called inside the same transaction as the trip mutation. */
export async function recordTripChange(
  tx: Prisma.TransactionClient,
  before: Snapshot | null,
  after: Snapshot,
  action: TripChangeAction,
  actorId: string | null,
  createdAt = new Date(),
) {
  const changes = tripChanges(before, after);
  if (Object.keys(changes).length === 0) return;
  await tx.tripChange.create({
    data: {
      tripId: after.id,
      version: after.version,
      actorId,
      action,
      changes,
      createdAt,
    },
  });
}
