import { Prisma } from '@prisma/client';

import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import { calculateBalances } from './expense.service.js';
import {
  expenseInclude,
  type ExpenseRecord,
  type PreparedExpense,
} from './expense.types.js';

const inaccessible = () =>
  new AppError(
    404,
    'EXPENSE_LEDGER_NOT_FOUND',
    'Private trip expense ledger not found.',
  );
const readOnly = () =>
  new AppError(
    409,
    'EXPENSE_LEDGER_READ_ONLY',
    'Completed or cancelled trip expense ledgers are read-only.',
  );
const missingExpense = () =>
  new AppError(404, 'EXPENSE_NOT_FOUND', 'Expense not found.');

function snapshot(expense: ExpenseRecord): Prisma.InputJsonObject {
  return {
    description: expense.description,
    category: expense.category,
    amountPaise: expense.amountPaise,
    paidByUserId: expense.paidById,
    splitMethod: expense.splitMethod,
    expenseDate: expense.expenseDate.toISOString().slice(0, 10),
    status: expense.status,
    shares: expense.shares.map((share) => ({
      userId: share.userId,
      amountPaise: share.amountPaise,
    })),
  };
}

async function lockTrip(transaction: Prisma.TransactionClient, tripId: string) {
  await transaction.$queryRaw`SELECT id FROM trips WHERE id = ${tripId}::uuid FOR UPDATE`;
}

async function eligibleTrip(
  transaction: Prisma.TransactionClient,
  tripId: string,
  actorId: string,
) {
  const trip = await transaction.trip.findUnique({
    where: { id: tripId },
    select: {
      status: true,
      memberships: {
        select: { userId: true, status: true },
      },
    },
  });
  if (
    !trip ||
    !trip.memberships.some(
      (member) => member.userId === actorId && member.status === 'ACTIVE',
    )
  ) {
    throw inaccessible();
  }
  return trip;
}

function checkParticipants(
  members: { userId: string; status: string }[],
  input: PreparedExpense,
  previouslyIncluded = new Set<string>(),
) {
  const eligible = new Set(
    members
      .filter((member) => member.status === 'ACTIVE')
      .map((member) => member.userId),
  );
  for (const userId of [
    input.paidById,
    ...input.shares.map((share) => share.userId),
  ]) {
    if (!eligible.has(userId) && !previouslyIncluded.has(userId)) {
      throw new AppError(
        400,
        'EXPENSE_MEMBER_INVALID',
        'Payer and participants must belong to this trip. New participants must be active members.',
      );
    }
  }
}

function transactionFailure(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  ) {
    throw new AppError(
      409,
      'EXPENSE_CONFLICT',
      'The ledger changed concurrently. Refresh and try again.',
    );
  }
  throw error;
}

export async function createExpense(
  tripId: string,
  actorId: string,
  input: PreparedExpense,
  now = new Date(),
) {
  try {
    return await database.$transaction(
      async (transaction) => {
        await lockTrip(transaction, tripId);
        const trip = await eligibleTrip(transaction, tripId, actorId);
        if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED')
          throw readOnly();
        checkParticipants(trip.memberships, input);
        const expense = await transaction.expense.create({
          data: {
            tripId,
            createdById: actorId,
            paidById: input.paidById,
            description: input.description,
            category: input.category,
            amountPaise: input.amountPaise,
            splitMethod: input.splitMethod,
            expenseDate: input.expenseDate,
            createdAt: now,
            shares: { create: input.shares },
          },
          include: expenseInclude,
        });
        await transaction.expenseRevision.create({
          data: {
            expenseId: expense.id,
            actorId,
            action: 'CREATE',
            version: 1,
            snapshot: snapshot(expense),
            createdAt: now,
          },
        });
        return expense;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    transactionFailure(error);
  }
}

export async function listExpenses(
  tripId: string,
  actorId: string,
  page: number,
  pageSize: number,
) {
  return database.$transaction(
    async (transaction) => {
      await eligibleTrip(transaction, tripId, actorId);
      const [expenses, total] = await Promise.all([
        transaction.expense.findMany({
          where: { tripId },
          include: expenseInclude,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        transaction.expense.count({ where: { tripId } }),
      ]);
      return { expenses, total };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function getExpense(expenseId: string, actorId: string) {
  return database.$transaction(
    async (transaction) => {
      const expense = await transaction.expense.findFirst({
        where: {
          id: expenseId,
          trip: {
            memberships: { some: { userId: actorId, status: 'ACTIVE' } },
          },
        },
        include: expenseInclude,
      });
      if (!expense) throw missingExpense();
      const revisions = await transaction.expenseRevision.findMany({
        where: { expenseId },
        select: {
          action: true,
          version: true,
          snapshot: true,
          createdAt: true,
          actor: { select: { id: true, displayName: true } },
        },
        orderBy: { version: 'asc' },
      });
      return { expense, revisions };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function updateExpense(
  expenseId: string,
  actorId: string,
  expectedVersion: number,
  input: PreparedExpense,
  now = new Date(),
) {
  try {
    return await database.$transaction(
      async (transaction) => {
        const first = await transaction.expense.findUnique({
          where: { id: expenseId },
          select: { tripId: true },
        });
        if (!first) throw missingExpense();
        await lockTrip(transaction, first.tripId);
        const trip = await eligibleTrip(transaction, first.tripId, actorId);
        const current = await transaction.expense.findUnique({
          where: { id: expenseId },
          include: expenseInclude,
        });
        if (!current) throw missingExpense();
        if (current.createdById !== actorId) throw missingExpense();
        if (current.status === 'VOIDED')
          throw new AppError(
            409,
            'EXPENSE_VOIDED',
            'A voided expense cannot be edited.',
          );
        if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED')
          throw readOnly();
        if (current.version !== expectedVersion)
          throw new AppError(
            409,
            'EXPENSE_VERSION_CONFLICT',
            'Expense changed. Refresh it before editing.',
          );
        checkParticipants(
          trip.memberships,
          input,
          new Set([
            current.paidById,
            ...current.shares.map((share) => share.userId),
          ]),
        );
        await transaction.expenseShare.deleteMany({ where: { expenseId } });
        const expense = await transaction.expense.update({
          where: { id: expenseId },
          data: {
            paidById: input.paidById,
            description: input.description,
            category: input.category,
            amountPaise: input.amountPaise,
            splitMethod: input.splitMethod,
            expenseDate: input.expenseDate,
            version: { increment: 1 },
            shares: { create: input.shares },
          },
          include: expenseInclude,
        });
        await transaction.expenseRevision.create({
          data: {
            expenseId,
            actorId,
            action: 'EDIT',
            version: expense.version,
            snapshot: snapshot(expense),
            createdAt: now,
          },
        });
        return expense;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    transactionFailure(error);
  }
}

export async function voidExpense(
  expenseId: string,
  actorId: string,
  expectedVersion: number,
  now = new Date(),
) {
  try {
    return await database.$transaction(
      async (transaction) => {
        const first = await transaction.expense.findUnique({
          where: { id: expenseId },
          select: { tripId: true },
        });
        if (!first) throw missingExpense();
        await lockTrip(transaction, first.tripId);
        const trip = await eligibleTrip(transaction, first.tripId, actorId);
        const current = await transaction.expense.findUnique({
          where: { id: expenseId },
          select: { createdById: true, status: true, version: true },
        });
        if (!current || current.createdById !== actorId) throw missingExpense();
        if (current.status === 'VOIDED')
          throw new AppError(
            409,
            'EXPENSE_VOIDED',
            'This expense is already voided.',
          );
        if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED')
          throw readOnly();
        if (current.version !== expectedVersion)
          throw new AppError(
            409,
            'EXPENSE_VERSION_CONFLICT',
            'Expense changed. Refresh it before voiding.',
          );
        const expense = await transaction.expense.update({
          where: { id: expenseId },
          data: { status: 'VOIDED', voidedAt: now, version: { increment: 1 } },
          include: expenseInclude,
        });
        await transaction.expenseRevision.create({
          data: {
            expenseId,
            actorId,
            action: 'VOID',
            version: expense.version,
            snapshot: snapshot(expense),
            createdAt: now,
          },
        });
        return expense;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    transactionFailure(error);
  }
}

export async function getBalances(tripId: string, actorId: string) {
  return database.$transaction(
    async (transaction) => {
      const trip = await transaction.trip.findFirst({
        where: {
          id: tripId,
          memberships: { some: { userId: actorId, status: 'ACTIVE' } },
        },
        select: {
          id: true,
          memberships: {
            select: {
              userId: true,
              status: true,
              user: { select: { displayName: true } },
            },
          },
        },
      });
      if (!trip) throw inaccessible();
      const expenses = await transaction.expense.findMany({
        where: { tripId, status: 'ACTIVE' },
        select: {
          paidById: true,
          amountPaise: true,
          shares: { select: { userId: true, amountPaise: true } },
        },
      });
      return {
        tripId,
        currency: 'INR',
        totalExpensePaise: expenses.reduce(
          (sum, expense) => sum + expense.amountPaise,
          0,
        ),
        balances: calculateBalances(trip.memberships, expenses),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
