import type {
  ExpenseCategory,
  ExpenseSplitMethod,
  Prisma,
} from '@prisma/client';

export const expenseInclude = {
  createdBy: { select: { id: true, displayName: true } },
  paidBy: { select: { id: true, displayName: true } },
  shares: {
    include: { user: { select: { id: true, displayName: true } } },
    orderBy: { userId: 'asc' },
  },
} satisfies Prisma.ExpenseInclude;

export type ExpenseRecord = Prisma.ExpenseGetPayload<{
  include: typeof expenseInclude;
}>;

export interface ExpenseParticipantInput {
  userId: string;
  amountPaise?: number;
}

export interface ExpenseBody {
  description: string;
  category: ExpenseCategory;
  amountPaise: number;
  paidByUserId: string;
  splitMethod: ExpenseSplitMethod;
  participants: ExpenseParticipantInput[];
  expenseDate?: string;
}

export interface UpdateExpenseBody extends ExpenseBody {
  expectedVersion: number;
}

export interface PreparedExpense {
  description: string;
  category: ExpenseCategory;
  amountPaise: number;
  paidById: string;
  splitMethod: ExpenseSplitMethod;
  expenseDate: Date;
  shares: { userId: string; amountPaise: number }[];
}
