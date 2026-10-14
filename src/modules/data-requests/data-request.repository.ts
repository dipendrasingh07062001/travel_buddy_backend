import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import {
  Prisma,
  type AccountDataRequestStatus,
  type AccountDataRequestType,
} from '../../generated/prisma/client.js';

// A deletion request locks the account at once and erases it after this
// period, unless the user cancels it first.
export const deletionGracePeriodMs = 30 * 24 * 60 * 60 * 1000;

export async function createDataRequest(
  userId: string,
  type: AccountDataRequestType,
  now = new Date(),
) {
  if (type === 'ACCOUNT_DELETION') return requestAccountDeletion(userId, now);

  const existing = await database.accountDataRequest.findFirst({
    where: { userId, type, status: 'OPEN' },
  });
  if (existing) return { request: existing, created: false };

  try {
    const request = await database.accountDataRequest.create({
      data: { userId, type },
    });
    return { request, created: true };
  } catch (error) {
    // The partial unique index also protects concurrent duplicate submissions.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const raced = await database.accountDataRequest.findFirst({
        where: { userId, type, status: 'OPEN' },
      });
      if (raced) return { request: raced, created: false };
    }
    throw error;
  }
}

function scheduleAccountDeletion(userId: string, now: Date) {
  return database.$transaction(async (transaction) => {
    const user = await transaction.user.findUniqueOrThrow({
      where: { id: userId },
      select: { status: true, staffRole: true },
    });
    if (user.staffRole !== 'USER') {
      throw new AppError(
        409,
        'STAFF_ACCOUNT_DELETION',
        "Revoke this account's staff role before deleting it.",
      );
    }
    const scheduledFor = new Date(now.getTime() + deletionGracePeriodMs);
    const existing = await transaction.accountDataRequest.findFirst({
      where: { userId, type: 'ACCOUNT_DELETION', status: 'OPEN' },
    });
    // Requests made before deletion was automatic have no date yet.
    const request = existing?.scheduledFor
      ? existing
      : existing
        ? await transaction.accountDataRequest.update({
            where: { id: existing.id },
            data: { scheduledFor },
          })
        : await transaction.accountDataRequest.create({
            data: { userId, type: 'ACCOUNT_DELETION', scheduledFor },
          });
    if (user.status === 'ACTIVE' || user.status === 'SUSPENDED') {
      await transaction.user.update({
        where: { id: userId },
        data: { status: 'PENDING_DELETION', statusBeforeDeletion: user.status },
      });
    }
    return { request, created: !existing };
  });
}

async function requestAccountDeletion(userId: string, now: Date) {
  try {
    return await scheduleAccountDeletion(userId, now);
  } catch (error) {
    // A concurrent request created the open request first; return that one.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return scheduleAccountDeletion(userId, now);
    }
    throw error;
  }
}

export async function listMyDataRequests(
  userId: string,
  page: number,
  pageSize: number,
) {
  const where = { userId };
  const [requests, totalItems] = await database.$transaction([
    database.accountDataRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.accountDataRequest.count({ where }),
  ]);
  return { requests, totalItems };
}

// Cancelling a deletion request also gives the account back its status.
export async function cancelDataRequest(
  userId: string,
  requestId: string,
  now = new Date(),
) {
  return database.$transaction(async (transaction) => {
    const cancelled = await transaction.accountDataRequest.updateMany({
      where: { id: requestId, userId, status: 'OPEN' },
      data: { status: 'CANCELLED', cancelledAt: now },
    });
    const request = await transaction.accountDataRequest.findFirst({
      where: { id: requestId, userId },
    });
    if (!request) {
      throw new AppError(
        404,
        'DATA_REQUEST_NOT_FOUND',
        'Data request not found.',
      );
    }
    if (cancelled.count === 1 && request.type === 'ACCOUNT_DELETION') {
      const user = await transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: { status: true, statusBeforeDeletion: true },
      });
      if (user.status === 'PENDING_DELETION' && user.statusBeforeDeletion) {
        await transaction.user.update({
          where: { id: userId },
          data: {
            status: user.statusBeforeDeletion,
            statusBeforeDeletion: null,
          },
        });
      }
    }
    return request;
  });
}

export async function listAdminDataRequests(
  status: AccountDataRequestStatus | undefined,
  page: number,
  pageSize: number,
) {
  const where: Prisma.AccountDataRequestWhereInput = status ? { status } : {};
  const [requests, totalItems] = await database.$transaction([
    database.accountDataRequest.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.accountDataRequest.count({ where }),
  ]);
  return { requests, totalItems };
}
