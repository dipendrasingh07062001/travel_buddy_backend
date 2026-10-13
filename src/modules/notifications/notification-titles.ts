import type { NotificationType } from '@prisma/client';

// Titles stay generic on purpose: inbox entries and push alerts never include
// message text, amounts, or private profile details.
export const notificationTitles: Record<NotificationType, string> = {
  CONNECTION_REQUEST_RECEIVED: 'New connection request',
  CONNECTION_REQUEST_ACCEPTED: 'Connection request accepted',
  CONNECTION_REQUEST_DECLINED: 'Connection request declined',
  CONNECTION_REQUEST_WITHDRAWN: 'Connection request withdrawn',
  TRIP_UPDATED: 'Trip plan updated',
  TRIP_STATUS_CHANGED: 'Trip status changed',
  MESSAGE_RECEIVED: 'New trip message',
  EXPENSE_CREATED: 'New shared expense',
  EXPENSE_UPDATED: 'Shared expense updated',
  EXPENSE_VOIDED: 'Shared expense voided',
  SETTLEMENT_PENDING: 'Settlement confirmation requested',
  SETTLEMENT_CONFIRMED: 'Settlement confirmed',
  SETTLEMENT_REJECTED: 'Settlement rejected',
  SETTLEMENT_CANCELLED: 'Settlement cancelled',
};
