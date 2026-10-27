import { equalSplitRounding } from './expense.service.js';
import type { ExpenseRecord } from './expense.types.js';

export const EXPENSE_NOTICE =
  'Expense records are entered by group members and are not independently verified. Payments happen outside the platform. Never share banking passwords, OTPs, UPI PINs or card credentials.';

export function presentExpense(expense: ExpenseRecord) {
  const rounding = equalSplitRounding(
    expense.splitMethod,
    expense.amountPaise,
    expense.shares.length,
  );
  return {
    id: expense.id,
    tripId: expense.tripId,
    description: expense.description,
    note: expense.note,
    category: expense.category,
    amountPaise: expense.amountPaise,
    currency: expense.currency.trim(),
    splitMethod: expense.splitMethod,
    expenseDate: expense.expenseDate.toISOString().slice(0, 10),
    status: expense.status,
    version: expense.version,
    createdBy: expense.createdBy,
    paidBy: expense.paidBy,
    rounding,
    shares: expense.shares.map((share) => ({
      user: share.user,
      amountPaise: share.amountPaise,
      // 1 when this share absorbed a leftover paisa of an equal split.
      roundingPaise: rounding ? share.amountPaise - rounding.baseSharePaise : 0,
    })),
    createdAt: expense.createdAt.toISOString(),
    updatedAt: expense.updatedAt.toISOString(),
    voidedAt: expense.voidedAt?.toISOString() ?? null,
  };
}
