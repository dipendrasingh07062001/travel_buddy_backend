import {
  Prisma,
  type AccountDataRequestStatus,
  type AccountDataRequestType,
} from '@prisma/client';

import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';

export async function createDataRequest(
  userId: string,
  type: AccountDataRequestType,
) {
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

export async function cancelDataRequest(userId: string, requestId: string) {
  const result = await database.accountDataRequest.updateMany({
    where: { id: requestId, userId, status: 'OPEN' },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
  if (result.count === 0) {
    const existing = await database.accountDataRequest.findFirst({
      where: { id: requestId, userId },
    });
    if (!existing) {
      throw new AppError(
        404,
        'DATA_REQUEST_NOT_FOUND',
        'Data request not found.',
      );
    }
    return existing;
  }
  return database.accountDataRequest.findUniqueOrThrow({
    where: { id: requestId },
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
