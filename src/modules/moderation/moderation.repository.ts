import type { Prisma, Report, ReportStatus, StaffRole } from '@prisma/client';

import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';

type Transaction = Prisma.TransactionClient;
type Resolution = 'DISMISS' | 'SUSPEND_USER' | 'REMOVE_CONTENT';

function targetId(report: Report): string {
  const id =
    report.reportedUserId ??
    report.reportedTripId ??
    report.reportedConnectionRequestId ??
    report.reportedMessageId ??
    report.reportedCommunityPostId ??
    report.reportedCommunityCommentId;
  if (!id)
    throw new AppError(
      409,
      'REPORT_TARGET_MISSING',
      'The report has no target.',
    );
  return id;
}

export async function requireStaff(userId: string): Promise<StaffRole> {
  const user = await database.user.findUnique({
    where: { id: userId },
    select: { status: true, staffRole: true },
  });
  if (user?.status !== 'ACTIVE' || user.staffRole === 'USER') {
    throw new AppError(403, 'STAFF_ONLY', 'Staff access is required.');
  }
  return user.staffRole;
}

export function requireAdmin(role: StaffRole): void {
  if (role !== 'ADMIN') {
    throw new AppError(403, 'ADMIN_ONLY', 'Administrator access is required.');
  }
}

export async function listStaffReports(
  status: ReportStatus | undefined,
  page: number,
  pageSize: number,
) {
  const where: Prisma.ReportWhereInput = status ? { status } : {};
  const [reports, totalItems] = await database.$transaction([
    database.report.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.report.count({ where }),
  ]);
  return { reports, totalItems };
}

export async function findStaffReport(id: string) {
  const report = await database.report.findUnique({ where: { id } });
  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found.');
  return report;
}

export async function findStaffReportDetail(id: string, actorId: string) {
  const report = await findStaffReport(id);
  await database.moderationAction.create({
    data: {
      actorId,
      reportId: id,
      action: 'REPORT_INSPECTED',
      targetType: report.targetType,
      targetId: targetId(report),
      reason: 'Staff inspected reported content.',
    },
  });
  let target: object | null = null;
  switch (report.targetType) {
    case 'USER':
      target = await database.user.findUnique({
        where: { id: report.reportedUserId! },
        select: { id: true, displayName: true, status: true, createdAt: true },
      });
      break;
    case 'TRIP':
      target = await database.trip.findUnique({
        where: { id: report.reportedTripId! },
        select: {
          id: true,
          ownerId: true,
          status: true,
          description: true,
          moderationRemovedAt: true,
        },
      });
      break;
    case 'CONNECTION_REQUEST':
      target = await database.connectionRequest.findUnique({
        where: { id: report.reportedConnectionRequestId! },
        select: {
          id: true,
          requesterId: true,
          recipientId: true,
          status: true,
          message: true,
        },
      });
      break;
    case 'MESSAGE':
      target = await database.message.findUnique({
        where: { id: report.reportedMessageId! },
        select: {
          id: true,
          senderId: true,
          status: true,
          body: true,
          deletedAt: true,
        },
      });
      break;
    case 'COMMUNITY_POST':
      target = await database.communityPost.findUnique({
        where: { id: report.reportedCommunityPostId! },
        select: {
          id: true,
          authorId: true,
          status: true,
          title: true,
          body: true,
          removedAt: true,
        },
      });
      break;
    case 'COMMUNITY_COMMENT':
      target = await database.communityComment.findUnique({
        where: { id: report.reportedCommunityCommentId! },
        select: {
          id: true,
          authorId: true,
          status: true,
          body: true,
          removedAt: true,
        },
      });
      break;
  }
  return { report, target };
}

export async function startReportReview(reportId: string, actorId: string) {
  return database.$transaction(async (tx) => {
    const updated = await tx.report.updateMany({
      where: { id: reportId, status: 'SUBMITTED' },
      data: {
        status: 'UNDER_REVIEW',
        reviewerId: actorId,
        reviewedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      const exists = await tx.report.count({ where: { id: reportId } });
      throw new AppError(
        exists ? 409 : 404,
        exists ? 'REPORT_ALREADY_CLAIMED' : 'REPORT_NOT_FOUND',
        exists
          ? 'This report is already under review or resolved.'
          : 'Report not found.',
      );
    }
    const report = await tx.report.findUniqueOrThrow({
      where: { id: reportId },
    });
    await tx.moderationAction.create({
      data: {
        actorId,
        reportId,
        action: 'REPORT_CLAIMED',
        targetType: report.targetType,
        targetId: targetId(report),
        reason: 'Staff review started.',
      },
    });
    return report;
  });
}

async function reportedAccountId(
  tx: Transaction,
  report: Report,
): Promise<string> {
  switch (report.targetType) {
    case 'USER':
      return report.reportedUserId!;
    case 'TRIP': {
      const trip = await tx.trip.findUnique({
        where: { id: report.reportedTripId! },
        select: { ownerId: true },
      });
      if (trip) return trip.ownerId;
      break;
    }
    case 'MESSAGE': {
      const message = await tx.message.findUnique({
        where: { id: report.reportedMessageId! },
        select: { senderId: true },
      });
      if (message) return message.senderId;
      break;
    }
    case 'COMMUNITY_POST': {
      const post = await tx.communityPost.findUnique({
        where: { id: report.reportedCommunityPostId! },
        select: { authorId: true },
      });
      if (post) return post.authorId;
      break;
    }
    case 'COMMUNITY_COMMENT': {
      const comment = await tx.communityComment.findUnique({
        where: { id: report.reportedCommunityCommentId! },
        select: { authorId: true },
      });
      if (comment) return comment.authorId;
      break;
    }
    case 'CONNECTION_REQUEST': {
      const request = await tx.connectionRequest.findUnique({
        where: { id: report.reportedConnectionRequestId! },
        select: { requesterId: true, recipientId: true },
      });
      if (request) {
        return request.requesterId === report.reporterId
          ? request.recipientId
          : request.requesterId;
      }
      break;
    }
  }
  throw new AppError(
    409,
    'REPORT_TARGET_MISSING',
    'The reported account no longer exists.',
  );
}

async function suspendUser(
  tx: Transaction,
  userId: string,
  actorId: string,
  actorRole: StaffRole,
): Promise<void> {
  const target = await tx.user.findUnique({
    where: { id: userId },
    select: { status: true, staffRole: true },
  });
  if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  if (
    userId === actorId ||
    target.staffRole === 'ADMIN' ||
    (target.staffRole === 'MODERATOR' && actorRole !== 'ADMIN')
  ) {
    throw new AppError(
      403,
      'STAFF_TARGET_PROTECTED',
      'This staff account cannot be suspended.',
    );
  }
  if (target.status !== 'ACTIVE') {
    throw new AppError(
      409,
      'USER_NOT_ACTIVE',
      'Only active accounts can be suspended.',
    );
  }
  const changed = await tx.user.updateMany({
    where: {
      id: userId,
      status: 'ACTIVE',
      staffRole: {
        in: actorRole === 'ADMIN' ? ['USER', 'MODERATOR'] : ['USER'],
      },
    },
    data: { status: 'SUSPENDED' },
  });
  if (changed.count !== 1)
    throw new AppError(
      409,
      'USER_STATE_CHANGED',
      'The account changed during review.',
    );
}

async function removeContent(
  tx: Transaction,
  report: Report,
  actorId: string,
  now: Date,
): Promise<void> {
  let count = 0;
  switch (report.targetType) {
    case 'TRIP':
      count = (
        await tx.trip.updateMany({
          where: { id: report.reportedTripId!, moderationRemovedAt: null },
          data: { moderationRemovedAt: now, version: { increment: 1 } },
        })
      ).count;
      break;
    case 'COMMUNITY_POST':
      count = (
        await tx.communityPost.updateMany({
          where: { id: report.reportedCommunityPostId!, removedAt: null },
          data: { status: 'REMOVED', removedAt: now },
        })
      ).count;
      break;
    case 'COMMUNITY_COMMENT':
      count = (
        await tx.communityComment.updateMany({
          where: { id: report.reportedCommunityCommentId!, removedAt: null },
          data: { status: 'REMOVED', removedAt: now },
        })
      ).count;
      break;
    case 'MESSAGE': {
      const message = await tx.message.findUnique({
        where: { id: report.reportedMessageId! },
      });
      if (message && message.status !== 'DELETED') {
        count = (
          await tx.message.updateMany({
            where: { id: message.id, status: { not: 'DELETED' } },
            data: { status: 'DELETED', deletedAt: now },
          })
        ).count;
        if (count === 1) {
          await tx.messageRevision.create({
            data: {
              messageId: message.id,
              editorId: actorId,
              action: 'DELETE',
              previousBody: message.body,
              createdAt: now,
            },
          });
        }
      }
      break;
    }
    default:
      throw new AppError(
        409,
        'CONTENT_ACTION_UNAVAILABLE',
        'This report does not target removable content.',
      );
  }
  if (count !== 1) {
    throw new AppError(
      409,
      'CONTENT_ALREADY_REMOVED',
      'The reported content is already removed or unavailable.',
    );
  }
}

export async function resolveReport(
  reportId: string,
  actorId: string,
  actorRole: StaffRole,
  resolution: Resolution,
  reason: string,
) {
  return database.$transaction(async (tx) => {
    const report = await tx.report.findUnique({ where: { id: reportId } });
    if (!report)
      throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found.');
    if (report.status !== 'UNDER_REVIEW') {
      throw new AppError(
        409,
        'REPORT_NOT_IN_REVIEW',
        'Claim the report before resolving it.',
      );
    }
    if (report.reviewerId !== actorId && actorRole !== 'ADMIN') {
      throw new AppError(
        403,
        'REPORT_ASSIGNED_TO_ANOTHER',
        'Only the assigned reviewer or an administrator can resolve this report.',
      );
    }

    const updated = await tx.report.updateMany({
      where: { id: reportId, status: 'UNDER_REVIEW' },
      data: {
        status: resolution === 'DISMISS' ? 'DISMISSED' : 'ACTIONED',
        resolvedAt: new Date(),
      },
    });
    if (updated.count !== 1)
      throw new AppError(
        409,
        'REPORT_STATE_CHANGED',
        'The report was resolved by another reviewer.',
      );

    let action: 'REPORT_DISMISSED' | 'USER_SUSPENDED' | 'CONTENT_REMOVED';
    let actionTargetType = report.targetType;
    let actionTargetId = targetId(report);
    if (resolution === 'DISMISS') {
      action = 'REPORT_DISMISSED';
    } else if (resolution === 'SUSPEND_USER') {
      action = 'USER_SUSPENDED';
      actionTargetType = 'USER';
      actionTargetId = await reportedAccountId(tx, report);
      await suspendUser(tx, actionTargetId, actorId, actorRole);
    } else {
      action = 'CONTENT_REMOVED';
      await removeContent(tx, report, actorId, new Date());
    }
    await tx.moderationAction.create({
      data: {
        actorId,
        reportId,
        action,
        targetType: actionTargetType,
        targetId: actionTargetId,
        reason,
      },
    });
    return tx.report.findUniqueOrThrow({ where: { id: reportId } });
  });
}

export async function suspendAccountDirect(
  userId: string,
  actorId: string,
  actorRole: StaffRole,
  reason: string,
) {
  return database.$transaction(async (tx) => {
    await suspendUser(tx, userId, actorId, actorRole);
    await tx.moderationAction.create({
      data: {
        actorId,
        action: 'USER_SUSPENDED',
        targetType: 'USER',
        targetId: userId,
        reason,
      },
    });
    return tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, status: true },
    });
  });
}

export async function restoreAccount(
  userId: string,
  actorId: string,
  reason: string,
) {
  return database.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
    if (user.status !== 'SUSPENDED')
      throw new AppError(
        409,
        'USER_NOT_SUSPENDED',
        'Only suspended accounts can be restored.',
      );
    await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
    await tx.moderationAction.create({
      data: {
        actorId,
        action: 'USER_RESTORED',
        targetType: 'USER',
        targetId: userId,
        reason,
      },
    });
    return { id: userId, status: 'ACTIVE' as const };
  });
}

export async function listModerationActions(page: number, pageSize: number) {
  const [actions, totalItems] = await database.$transaction([
    database.moderationAction.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.moderationAction.count(),
  ]);
  return { actions, totalItems };
}
