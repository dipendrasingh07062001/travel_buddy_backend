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

// The completion's audit row names the administrator; the request itself
// does not.
const adminRequestSelect = {
  id: true,
  userId: true,
  type: true,
  status: true,
  createdAt: true,
  cancelledAt: true,
  scheduledFor: true,
  completedAt: true,
  moderationActions: {
    where: { action: 'DATA_REQUEST_COMPLETED' },
    select: { id: true, actorId: true },
    take: 1,
  },
} as const satisfies Prisma.AccountDataRequestSelect;

export type AdminDataRequest = Prisma.AccountDataRequestGetPayload<{
  select: typeof adminRequestSelect;
}>;

export interface DataRequestCompletionHooks {
  // Test-only: runs between the read and the update, to force races.
  afterRead?: () => Promise<void>;
}

// Only ACCESS requests are finished by hand; deletions are completed by the
// erasure worker. A repeat returns the existing completion unchanged.
export async function completeAccessRequest(
  requestId: string,
  actorId: string,
  note: string,
  hooks: DataRequestCompletionHooks = {},
  now = new Date(),
): Promise<{ request: AdminDataRequest; changed: boolean }> {
  return database.$transaction(async (transaction) => {
    const read = async () => {
      const request = await transaction.accountDataRequest.findUnique({
        where: { id: requestId },
        select: adminRequestSelect,
      });
      if (!request) {
        throw new AppError(
          404,
          'DATA_REQUEST_NOT_FOUND',
          'Data request not found.',
        );
      }
      if (request.type === 'ACCOUNT_DELETION') {
        throw new AppError(
          409,
          'DATA_REQUEST_AUTOMATIC',
          'Deletion requests are completed automatically.',
        );
      }
      if (request.status === 'CANCELLED') {
        throw new AppError(
          409,
          'DATA_REQUEST_NOT_OPEN',
          'This request is no longer open.',
        );
      }
      return request;
    };

    const before = await read();
    if (before.status === 'COMPLETED') {
      return { request: before, changed: false };
    }

    await hooks.afterRead?.();
    const updated = await transaction.accountDataRequest.updateMany({
      where: { id: requestId, type: 'ACCESS', status: 'OPEN' },
      data: { status: 'COMPLETED', completedAt: now },
    });
    if (updated.count !== 1) {
      // Cancelled (read throws) or completed by someone else since the read.
      return { request: await read(), changed: false };
    }
    await transaction.moderationAction.create({
      data: {
        actorId,
        action: 'DATA_REQUEST_COMPLETED',
        targetType: 'USER',
        targetId: before.userId,
        reason: note,
        dataRequestId: requestId,
      },
    });
    return { request: await read(), changed: true };
  });
}

export async function listAdminDataRequests(
  status: AccountDataRequestStatus | undefined,
  type: AccountDataRequestType | undefined,
  page: number,
  pageSize: number,
) {
  const where: Prisma.AccountDataRequestWhereInput = {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
  };
  const [requests, totalItems] = await database.$transaction([
    database.accountDataRequest.findMany({
      where,
      select: adminRequestSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.accountDataRequest.count({ where }),
  ]);
  return { requests, totalItems };
}
