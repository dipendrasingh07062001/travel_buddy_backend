import type { Prisma } from '@prisma/client';

import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';

const maximumReceiptsPerExpense = 5;

export const receiptSelect = {
  id: true,
  expenseId: true,
  storageKey: true,
  contentType: true,
  sizeBytes: true,
  createdAt: true,
  uploadedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.ExpenseReceiptSelect;

export type ReceiptRecord = Prisma.ExpenseReceiptGetPayload<{
  select: typeof receiptSelect;
}>;

const missingExpense = () =>
  new AppError(404, 'EXPENSE_NOT_FOUND', 'Expense not found.');
const missingReceipt = () =>
  new AppError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found.');
const readOnly = () =>
  new AppError(
    409,
    'EXPENSE_LEDGER_READ_ONLY',
    'Completed or cancelled trip expense ledgers are read-only.',
  );

// Same visibility as the ledger itself: active members of the expense's trip.
const memberOfTrip = (actorId: string) =>
  ({
    trip: { memberships: { some: { userId: actorId, status: 'ACTIVE' } } },
  }) satisfies Prisma.ExpenseWhereInput;

const uploadCheckSelect = {
  tripId: true,
  createdById: true,
  paidById: true,
  status: true,
  trip: { select: { status: true } },
} satisfies Prisma.ExpenseSelect;

function requireUploadAllowed(
  expense: Prisma.ExpenseGetPayload<{
    select: typeof uploadCheckSelect;
  }> | null,
  actorId: string,
) {
  if (!expense) throw missingExpense();
  if (expense.createdById !== actorId && expense.paidById !== actorId) {
    throw new AppError(
      403,
      'RECEIPT_FORBIDDEN',
      'Only the member who recorded or paid this expense can attach receipts.',
    );
  }
  if (expense.status === 'VOIDED') {
    throw new AppError(409, 'EXPENSE_VOIDED', 'This expense is voided.');
  }
  if (
    expense.trip.status === 'COMPLETED' ||
    expense.trip.status === 'CANCELLED'
  ) {
    throw readOnly();
  }
  return expense;
}

// Checked before the file is read and stored, so a rejected upload costs
// nothing; checked again when the receipt row is written.
export async function receiptUploadTarget(
  expenseId: string,
  actorId: string,
): Promise<{ tripId: string }> {
  const expense = await database.expense.findFirst({
    where: { id: expenseId, ...memberOfTrip(actorId) },
    select: uploadCheckSelect,
  });
  return { tripId: requireUploadAllowed(expense, actorId).tripId };
}

export async function addReceipt(input: {
  expenseId: string;
  actorId: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
}): Promise<ReceiptRecord> {
  return database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT id FROM expenses WHERE id = ${input.expenseId}::uuid FOR UPDATE`;
    requireUploadAllowed(
      await transaction.expense.findFirst({
        where: { id: input.expenseId, ...memberOfTrip(input.actorId) },
        select: uploadCheckSelect,
      }),
      input.actorId,
    );
    const attached = await transaction.expenseReceipt.count({
      where: { expenseId: input.expenseId, removedAt: null },
    });
    if (attached >= maximumReceiptsPerExpense) {
      throw new AppError(
        409,
        'RECEIPT_LIMIT_REACHED',
        `An expense can have at most ${maximumReceiptsPerExpense} receipts.`,
      );
    }
    return transaction.expenseReceipt.create({
      data: {
        expenseId: input.expenseId,
        uploadedById: input.actorId,
        storageKey: input.storageKey,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      },
      select: receiptSelect,
    });
  });
}

export async function listReceipts(
  expenseId: string,
  actorId: string,
): Promise<ReceiptRecord[]> {
  const expense = await database.expense.findFirst({
    where: { id: expenseId, ...memberOfTrip(actorId) },
    select: { id: true },
  });
  if (!expense) throw missingExpense();
  return database.expenseReceipt.findMany({
    where: { expenseId, removedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: receiptSelect,
  });
}

// The row stays as an audit record of who attached and removed what; the
// caller deletes the file itself.
export async function removeReceipt(
  receiptId: string,
  actorId: string,
  now = new Date(),
): Promise<{ storageKey: string }> {
  return database.$transaction(async (transaction) => {
    const receipt = await transaction.expenseReceipt.findFirst({
      where: { id: receiptId, removedAt: null, expense: memberOfTrip(actorId) },
      select: {
        storageKey: true,
        uploadedById: true,
        expense: {
          select: { createdById: true, trip: { select: { status: true } } },
        },
      },
    });
    if (!receipt) throw missingReceipt();
    if (
      receipt.uploadedById !== actorId &&
      receipt.expense.createdById !== actorId
    ) {
      throw new AppError(
        403,
        'RECEIPT_FORBIDDEN',
        'Only the member who attached this receipt or recorded the expense can remove it.',
      );
    }
    const tripStatus = receipt.expense.trip.status;
    if (tripStatus === 'COMPLETED' || tripStatus === 'CANCELLED') {
      throw readOnly();
    }
    const removed = await transaction.expenseReceipt.updateMany({
      where: { id: receiptId, removedAt: null },
      data: { removedAt: now, removedById: actorId },
    });
    if (removed.count !== 1) throw missingReceipt();
    return { storageKey: receipt.storageKey };
  });
}
