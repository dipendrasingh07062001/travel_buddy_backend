import type { ConnectionRequestStatus, Prisma } from '@prisma/client';

export const connectionRequestInclude = {
  requester: {
    select: {
      id: true,
      displayName: true,
      birthDate: true,
      status: true,
      createdAt: true,
      profile: {
        select: {
          profilePhotoStorageKey: true,
          homeCity: true,
          homeRegion: true,
          biography: true,
          languages: true,
          travelInterests: true,
          pastTripsVisibility: true,
          communityActivityVisibility: true,
        },
      },
    },
  },
  recipient: { select: { id: true, displayName: true } },
  trip: {
    select: {
      id: true,
      ownerId: true,
      status: true,
      startDate: true,
      endDate: true,
      currentGroupSize: true,
      desiredGroupSize: true,
      community: { select: { slug: true, name: true } },
    },
  },
  relatedTrip: {
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      community: { select: { slug: true, name: true } },
    },
  },
} satisfies Prisma.ConnectionRequestInclude;

export type ConnectionRequestRecord = Prisma.ConnectionRequestGetPayload<{
  include: typeof connectionRequestInclude;
}>;

export const membershipInclude = {
  user: {
    select: connectionRequestInclude.requester.select,
  },
} satisfies Prisma.TripMembershipInclude;

export type MembershipRecord = Prisma.TripMembershipGetPayload<{
  include: typeof membershipInclude;
}>;

export interface CreateConnectionRequestInput {
  tripId: string;
  requesterId: string;
  recipientId: string;
  relatedTripId: string | null;
  message: string;
}

export interface ListConnectionRequestsQuery {
  box: 'received' | 'sent';
  status?: ConnectionRequestStatus;
  page: number;
  pageSize: number;
}

export type AcceptResult =
  | { kind: 'accepted'; request: ConnectionRequestRecord }
  | { kind: 'not_found' }
  | { kind: 'not_pending'; request: ConnectionRequestRecord }
  | { kind: 'trip_unavailable' }
  | { kind: 'trip_full' }
  | { kind: 'conflict' };

export interface ConnectionRepository {
  findRequestableTrip(tripId: string): Promise<{
    id: string;
    ownerId: string;
    status: string;
    currentGroupSize: number;
    desiredGroupSize: number;
  } | null>;
  isOwnedPublicTrip(tripId: string, ownerId: string): Promise<boolean>;
  findExisting(
    tripId: string,
    requesterId: string,
  ): Promise<ConnectionRequestRecord | null>;
  countRecentByRequester(requesterId: string, since: Date): Promise<number>;
  create(input: CreateConnectionRequestInput): Promise<ConnectionRequestRecord>;
  list(
    userId: string,
    query: ListConnectionRequestsQuery,
  ): Promise<{ requests: ConnectionRequestRecord[]; totalItems: number }>;
  findById(id: string): Promise<ConnectionRequestRecord | null>;
  setPendingStatus(
    id: string,
    actorId: string,
    actorField: 'recipientId' | 'requesterId',
    status: 'DECLINED' | 'WITHDRAWN',
    now: Date,
  ): Promise<ConnectionRequestRecord | null>;
  accept(id: string, recipientId: string, now: Date): Promise<AcceptResult>;
  listActiveMembers(
    tripId: string,
    viewerId: string,
  ): Promise<MembershipRecord[] | null>;
}

export interface ConnectionRouteDependencies {
  repository: ConnectionRepository;
}
