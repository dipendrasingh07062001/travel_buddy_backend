import {
  Prisma,
  type ReportReason,
  type ReportTargetType,
} from '@prisma/client';

import { AppError } from '../../errors/app-error.js';
import type {
  BlockRecord,
  CreateReportInput,
  ReportRecord,
  SafetyRepository,
} from './safety.types.js';

export interface CreateReportBody {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details?: string;
}

const maximumReportsPerDay = 10;

export async function blockUser(
  blockerId: string,
  blockedId: string,
  repository: SafetyRepository,
  now = new Date(),
): Promise<BlockRecord> {
  if (blockerId === blockedId) {
    throw new AppError(409, 'SELF_BLOCK', 'You cannot block your own account.');
  }
  if (!(await repository.findActiveUser(blockedId))) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }
  return repository.blockUser(blockerId, blockedId, now);
}

export async function createReport(
  reporterId: string,
  body: CreateReportBody,
  repository: SafetyRepository,
  now = new Date(),
): Promise<ReportRecord> {
  const details = body.details?.trim() || null;
  if (body.targetType === 'USER' && body.targetId === reporterId) {
    throw new AppError(
      409,
      'SELF_REPORT',
      'You cannot report your own account.',
    );
  }
  if (body.reason === 'OTHER' && (!details || details.length < 10)) {
    throw new AppError(
      400,
      'REPORT_DETAILS_REQUIRED',
      'Provide at least 10 characters of detail when selecting OTHER.',
    );
  }
  if (
    !(await repository.canReportTarget(
      reporterId,
      body.targetType,
      body.targetId,
    ))
  ) {
    throw new AppError(
      404,
      'REPORT_TARGET_NOT_FOUND',
      'Report target not found.',
    );
  }
  if (
    await repository.findOpenReport(reporterId, body.targetType, body.targetId)
  ) {
    throw new AppError(
      409,
      'REPORT_ALREADY_SUBMITTED',
      'You already have an unresolved report for this target.',
    );
  }
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (
    (await repository.countRecentReports(reporterId, since)) >=
    maximumReportsPerDay
  ) {
    throw new AppError(
      429,
      'REPORT_LIMIT_REACHED',
      'You have reached the report limit for the last 24 hours.',
    );
  }
  const input: CreateReportInput = {
    reporterId,
    targetType: body.targetType,
    targetId: body.targetId,
    reason: body.reason,
    details,
  };
  try {
    return await repository.createReport(input);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new AppError(
        409,
        'REPORT_ALREADY_SUBMITTED',
        'You already have an unresolved report for this target.',
      );
    }
    throw error;
  }
}
