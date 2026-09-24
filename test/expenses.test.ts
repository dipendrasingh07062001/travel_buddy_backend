import { describe, expect, it } from 'vitest';

import {
  calculateBalances,
  prepareExpense,
} from '../src/modules/expenses/expense.service.js';

const ids = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
];
const base = {
  description: '  Hotel  ',
  category: 'ACCOMMODATION' as const,
  amountPaise: 1001,
  paidByUserId: ids[0]!,
  splitMethod: 'EQUAL' as const,
  participants: ids.map((userId) => ({ userId })),
};

describe('expense calculations', () => {
  it('allocates an equal split to the paisa in stable member order', () => {
    const prepared = prepareExpense({
      ...base,
      participants: [...base.participants].reverse(),
    });
    expect(prepared.description).toBe('Hotel');
    expect(prepared.shares).toEqual([
      { userId: ids[0], amountPaise: 334 },
      { userId: ids[1], amountPaise: 334 },
      { userId: ids[2], amountPaise: 333 },
    ]);
  });

  it('rejects duplicate, zero and mismatched custom shares', () => {
    expect(() =>
      prepareExpense({
        ...base,
        participants: [{ userId: ids[0]! }, { userId: ids[0]! }],
      }),
    ).toThrow();
    expect(() =>
      prepareExpense({
        ...base,
        splitMethod: 'CUSTOM',
        participants: [{ userId: ids[0]!, amountPaise: 1000 }],
      }),
    ).toThrow();
    expect(() =>
      prepareExpense({
        ...base,
        splitMethod: 'CUSTOM',
        participants: [
          { userId: ids[0]!, amountPaise: 0 },
          { userId: ids[1]!, amountPaise: 1001 },
        ],
      }),
    ).toThrow();
    expect(() => prepareExpense({ ...base, amountPaise: 1 })).toThrow();
  });

  it('shows historic members and nets a payer’s own share', () => {
    const balances = calculateBalances(
      ids.map((userId, index) => ({
        userId,
        status: index === 2 ? 'LEFT' : 'ACTIVE',
        user: { displayName: null },
      })),
      [
        {
          paidById: ids[0]!,
          amountPaise: 1001,
          shares: [
            { userId: ids[0]!, amountPaise: 334 },
            { userId: ids[1]!, amountPaise: 334 },
            { userId: ids[2]!, amountPaise: 333 },
          ],
        },
      ],
    );
    expect(balances.map((balance) => balance.netPaise)).toEqual([
      667, -334, -333,
    ]);
    expect(balances[2]?.membershipStatus).toBe('LEFT');
  });
});
