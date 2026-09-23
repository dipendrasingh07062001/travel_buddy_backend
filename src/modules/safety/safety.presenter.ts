import { presentPublicProfile } from '../profiles/profile.presenter.js';
import type { BlockRecord, ReportRecord } from './safety.types.js';

function reportTarget(report: ReportRecord) {
  if (report.reportedUserId) return { type: 'USER', id: report.reportedUserId };
  if (report.reportedTripId) return { type: 'TRIP', id: report.reportedTripId };
  if (report.reportedConnectionRequestId) {
    return {
      type: 'CONNECTION_REQUEST',
      id: report.reportedConnectionRequestId,
    };
  }
  if (report.reportedMessageId) {
    return { type: 'MESSAGE', id: report.reportedMessageId };
  }
  if (report.reportedCommunityPostId) {
    return { type: 'COMMUNITY_POST', id: report.reportedCommunityPostId };
  }
  return {
    type: 'COMMUNITY_COMMENT',
    id: report.reportedCommunityCommentId,
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
