import { AppError } from '../../errors/app-error.js';
import type {
  NotificationType,
  Prisma,
  StaffRole,
} from '../../generated/prisma/client.js';
import { createNotifications } from '../notifications/notification.repository.js';

export type Transaction = Prisma.TransactionClient;

export interface ModerationNotice {
  type: NotificationType;
  recipientId: string;
  sourceId: string;
  eventKey: string;
  tripId?: string;
}

// Tells the affected user what happened, in the moderation transaction. The
// notice never carries the moderator (no actorId), the reporter or the
// moderator's internal reason.
export function notifyAffectedUser(
  tx: Transaction,
  notice: ModerationNotice,
  createdAt = new Date(),
) {
  return createNotifications(tx, {
    recipientIds: [notice.recipientId],
    type: notice.type,
    eventKey: notice.eventKey,
    sourceId: notice.sourceId,
    ...(notice.tripId && { tripId: notice.tripId }),
    createdAt,
  });
}

// Staff cannot act on their own account or on administrators, and only
// administrators can act on moderators.
export function requireModeratableAccount(
  userId: string,
  targetRole: StaffRole,
  actorId: string,
  actorRole: StaffRole,
): void {
  if (
    userId === actorId ||
    targetRole === 'ADMIN' ||
    (targetRole === 'MODERATOR' && actorRole !== 'ADMIN')
  ) {
    throw new AppError(
      403,
      'STAFF_TARGET_PROTECTED',
      'Staff cannot take this action on this account.',
    );
  }
}
