import type {
  EmailCategory,
  NotificationType,
} from '../../generated/prisma/client.js';

// Explicit allowlist. New inbox types never silently become email.
export function emailCategory(type: NotificationType): EmailCategory | null {
  switch (type) {
    case 'CONNECTION_REQUEST_RECEIVED':
    case 'CONNECTION_REQUEST_ACCEPTED':
    case 'CONNECTION_REQUEST_DECLINED':
    case 'CONNECTION_REQUEST_WITHDRAWN':
      return 'CONNECTIONS';
    case 'TRIP_UPDATED':
    case 'TRIP_STATUS_CHANGED':
      return 'TRIPS';
    case 'EXPENSE_CREATED':
    case 'EXPENSE_UPDATED':
    case 'EXPENSE_VOIDED':
    case 'SETTLEMENT_PENDING':
    case 'SETTLEMENT_CONFIRMED':
    case 'SETTLEMENT_REJECTED':
    case 'SETTLEMENT_CANCELLED':
      return 'FINANCES';
    case 'PROFILE_PHOTO_REMOVED':
    case 'TRIP_REMOVED':
    case 'COMMUNITY_POST_REMOVED':
    case 'COMMUNITY_COMMENT_REMOVED':
    case 'MESSAGE_REMOVED':
    case 'ACCOUNT_SUSPENDED':
    case 'ACCOUNT_RESTORED':
      return 'SAFETY';
    case 'MESSAGE_RECEIVED':
    case 'MATCHING_TRIP_PUBLISHED':
      return null;
  }
}
