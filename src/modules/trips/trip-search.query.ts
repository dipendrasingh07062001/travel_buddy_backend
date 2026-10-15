import {
  tripTransportValues,
  type ListTripsQuery,
  type ResolvedListTripsQuery,
} from './trip.types.js';

// Both discovery endpoints use the same query contract. The destination is
// supplied separately: a query parameter on /trips, or the community path.
export const tripSearchQueryProperties = {
  origin: { type: 'string', minLength: 1, maxLength: 120 },
  departureFrom: { type: 'string', format: 'date' },
  departureTo: { type: 'string', format: 'date' },
  minBudget: { type: 'number', minimum: 0 },
  maxBudget: { type: 'number', minimum: 0 },
  minDuration: {
    type: 'integer',
    minimum: 1,
    maximum: 365,
    description: 'Minimum trip duration in inclusive calendar days.',
  },
  maxDuration: {
    type: 'integer',
    minimum: 1,
    maximum: 365,
    description: 'Maximum trip duration in inclusive calendar days.',
  },
  availableOnly: {
    type: 'boolean',
    default: false,
    description:
      'Only published trips accepting members with at least one free place.',
  },
  transport: { type: 'string', enum: tripTransportValues },
  sort: {
    type: 'string',
    enum: ['newest', 'departure_asc', 'date_overlap'],
    default: 'newest',
    description:
      'date_overlap requires both dates: most shared days, smallest total date-boundary distance, earliest departure, then trip ID.',
  },
  page: {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    default: 1,
  },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
} as const;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

export function normalizeTripSearchQuery(
  query: ListTripsQuery,
): ResolvedListTripsQuery {
  for (const value of [query.departureFrom, query.departureTo]) {
    if (value === undefined) continue;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value.startsWith('0000-') ||
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    ) {
      invalid(
        'Departure bounds must be valid calendar dates in YYYY-MM-DD format.',
      );
    }
  }
  if (
    query.departureFrom &&
    query.departureTo &&
    query.departureFrom > query.departureTo
  ) {
    invalid('departureFrom must be on or before departureTo.');
  }
  if (
    query.minBudget !== undefined &&
    query.maxBudget !== undefined &&
    query.minBudget > query.maxBudget
  ) {
    invalid('minBudget must be less than or equal to maxBudget.');
  }
  if (
    query.minDuration !== undefined &&
    query.maxDuration !== undefined &&
    query.minDuration > query.maxDuration
  ) {
    invalid('minDuration must be less than or equal to maxDuration.');
  }
  if (
    query.sort === 'date_overlap' &&
    (!query.departureFrom || !query.departureTo)
  ) {
    invalid('date_overlap requires both departureFrom and departureTo.');
  }
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    invalid('The requested pagination offset is too large.');
  }
  return {
    ...query,
    sort: query.sort ?? 'newest',
    availableOnly: query.availableOnly ?? false,
    page,
    pageSize,
  };
}
