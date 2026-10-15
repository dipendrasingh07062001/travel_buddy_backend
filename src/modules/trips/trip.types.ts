import type { Prisma, TripTransport } from '../../generated/prisma/client.js';

export const publicTripStatuses = ['PUBLISHED', 'FULL'] as const;

export const tripTransportValues = [
  'BUS',
  'TRAIN',
  'FLIGHT',
  'CAR',
  'MOTORCYCLE',
  'OTHER',
  'UNDECIDED',
] as const;

// Public discovery and join requests only include trips that have not ended.
export function utcStartOfToday(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export interface ListTripsQuery {
  origin?: string;
  destination?: string;
  departureFrom?: string;
  departureTo?: string;
  minBudget?: number;
  maxBudget?: number;
  minDuration?: number;
  maxDuration?: number;
  availableOnly?: boolean;
  transport?: TripTransport;
  sort?: 'newest' | 'departure_asc' | 'date_overlap';
  page?: number;
  pageSize?: number;
}

export type ResolvedListTripsQuery = ListTripsQuery &
  Required<Pick<ListTripsQuery, 'page' | 'pageSize' | 'sort'>>;

export const publicTripInclude = {
  owner: { select: { id: true, displayName: true } },
  community: {
    select: {
      id: true,
      slug: true,
      name: true,
      region: true,
      countryCode: true,
    },
  },
} satisfies Prisma.TripInclude;

export type PublicTripRecord = Prisma.TripGetPayload<{
  include: typeof publicTripInclude;
}>;

export interface PaginatedTrips {
  trips: PublicTripRecord[];
  totalItems: number;
}

export interface TripRepository {
  listPublic(query: ResolvedListTripsQuery): Promise<PaginatedTrips>;
  findPublicById(id: string): Promise<PublicTripRecord | null>;
}
