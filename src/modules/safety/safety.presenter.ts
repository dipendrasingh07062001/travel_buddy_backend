import { presentPublicProfile } from '../profiles/profile.presenter.js';
import type { BlockRecord, ReportRecord } from './safety.types.js';

function reportTarget(report: ReportRecord) {
  return {
    type: report.targetType,
    id:
      report.reportedUserId ??
      report.reportedTripId ??
      report.reportedConnectionRequestId ??
      report.reportedMessageId ??
      report.reportedCommunityPostId ??
      report.reportedCommunityCommentId,
  };
}

export function presentBlock(block: BlockRecord) {
  return {
    user: presentPublicProfile(block.blocked),
    blockedAt: block.createdAt.toISOString(),
  };
}

export function presentReport(report: ReportRecord) {
  return {
    id: report.id,
    target: reportTarget(report),
    reason: report.reason,
    details: report.details,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  };
}
