import type { Prisma, ReportTargetType } from '@prisma/client';

import { database } from '../../database/client.js';
import {
  blockInclude,
  type CreateReportInput,
  type SafetyRepository,
} from './safety.types.js';

function reportTargetWhere(
  targetType: ReportTargetType,
  targetId: string,
): Prisma.ReportWhereInput {
  switch (targetType) {
    case 'USER':
      return { reportedUserId: targetId };
    case 'TRIP':
      return { reportedTripId: targetId };
    case 'CONNECTION_REQUEST':
      return { reportedConnectionRequestId: targetId };
  }
}

function reportTargetData(
  input: CreateReportInput,
): Prisma.ReportUncheckedCreateInput {
  return {
    reporterId: input.reporterId,
    targetType: input.targetType,
    reason: input.reason,
    details: input.details,
    ...(input.targetType === 'USER' && { reportedUserId: input.targetId }),
    ...(input.targetType === 'TRIP' && { reportedTripId: input.targetId }),
    ...(input.targetType === 'CONNECTION_REQUEST' && {
      reportedConnectionRequestId: input.targetId,
    }),
  };
}

export const prismaSafetyRepository: SafetyRepository = {
  async findActiveUser(userId) {
    return (
      (await database.user.count({
        where: { id: userId, status: 'ACTIVE', deletedAt: null },
      })) === 1
    );
  },

  blockUser(blockerId, blockedId, now) {
    return database.$transaction(async (transaction) => {
      const block = await transaction.userBlock.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId } },
        create: { blockerId, blockedId, createdAt: now },
        update: {},
        include: blockInclude,
      });
      await transaction.connectionRequest.updateMany({
        where: {
          status: 'PENDING',
          OR: [
            { requesterId: blockerId, recipientId: blockedId },
            { requesterId: blockedId, recipientId: blockerId },
          ],
        },
        data: {
          status: 'BLOCKED',
          decidedById: blockerId,
          decidedAt: now,
        },
      });
      return block;
    });
  },

  async unblockUser(blockerId, blockedId) {
    await database.userBlock.deleteMany({ where: { blockerId, blockedId } });
  },

  async listBlocks(blockerId, query) {
    const where = { blockerId };
    const [blocks, totalItems] = await database.$transaction([
      database.userBlock.findMany({
        where,
        include: blockInclude,
        orderBy: [{ createdAt: 'desc' }, { blockedId: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      database.userBlock.count({ where }),
    ]);
    return { blocks, totalItems };
  },

  async canReportTarget(reporterId, targetType, targetId) {
    switch (targetType) {
      case 'USER':
        return (
          (await database.user.count({
            where: {
              id: targetId,
              status: 'ACTIVE',
              deletedAt: null,
            },
          })) === 1
        );
      case 'TRIP':
        return (
          (await database.trip.count({
            where: {
              id: targetId,
              ownerId: { not: reporterId },
              OR: [
                { status: { in: ['PUBLISHED', 'FULL'] } },
                {
                  memberships: {
                    some: { userId: reporterId, status: 'ACTIVE' },
                  },
                },
              ],
            },
          })) === 1
        );
      case 'CONNECTION_REQUEST':
        return (
          (await database.connectionRequest.count({
            where: {
              id: targetId,
              OR: [{ requesterId: reporterId }, { recipientId: reporterId }],
            },
          })) === 1
        );
    }
  },

  findOpenReport(reporterId, targetType, targetId) {
    return database.report.findFirst({
      where: {
        reporterId,
        targetType,
        status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
        ...reportTargetWhere(targetType, targetId),
      },
    });
  },

  countRecentReports(reporterId, since) {
    return database.report.count({
      where: { reporterId, createdAt: { gte: since } },
    });
  },

  createReport(input) {
    return database.report.create({ data: reportTargetData(input) });
  },

  async listReports(reporterId, query) {
    const where = {
      reporterId,
      ...(query.status && { status: query.status }),
    };
    const [reports, totalItems] = await database.$transaction([
      database.report.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      database.report.count({ where }),
    ]);
    return { reports, totalItems };
  },
};
