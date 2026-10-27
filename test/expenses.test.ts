import { describe, expect, it } from 'vitest';

import {
  calculateBalances,
  prepareExpense,
  prepareSettlementMethod,
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

  it('trims a note, treats a blank one as no note, and keeps omission distinct', () => {
    expect(prepareExpense({ ...base, note: '  includes tip  ' }).note).toBe(
      'includes tip',
    );
    expect(prepareExpense({ ...base, note: '   ' }).note).toBeNull();
    expect(prepareExpense({ ...base, note: null }).note).toBeNull();
    // Leaving it out lets an edit keep the current note.
    expect(prepareExpense(base).note).toBeUndefined();
  });
});

describe('settlement method', () => {
  it('trims the text and treats a missing or blank one as not stated', () => {
    expect(prepareSettlementMethod('  UPI  ')).toBe('UPI');
    expect(prepareSettlementMethod('   ')).toBeNull();
    expect(prepareSettlementMethod(null)).toBeNull();
    expect(prepareSettlementMethod(undefined)).toBeNull();
    expect(prepareSettlementMethod(` ${'x'.repeat(50)} `)).toBe('x'.repeat(50));
    expect(prepareSettlementMethod('💵'.repeat(50))).toBe('💵'.repeat(50));
    expect(() => prepareSettlementMethod('x'.repeat(51))).toThrow(
      expect.objectContaining({ code: 'INVALID_SETTLEMENT_METHOD' }),
    );
  });

  it('allows up to 3 digits so PINs, OTPs and card or account numbers are refused', () => {
    expect(prepareSettlementMethod('GPay 123')).toBe('GPay 123');
    expect(prepareSettlementMethod('Cash, day 2')).toBe('Cash, day 2');
    for (const method of [
      'UPI PIN 1234',
      'OTP 482910',
      '4111 1111 1111 1111',
      '1 2 3 4',
      'Paid to 98765 43210',
      'IFSC SBIN0001234',
      '१२३४',
    ]) {
      expect(() => prepareSettlementMethod(method), method).toThrow(
        expect.objectContaining({ code: 'INVALID_SETTLEMENT_METHOD' }),
      );
    }
  });
});
