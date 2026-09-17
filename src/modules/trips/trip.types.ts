import type { Prisma, TripTransport } from '@prisma/client';

export const publicTripStatuses = ['PUBLISHED', 'FULL'] as const;

export interface ListTripsQuery {
  origin?: string;
  destination?: string;
  departureFrom?: string;
  departureTo?: string;
  minBudget?: number;
  maxBudget?: number;
  transport?: TripTransport;
  sort?: 'newest' | 'departure_asc';
  page?: number;
  pageSize?: number;
}

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
  listPublic(
    query: Required<Pick<ListTripsQuery, 'page' | 'pageSize' | 'sort'>> &
      ListTripsQuery,
  ): Promise<PaginatedTrips>;
  findPublicById(id: string): Promise<PublicTripRecord | null>;
}
