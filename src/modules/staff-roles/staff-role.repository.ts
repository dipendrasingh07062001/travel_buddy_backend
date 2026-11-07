import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import type { StaffRoleRepository } from './staff-role.types.js';

export interface StaffRoleHooks {
  // Runs between the read and the update. Tests use it to change the account
  // from another connection and check the compare-and-set; production never
  // sets it.
  afterRead?: () => Promise<void>;
}

export function createStaffRoleRepository(
  hooks: StaffRoleHooks = {},
): StaffRoleRepository {
  return {
    async change({ actorId, targetId, role, reason }) {
      return database.$transaction(async (tx) => {
        const target = await tx.user.findUnique({
          where: { id: targetId },
          select: { status: true, staffRole: true },
        });
        if (!target) {
          throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
        }
        if (targetId === actorId || target.staffRole === 'ADMIN') {
          throw new AppError(
            403,
            'STAFF_TARGET_PROTECTED',
            'Staff cannot take this action on this account.',
          );
        }
        const changed = target.staffRole !== role;
        if (changed) {
          const grant = role === 'MODERATOR';
          if (grant && target.status !== 'ACTIVE') {
            throw new AppError(
              409,
              'USER_NOT_ACTIVE',
              'Only active accounts can become moderators.',
            );
          }
          await hooks.afterRead?.();
          // The predicate repeats what was checked above, so a suspension or
          // role change that commits in between makes the update miss.
          const updated = await tx.user.updateMany({
            where: grant
              ? { id: targetId, staffRole: 'USER', status: 'ACTIVE' }
              : { id: targetId, staffRole: 'MODERATOR' },
            data: { staffRole: role },
          });
          if (updated.count !== 1) {
            throw new AppError(
              409,
              'USER_STATE_CHANGED',
              'The account changed during this request.',
            );
          }
          await tx.moderationAction.create({
            data: {
              actorId,
              action: grant ? 'STAFF_ROLE_GRANTED' : 'STAFF_ROLE_REVOKED',
              targetType: 'USER',
              targetId,
              reason,
            },
          });
        }
        // Claimed reports stay with the reviewer; administrators can still
        // resolve them, so this only tells the caller how many there are.
        const claimedReportCount = await tx.report.count({
          where: { reviewerId: targetId, status: 'UNDER_REVIEW' },
        });
        return {
          userId: targetId,
          staffRole: changed ? role : target.staffRole,
          changed,
          claimedReportCount,
        };
      });
    },
  };
}

export const prismaStaffRoleRepository = createStaffRoleRepository();
