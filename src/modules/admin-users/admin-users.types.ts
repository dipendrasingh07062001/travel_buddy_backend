import type {
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

export interface AdminUserRepository {
  search(
    input: AdminUserSearch,
  ): Promise<{ users: AdminUserSummary[]; totalItems: number }>;
  lookup(input: ContactLookup): Promise<AdminUserSummary | null>;
}

export interface AdminUserDependencies {
  repository: AdminUserRepository;
}
