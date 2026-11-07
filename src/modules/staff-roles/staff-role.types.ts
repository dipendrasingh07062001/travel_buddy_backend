import type { StaffRole } from '../../generated/prisma/client.js';

// ADMIN is granted and revoked only with the database CLI.
export const assignableRoles = [
  'USER',
  'MODERATOR',
] as const satisfies readonly StaffRole[];
export type AssignableRole = (typeof assignableRoles)[number];

export interface StaffRoleChange {
  actorId: string;
  targetId: string;
  role: AssignableRole;
  reason: string;
}

export interface StaffRoleResult {
  userId: string;
  staffRole: StaffRole;
  changed: boolean;
  claimedReportCount: number;
}

export interface StaffRoleRepository {
  change(input: StaffRoleChange): Promise<StaffRoleResult>;
}

export interface StaffRoleDependencies {
  repository: StaffRoleRepository;
}
