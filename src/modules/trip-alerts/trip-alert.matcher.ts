import type {
  Trip,
  TripAlertSubscription,
} from '../../generated/prisma/client.js';

type Criteria = Pick<
  TripAlertSubscription,
  | 'communityId'
  | 'origin'
  | 'departureFrom'
  | 'departureTo'
  | 'minBudget'
  | 'maxBudget'
  | 'minDuration'
  | 'maxDuration'
  | 'transport'
>;
type Candidate = Pick<
  Trip,
  | 'communityId'
  | 'originCity'
  | 'startDate'
  | 'endDate'
  | 'budgetMin'
  | 'budgetMax'
  | 'durationDays'
  | 'transport'
  | 'currency'
>;

// Literal partial city match (%, _ and quotes have no wildcard/SQL meaning).
// A constrained budget needs the relevant bound, just like public discovery.
export function matchesTripAlert(criteria: Criteria, trip: Candidate): boolean {
  return (
    criteria.communityId === trip.communityId &&
    trip.currency === 'INR' &&
    (!criteria.origin ||
      trip.originCity.toLowerCase().includes(criteria.origin.toLowerCase())) &&
    (!criteria.departureFrom || trip.endDate >= criteria.departureFrom) &&
    (!criteria.departureTo || trip.startDate <= criteria.departureTo) &&
    (criteria.minBudget === null ||
      (trip.budgetMax !== null && trip.budgetMax.gte(criteria.minBudget))) &&
    (criteria.maxBudget === null ||
      (trip.budgetMin !== null && trip.budgetMin.lte(criteria.maxBudget))) &&
    (criteria.minDuration === null ||
      trip.durationDays >= criteria.minDuration) &&
    (criteria.maxDuration === null ||
      trip.durationDays <= criteria.maxDuration) &&
    (criteria.transport === null || trip.transport === criteria.transport)
  );
}
