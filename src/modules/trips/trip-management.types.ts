import type { Prisma, TripStatus, TripTransport } from '@prisma/client';

import type { PublicTripRecord } from './trip.types.js';

export interface CreateTripInput {
  ownerId: string;
  communityId: string;
  originCity: string;
  startDate: Date;
  endDate: Date;
  flexibilityDays: number;
  durationDays: number;
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string;
  currentGroupSize: number;
  desiredGroupSize: number;
  transport: TripTransport;
  description: string;
}

export interface ListOwnedTripsQuery {
  status?: TripStatus;
  page: number;
  pageSize: number;
}

export interface PaginatedOwnedTrips {
  trips: PublicTripRecord[];
  totalItems: number;
}

export interface TripManagementRepository {
  isActiveCommunity(communityId: string): Promise<boolean>;
  create(input: CreateTripInput): Promise<PublicTripRecord>;
  listOwned(
    ownerId: string,
    query: ListOwnedTripsQuery,
  ): Promise<PaginatedOwnedTrips>;
  findById(id: string): Promise<PublicTripRecord | null>;
  updateOwned(
    id: string,
    ownerId: string,
    expectedVersion: number,
    allowedStatuses: TripStatus[],
    data: Prisma.TripUncheckedUpdateManyInput,
  ): Promise<PublicTripRecord | null>;
}
