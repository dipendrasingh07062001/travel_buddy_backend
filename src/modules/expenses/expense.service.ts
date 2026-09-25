import { AppError } from '../../errors/app-error.js';
import type { ExpenseBody, PreparedExpense } from './expense.types.js';

const MAX_AMOUNT_PAISE = 1_000_000_000;

export function prepareExpense(
  body: ExpenseBody,
  now = new Date(),
): PreparedExpense {
  const description = body.description.trim();
  if (description.length < 2) {
    throw new AppError(
      400,
      'INVALID_EXPENSE_DESCRIPTION',
      'Give this expense a short description.',
    );
  }
  if (
    !Number.isSafeInteger(body.amountPaise) ||
    body.amountPaise < 1 ||
    body.amountPaise > MAX_AMOUNT_PAISE
  ) {
    throw new AppError(
      400,
      'INVALID_EXPENSE_AMOUNT',
      'Amount must be between 1 and 1,000,000,000 paise.',
    );
  }
  const dateText = body.expenseDate ?? now.toISOString().slice(0, 10);
  const expenseDate = new Date(`${dateText}T00:00:00.000Z`);
  if (
    Number.isNaN(expenseDate.getTime()) ||
    expenseDate.toISOString().slice(0, 10) !== dateText ||
    dateText > now.toISOString().slice(0, 10)
  ) {
    throw new AppError(
      400,
      'INVALID_EXPENSE_DATE',
      'Expense date must be a valid date no later than today.',
    );
  }
  if (body.participants.length === 0 || body.participants.length > 30) {
    throw new AppError(
      400,
      'INVALID_EXPENSE_PARTICIPANTS',
      'Choose between 1 and 30 trip members.',
    );
  }
  const ids = body.participants.map((participant) =>
    participant.userId.toLowerCase(),
  );
  if (new Set(ids).size !== ids.length) {
    throw new AppError(
      400,
      'DUPLICATE_EXPENSE_PARTICIPANT',
      'Each member can appear only once in a split.',
    );
  }
  const ordered = body.participants
    .map((participant) => ({
      ...participant,
      userId: participant.userId.toLowerCase(),
    }))
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  let shares: PreparedExpense['shares'];
  if (body.splitMethod === 'EQUAL') {
    if (
      body.participants.some(
        (participant) => participant.amountPaise !== undefined,
      )
    ) {
      throw new AppError(
        400,
        'INVALID_EQUAL_SPLIT',
        'Do not send individual amounts for an equal split.',
      );
    }
    if (body.amountPaise < ordered.length) {
      throw new AppError(
        400,
        'INVALID_EQUAL_SPLIT',
        'Amount must allow at least one paisa per participant.',
      );
    }
    const base = Math.floor(body.amountPaise / ordered.length);
    const remainder = body.amountPaise % ordered.length;
    shares = ordered.map((participant, index) => ({
      userId: participant.userId,
      amountPaise: base + (index < remainder ? 1 : 0),
    }));
  } else {
    if (
      ordered.some(
        (participant) =>
          !Number.isSafeInteger(participant.amountPaise) ||
          (participant.amountPaise ?? 0) < 1,
      )
    ) {
      throw new AppError(
        400,
        'INVALID_CUSTOM_SPLIT',
        'Every custom share must be a positive integer number of paise.',
      );
    }
    shares = ordered.map((participant) => ({
      userId: participant.userId,
      amountPaise: participant.amountPaise!,
    }));
    if (
      shares.reduce((sum, share) => sum + share.amountPaise, 0) !==
      body.amountPaise
    ) {
      throw new AppError(
        400,
        'CUSTOM_SPLIT_TOTAL_MISMATCH',
        'Custom shares must add up to the expense amount.',
      );
    }
  }
  return {
    description,
    category: body.category,
    amountPaise: body.amountPaise,
    paidById: body.paidByUserId.toLowerCase(),
    splitMethod: body.splitMethod,
    expenseDate,
    shares,
  };
}

export function calculateBalances(
  members: {
    userId: string;
    status: string;
    user: { displayName: string | null };
  }[],
  expenses: {
    paidById: string;
    amountPaise: number;
    shares: { userId: string; amountPaise: number }[];
  }[],
  confirmedSettlements: {
    payerId: string;
    receiverId: string;
    amountPaise: number;
  }[] = [],
) {
  const balances = new Map(
    members.map((member) => [
      member.userId,
      {
        userId: member.userId,
        displayName: member.user.displayName,
        membershipStatus: member.status,
        paidPaise: 0,
        owedPaise: 0,
        netPaise: 0,
        settlementsSentPaise: 0,
        settlementsReceivedPaise: 0,
        remainingNetPaise: 0,
      },
    ]),
  );
  for (const expense of expenses) {
    const payer = balances.get(expense.paidById);
    if (payer) payer.paidPaise += expense.amountPaise;
    for (const share of expense.shares) {
      const participant = balances.get(share.userId);
      if (participant) participant.owedPaise += share.amountPaise;
    }
  }
  for (const settlement of confirmedSettlements) {
    const payer = balances.get(settlement.payerId);
    const receiver = balances.get(settlement.receiverId);
    if (payer) payer.settlementsSentPaise += settlement.amountPaise;
    if (receiver) receiver.settlementsReceivedPaise += settlement.amountPaise;
  }
  return [...balances.values()]
    .map((balance) => ({
      ...balance,
      netPaise: balance.paidPaise - balance.owedPaise,
      remainingNetPaise:
        balance.paidPaise -
        balance.owedPaise +
        balance.settlementsSentPaise -
        balance.settlementsReceivedPaise,
    }))
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}
