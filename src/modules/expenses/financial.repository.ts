import { Prisma, type SettlementStatus } from '@prisma/client';

import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import { calculateBalances } from './expense.service.js';

const person = { select: { id: true, displayName: true } } as const;
const settlementInclude = { payer: person, receiver: person } as const;
const disputeInclude = { reporter: person } as const;

const unavailable = () =>
  new AppError(
    404,
    'FINANCIAL_RECORD_NOT_FOUND',
    'Financial record not found.',
  );
const conflict = (code: string, message: string) =>
  new AppError(409, code, message);

async function lockTrip(tx: Prisma.TransactionClient, tripId: string) {
  await tx.$queryRaw`SELECT id FROM trips WHERE id = ${tripId}::uuid FOR UPDATE`;
}

async function membership(
  tx: Prisma.TransactionClient,
  tripId: string,
  userId: string,
) {
  const member = await tx.tripMembership.findUnique({
    where: { tripId_userId: { tripId, userId } },
    select: { status: true },
  });
  if (!member) throw unavailable();
  return member;
}

async function financialBalances(tx: Prisma.TransactionClient, tripId: string) {
  const [members, expenses, settlements] = await Promise.all([
    tx.tripMembership.findMany({
      where: { tripId },
      select: {
        userId: true,
        status: true,
        user: { select: { displayName: true, status: true } },
      },
    }),
    tx.expense.findMany({
      where: { tripId, status: 'ACTIVE' },
      select: {
        paidById: true,
        amountPaise: true,
        shares: { select: { userId: true, amountPaise: true } },
      },
    }),
    tx.settlement.findMany({
      where: { tripId, status: 'CONFIRMED' },
      select: { payerId: true, receiverId: true, amountPaise: true },
    }),
  ]);
  return {
    members,
    balances: calculateBalances(members, expenses, settlements),
  };
}

function availableTransfer(
  balances: ReturnType<typeof calculateBalances>,
  payerId: string,
  receiverId: string,
) {
  const payer = balances.find((balance) => balance.userId === payerId);
  const receiver = balances.find((balance) => balance.userId === receiverId);
  return Math.min(
    Math.max(0, -(payer?.remainingNetPaise ?? 0)),
    Math.max(0, receiver?.remainingNetPaise ?? 0),
  );
}

function translateWriteError(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  ) {
    throw conflict(
      'FINANCIAL_RECORD_CONFLICT',
      'Financial records changed concurrently. Refresh and try again.',
    );
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw conflict(
      'FINANCIAL_RECORD_DUPLICATE',
      'An open record already exists for these members.',
    );
  }
  throw error;
}

export async function getMyFinancialRecords(
  tripId: string,
  actorId: string,
  page: number,
  pageSize: number,
) {
  return database.$transaction(
    async (tx) => {
      await membership(tx, tripId, actorId);
      const { balances } = await financialBalances(tx, tripId);
      const where = {
        tripId,
        OR: [{ paidById: actorId }, { shares: { some: { userId: actorId } } }],
      };
      const [expenses, total] = await Promise.all([
        tx.expense.findMany({
          where,
          select: {
            id: true,
            description: true,
            category: true,
            amountPaise: true,
            expenseDate: true,
            status: true,
            version: true,
            createdAt: true,
            updatedAt: true,
            paidBy: person,
            shares: {
              where: { userId: actorId },
              select: { amountPaise: true },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.expense.count({ where }),
      ]);
      return {
        tripId,
        currency: 'INR',
        balance: balances.find((balance) => balance.userId === actorId)!,
        expenses: expenses.map((expense) => ({
          id: expense.id,
          description: expense.description,
          category: expense.category,
          amountPaise: expense.amountPaise,
          ownSharePaise: expense.shares[0]?.amountPaise ?? 0,
          paidBy: expense.paidBy,
          expenseDate: expense.expenseDate.toISOString().slice(0, 10),
          status: expense.status,
          version: expense.version,
          createdAt: expense.createdAt.toISOString(),
          updatedAt: expense.updatedAt.toISOString(),
        })),
        pagination: { page, pageSize, total },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function recordSettlement(
  tripId: string,
  actorId: string,
  receiverId: string,
  amountPaise: number,
  now = new Date(),
) {
  if (actorId === receiverId)
    throw new AppError(
      400,
      'INVALID_SETTLEMENT_RECEIVER',
      'Choose another trip member as the receiver.',
    );
  if (
    !Number.isSafeInteger(amountPaise) ||
    amountPaise < 1 ||
    amountPaise > 1_000_000_000
  ) {
    throw new AppError(
      400,
      'INVALID_SETTLEMENT_AMOUNT',
      'Amount must be between 1 and 1,000,000,000 paise.',
    );
  }
  try {
    return await database.$transaction(
      async (tx) => {
        await lockTrip(tx, tripId);
        await membership(tx, tripId, actorId);
        const receiverMembership = await tx.tripMembership.findUnique({
          where: { tripId_userId: { tripId, userId: receiverId } },
          select: { user: { select: { status: true } } },
        });
        if (
          !receiverMembership ||
          receiverMembership.user.status !== 'ACTIVE'
        ) {
          throw new AppError(
            400,
            'INVALID_SETTLEMENT_RECEIVER',
            'Receiver must be an available current or former trip member.',
          );
        }
        const blocked = await tx.userBlock.findFirst({
          where: {
            OR: [
              { blockerId: actorId, blockedId: receiverId },
              { blockerId: receiverId, blockedId: actorId },
            ],
          },
          select: { blockerId: true },
        });
        if (blocked)
          throw conflict(
            'SETTLEMENT_CONTACT_BLOCKED',
            'A block prevents a new settlement record between these members.',
          );
        const pending = await tx.settlement.findFirst({
          where: { tripId, payerId: actorId, receiverId, status: 'PENDING' },
          select: { id: true },
        });
        if (pending)
          throw conflict(
            'SETTLEMENT_ALREADY_PENDING',
            'Resolve the existing pending settlement with this member first.',
          );
        const { balances } = await financialBalances(tx, tripId);
        if (amountPaise > availableTransfer(balances, actorId, receiverId)) {
          throw conflict(
            'SETTLEMENT_EXCEEDS_BALANCE',
            'Settlement exceeds the current outstanding balance between these members.',
          );
        }
        return tx.settlement.create({
          data: {
            tripId,
            payerId: actorId,
            receiverId,
            amountPaise,
            createdAt: now,
          },
          include: settlementInclude,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    translateWriteError(error);
  }
}

export async function decideSettlement(
  settlementId: string,
  actorId: string,
  decision: Exclude<SettlementStatus, 'PENDING'>,
  now = new Date(),
) {
  try {
    return await database.$transaction(
      async (tx) => {
        const first = await tx.settlement.findUnique({
          where: { id: settlementId },
          select: { tripId: true },
        });
        if (!first) throw unavailable();
        await lockTrip(tx, first.tripId);
        await membership(tx, first.tripId, actorId);
        const current = await tx.settlement.findUnique({
          where: { id: settlementId },
        });
        if (!current) throw unavailable();
        const allowed =
          decision === 'CANCELLED'
            ? current.payerId === actorId
            : current.receiverId === actorId;
        if (!allowed) throw unavailable();
        if (current.status !== 'PENDING')
          throw conflict(
            'SETTLEMENT_ALREADY_DECIDED',
            'This settlement is no longer pending.',
          );
        if (decision === 'CONFIRMED') {
          const { balances } = await financialBalances(tx, current.tripId);
          if (
            current.amountPaise >
            availableTransfer(balances, current.payerId, current.receiverId)
          ) {
            throw conflict(
              'SETTLEMENT_EXCEEDS_BALANCE',
              'Outstanding balances changed. Ask the payer to record a new amount.',
            );
          }
        }
        return tx.settlement.update({
          where: { id: settlementId },
          data: {
            status: decision,
            ...(decision === 'CANCELLED'
              ? { cancelledAt: now }
              : { decidedAt: now }),
          },
          include: settlementInclude,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    translateWriteError(error);
  }
}

export async function listSettlements(
  tripId: string,
  actorId: string,
  ownOnly: boolean,
  page: number,
  pageSize: number,
) {
  return database.$transaction(
    async (tx) => {
      const member = await membership(tx, tripId, actorId);
      if (!ownOnly && member.status !== 'ACTIVE') throw unavailable();
      const where = {
        tripId,
        ...(ownOnly && { OR: [{ payerId: actorId }, { receiverId: actorId }] }),
      };
      const [records, total] = await Promise.all([
        tx.settlement.findMany({
          where,
          include: settlementInclude,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.settlement.count({ where }),
      ]);
      return { records, pagination: { page, pageSize, total } };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function flagExpense(
  expenseId: string,
  actorId: string,
  reason: string,
  now = new Date(),
) {
  const cleanReason = reason.trim();
  if (cleanReason.length < 2 || cleanReason.length > 500) {
    throw new AppError(
      400,
      'INVALID_DISPUTE_REASON',
      'Give a reason between 2 and 500 characters.',
    );
  }
  try {
    return await database.$transaction(
      async (tx) => {
        const first = await tx.expense.findUnique({
          where: { id: expenseId },
          select: { tripId: true },
        });
        if (!first) throw unavailable();
        await lockTrip(tx, first.tripId);
        await membership(tx, first.tripId, actorId);
        const expense = await tx.expense.findUnique({
          where: { id: expenseId },
          select: {
            status: true,
            paidById: true,
            shares: { where: { userId: actorId }, select: { userId: true } },
          },
        });
        if (
          !expense ||
          (expense.paidById !== actorId && expense.shares.length === 0)
        )
          throw unavailable();
        if (expense.status !== 'ACTIVE')
          throw conflict(
            'EXPENSE_VOIDED',
            'A voided expense cannot be disputed.',
          );
        const existing = await tx.expenseDispute.findFirst({
          where: { expenseId, reporterId: actorId, status: 'OPEN' },
          select: { id: true },
        });
        if (existing)
          throw conflict(
            'EXPENSE_ALREADY_DISPUTED',
            'You already have an open dispute for this expense.',
          );
        return tx.expenseDispute.create({
          data: {
            expenseId,
            reporterId: actorId,
            reason: cleanReason,
            createdAt: now,
          },
          include: disputeInclude,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    translateWriteError(error);
  }
}

export async function withdrawDispute(
  disputeId: string,
  actorId: string,
  now = new Date(),
) {
  try {
    return await database.$transaction(
      async (tx) => {
        const first = await tx.expenseDispute.findUnique({
          where: { id: disputeId },
          select: { expense: { select: { tripId: true } } },
        });
        if (!first) throw unavailable();
        await lockTrip(tx, first.expense.tripId);
        await membership(tx, first.expense.tripId, actorId);
        const current = await tx.expenseDispute.findUnique({
          where: { id: disputeId },
        });
        if (!current || current.reporterId !== actorId) throw unavailable();
        if (current.status !== 'OPEN')
          throw conflict(
            'DISPUTE_ALREADY_WITHDRAWN',
            'This dispute is already withdrawn.',
          );
        return tx.expenseDispute.update({
          where: { id: disputeId },
          data: { status: 'WITHDRAWN', withdrawnAt: now },
          include: disputeInclude,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    translateWriteError(error);
  }
}

export async function listDisputes(expenseId: string, actorId: string) {
  return database.$transaction(
    async (tx) => {
      const expense = await tx.expense.findUnique({
        where: { id: expenseId },
        select: {
          tripId: true,
          paidById: true,
          shares: { where: { userId: actorId }, select: { userId: true } },
        },
      });
      if (!expense) throw unavailable();
      const member = await membership(tx, expense.tripId, actorId);
      if (
        member.status !== 'ACTIVE' &&
        expense.paidById !== actorId &&
        expense.shares.length === 0
      )
        throw unavailable();
      return tx.expenseDispute.findMany({
        where: {
          expenseId,
          ...(member.status !== 'ACTIVE' && { reporterId: actorId }),
        },
        include: disputeInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
