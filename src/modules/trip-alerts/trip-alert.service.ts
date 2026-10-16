import { normalizeTripSearchQuery } from '../trips/trip-search.query.js';
import type { TripAlertBody, TripAlertInput } from './trip-alert.types.js';

// Same inclusive calendar/budget/duration bounds as public discovery. Sort and
// pagination are not saved; destination is an exact community UUID.
export function normalizeTripAlert(body: TripAlertBody): TripAlertInput {
  normalizeTripSearchQuery(body);
  return {
    name: body.name.trim(),
    communityId: body.communityId,
    enabled: body.enabled,
    origin: body.origin?.trim() || null,
    departureFrom: body.departureFrom
      ? new Date(`${body.departureFrom}T00:00:00.000Z`)
      : null,
    departureTo: body.departureTo
      ? new Date(`${body.departureTo}T00:00:00.000Z`)
      : null,
    minBudget: body.minBudget ?? null,
    maxBudget: body.maxBudget ?? null,
    minDuration: body.minDuration ?? null,
    maxDuration: body.maxDuration ?? null,
    transport: body.transport ?? null,
  };
}
