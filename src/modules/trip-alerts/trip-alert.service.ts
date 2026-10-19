import { AppError } from '../../errors/app-error.js';
import { normalizeTripSearchQuery } from '../trips/trip-search.query.js';
import type { TripAlertBody, TripAlertInput } from './trip-alert.types.js';

// Reads the number as written in the request: 19.99 passes, 19.999 does not.
function hasAtMostTwoDecimals(value: number): boolean {
  return /^\d+(?:\.\d{1,2})?$/.test(String(value));
}

// Same inclusive calendar/budget/duration bounds as public discovery. Sort and
// pagination are not saved; destination is an exact community UUID.
export function normalizeTripAlert(body: TripAlertBody): TripAlertInput {
  for (const budget of [body.minBudget, body.maxBudget]) {
    if (budget !== undefined && !hasAtMostTwoDecimals(budget)) {
      throw new AppError(
        400,
        'INVALID_TRIP_ALERT_BUDGET',
        'Budgets can have at most two decimal places.',
      );
    }
  }
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
