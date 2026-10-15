import type {
  Prisma,
  TripMembershipRole,
  TripStatus,
} from '../../generated/prisma/client.js';
import type { PublicTripRecord } from './trip.types.js';

export const membershipViews = ['active', 'history', 'all'] as const;
export const membershipRoles = ['OWNER', 'MEMBER'] as const;

export interface ListTripMembershipsQuery {
  view: (typeof membershipViews)[number];
  role?: TripMembershipRole;
  tripStatus?: TripStatus;
  page: number;
  pageSize: number;
}

export const ownMembershipSelect = {
  id: true,
  tripId: true,
  role: true,
  status: true,
  joinedAt: true,
  leftAt: true,
  removedAt: true,
} satisfies Prisma.TripMembershipSelect;

export type OwnTripMembership = Prisma.TripMembershipGetPayload<{
  select: typeof ownMembershipSelect;
}>;

export interface TripMembershipListItem {
  membership: OwnTripMembership;
  trip: PublicTripRecord | null;
}

export interface TripMembershipRepository {
  listForUser(
    userId: string,
    query: ListTripMembershipsQuery,
  ): Promise<{ items: TripMembershipListItem[]; totalItems: number }>;
}

export interface TripMembershipRouteDependencies {
  repository: TripMembershipRepository;
}
