import type {
  AccountDataRequestType,
  IdentityType,
  RestrictedFeature,
  StaffRole,
  UserStatus,
} from '../../generated/prisma/client.js';

export const userStatuses = [
  'ACTIVE',
  'SUSPENDED',
  'PENDING_DELETION',
  'DELETED',
] as const satisfies readonly UserStatus[];
export const staffRoles = [
  'USER',
  'MODERATOR',
  'ADMIN',
] as const satisfies readonly StaffRole[];
export const contactTypes = [
  'EMAIL',
  'PHONE',
] as const satisfies readonly IdentityType[];

export interface AdminUserSummary {
  id: string;
  displayName: string | null;
  status: UserStatus;
  staffRole: StaffRole;
  createdAt: Date;
  hasProfilePhoto: boolean;
  activeRestrictions: RestrictedFeature[];
  openReportCount: number;
}

export type SearchMatch = { kind: 'id' | 'name'; value: string };

export interface AdminUserSearch {
  match?: SearchMatch;
  status?: UserStatus;
  staffRole?: StaffRole;
  page: number;
  pageSize: number;
}

export interface ContactLookup {
  actorId: string;
  type: IdentityType;
  value: string;
}

export interface StatusCounts {
  submitted: number;
  underReview: number;
  actioned: number;
  dismissed: number;
}

// Report numbers use only fields every report list row already shows
// (reportedUserId, reporterId, reviewerId). Reports on the account's
// content are never linked to it here.
export interface AdminUserDetail {
  account: {
    id: string;
    displayName: string | null;
    status: UserStatus;
    staffRole: StaffRole;
    createdAt: Date;
    deletedAt: Date | null;
    recordsPurgedAt: Date | null;
    statusBeforeDeletion: UserStatus | null;
    hasProfilePhoto: boolean;
    hasVerifiedEmail: boolean;
    hasVerifiedPhone: boolean;
  };
  activeRestrictions: Array<{
    id: string;
    feature: RestrictedFeature;
    startsAt: Date;
    endsAt: Date | null;
  }>;
  reports: { aboutAccount: StatusCounts; filed: StatusCounts };
  claimedReportCount: number;
  content: {
    trips: number;
    communityPosts: { draft: number; published: number; removed: number };
    communityComments: { visible: number; removed: number };
    blockedByCount: number;
  };
  // null when the caller may not see data requests.
  openDataRequests: Array<{
    id: string;
    type: AccountDataRequestType;
    createdAt: Date;
    scheduledFor: Date | null;
  }> | null;
}

export interface AdminUserDetailInput {
  userId: string;
  includeDataRequests: boolean;
  now?: Date;
}

export interface AdminUserRepository {
  search(
    input: AdminUserSearch,
  ): Promise<{ users: AdminUserSummary[]; totalItems: number }>;
  lookup(input: ContactLookup): Promise<AdminUserSummary | null>;
  detail(input: AdminUserDetailInput): Promise<AdminUserDetail | null>;
}

export interface AdminUserDependencies {
  repository: AdminUserRepository;
}
