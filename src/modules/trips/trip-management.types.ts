import type {
  Prisma,
  TripDateMode,
  TripStatus,
  TripTransport,
} from '../../generated/prisma/client.js';
import type { PublicTripRecord } from './trip.types.js';

export interface CreateTripInput {
  ownerId: string;
  communityId: string | null;
  destinationName: string | null;
  originCity: string;
  startDate: Date;
  endDate: Date;
  flexibilityDays: number;
  dateMode: TripDateMode;
  weekendsOnly: boolean;
  durationDays: number;
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string;
  currentGroupSize: number;
  desiredGroupSize: number;
  transport: TripTransport;
  description: string | null;
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
  /** The id of the only active community with this name, ignoring case. */
  findActiveCommunityIdByName(name: string): Promise<string | null>;
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
