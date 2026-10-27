import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const communityId = randomUUID();
const tripId = randomUUID();
const methodTripId = randomUUID();
const roundingTripId = randomUUID();
const users = {
  owner: randomUUID(),
  memberA: randomUUID(),
  memberB: randomUUID(),
  outsider: randomUUID(),
  // Records settlements on its own trip, with its own rate-limit allowance.
  payer: randomUUID(),
};
const subjects = Object.fromEntries(
  Object.keys(users).map((role) => [role, `financial-${role}-${randomUUID()}`]),
);
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: subjects[token] ?? 'unknown', emailVerified: false };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const headers = (role: string) => ({ authorization: `Bearer ${role}` });
const expenseUrl = `/api/v1/trips/${tripId}/expenses`;
const settlementUrl = `/api/v1/trips/${tripId}/settlements`;

async function request(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  role: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: headers(role),
    ...(payload && { payload }),
  });
}

beforeAll(async () => {
  await app.ready();
  await database.community.create({
    data: {
      id: communityId,
      slug: `financial-${communityId}`,
      name: 'Financial Test Community',
    },
  });
  for (const [role, id] of Object.entries(users)) {
    await database.user.create({
      data: {
        id,
        displayName: role,
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subjects[role]! },
        },
      },
    });
  }
  await database.trip.create({
    data: {
      id: tripId,
      ownerId: users.owner,
      communityId,
      originCity: 'Delhi',
      startDate: new Date('2026-10-10'),
      endDate: new Date('2026-10-12'),
      durationDays: 3,
      desiredGroupSize: 3,
      currentGroupSize: 3,
      description: 'Financial integration test trip',
      status: 'FULL',
      publishedAt: new Date(),
      memberships: {
        create: [
          { userId: users.owner, role: 'OWNER' },
          { userId: users.memberA, role: 'MEMBER' },
          { userId: users.memberB, role: 'MEMBER' },
        ],
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({
    where: { id: { in: [tripId, methodTripId, roundingTripId] } },
  });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({
    where: { id: { in: Object.values(users) } },
  });
  await database.$disconnect();
});

describe('disputes and external settlement confirmation', () => {
  it('keeps personal financial access narrow and changes balances only after receiver confirmation', async () => {
    const created = await request('POST', expenseUrl, 'owner', {
      description: 'Hotel',
      category: 'ACCOMMODATION',
      amountPaise: 3000,
      paidByUserId: users.owner,
      splitMethod: 'EQUAL',
      participants: [users.owner, users.memberA, users.memberB].map(
        (userId) => ({ userId }),
      ),
    });
    expect(created.statusCode).toBe(201);
    const expenseId = created.json().data.id as string;
    const ownerBalance = async () =>
      (await request('GET', `${expenseUrl}/balances`, 'owner')).json().data
        .balances;
    expect(
      (await ownerBalance()).find(
        (balance: { userId: string }) => balance.userId === users.memberA,
      ).remainingNetPaise,
    ).toBe(-1000);

    const pending = await request('POST', settlementUrl, 'memberA', {
      receiverId: users.owner,
      amountPaise: 600,
    });
    expect(pending.statusCode).toBe(201);
    expect(pending.json().data.status).toBe('PENDING');
    const settlementId = pending.json().data.id as string;
    expect(
      (await ownerBalance()).find(
        (balance: { userId: string }) => balance.userId === users.memberA,
      ).remainingNetPaise,
    ).toBe(-1000);
    expect(
      (
        await request('POST', `${settlementUrl}`, 'memberA', {
          receiverId: users.owner,
          amountPaise: 100,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request(
          'POST',
          `/api/v1/settlements/${settlementId}/confirm`,
          'memberB',
        )
      ).statusCode,
    ).toBe(404);
    const confirmed = await request(
      'POST',
      `/api/v1/settlements/${settlementId}/confirm`,
      'owner',
    );
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data.status).toBe('CONFIRMED');
    expect(
      (await ownerBalance()).find(
        (balance: { userId: string }) => balance.userId === users.memberA,
      ),
    ).toMatchObject({
      netPaise: -1000,
      settlementsSentPaise: 600,
      remainingNetPaise: -400,
    });
    expect(
      (
        await request(
          'POST',
          `/api/v1/settlements/${settlementId}/confirm`,
          'owner',
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request('POST', settlementUrl, 'memberA', {
          receiverId: users.owner,
          amountPaise: 401,
        })
      ).statusCode,
    ).toBe(409);

    const rejected = await request('POST', settlementUrl, 'memberA', {
      receiverId: users.owner,
      amountPaise: 200,
    });
    expect(
      (
        await request(
          'POST',
          `/api/v1/settlements/${rejected.json().data.id}/reject`,
          'owner',
        )
      ).json().data.status,
    ).toBe('REJECTED');
    expect(
      (await ownerBalance()).find(
        (balance: { userId: string }) => balance.userId === users.memberA,
      ).remainingNetPaise,
    ).toBe(-400);
    const cancelled = await request('POST', settlementUrl, 'memberA', {
      receiverId: users.owner,
      amountPaise: 200,
    });
    expect(
      (
        await request(
          'POST',
          `/api/v1/settlements/${cancelled.json().data.id}/cancel`,
          'memberA',
        )
      ).json().data.status,
    ).toBe('CANCELLED');

    await database.tripMembership.update({
      where: { tripId_userId: { tripId, userId: users.memberB } },
      data: { status: 'LEFT', leftAt: new Date() },
    });
    expect(
      (await request('GET', `${expenseUrl}/balances`, 'memberB')).statusCode,
    ).toBe(404);
    expect((await request('GET', settlementUrl, 'memberB')).statusCode).toBe(
      404,
    );
    const own = await request('GET', `${expenseUrl}/me`, 'memberB');
    expect(own.statusCode).toBe(200);
    expect(own.json().data.balance).toMatchObject({
      userId: users.memberB,
      membershipStatus: 'LEFT',
      remainingNetPaise: -1000,
    });
    expect(own.json().data.expenses).toHaveLength(1);
    expect(own.json().data.expenses[0]).toMatchObject({
      id: expenseId,
      ownSharePaise: 1000,
    });
    expect(own.json().data.expenses[0].shares).toBeUndefined();
    expect(
      (await request('GET', `${expenseUrl}/me`, 'outsider')).statusCode,
    ).toBe(404);

    const formerPayment = await request('POST', settlementUrl, 'memberB', {
      receiverId: users.owner,
      amountPaise: 400,
    });
    expect(formerPayment.statusCode).toBe(201);
    expect(
      (await request('GET', `${settlementUrl}/me`, 'memberB')).json().data,
    ).toHaveLength(1);
    expect(
      (await request('GET', `${settlementUrl}/me`, 'memberA')).json().data,
    ).toHaveLength(3);
    expect(
      (
        await request(
          'POST',
          `/api/v1/settlements/${formerPayment.json().data.id}/confirm`,
          'owner',
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await request('GET', `${expenseUrl}/me`, 'memberB')).json().data.balance
        .remainingNetPaise,
    ).toBe(-600);

    const pendingBeforeEdit = await request('POST', settlementUrl, 'memberB', {
      receiverId: users.owner,
      amountPaise: 500,
    });
    expect(pendingBeforeEdit.statusCode).toBe(201);
    const replacement = (amountPaise: number, expectedVersion: number) => ({
      description: 'Hotel',
      category: 'ACCOMMODATION',
      amountPaise,
      paidByUserId: users.owner,
      splitMethod: 'EQUAL',
      participants: [users.owner, users.memberA, users.memberB].map(
        (userId) => ({ userId }),
      ),
      expectedVersion,
    });
    expect(
      (
        await request(
          'PUT',
          `/api/v1/expenses/${expenseId}`,
          'owner',
          replacement(1800, 1),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          'POST',
          `/api/v1/settlements/${pendingBeforeEdit.json().data.id}/confirm`,
          'owner',
        )
      ).json().error.code,
    ).toBe('SETTLEMENT_EXCEEDS_BALANCE');
    expect(
      (
        await request(
          'POST',
          `/api/v1/settlements/${pendingBeforeEdit.json().data.id}/cancel`,
          'memberB',
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          'PUT',
          `/api/v1/expenses/${expenseId}`,
          'owner',
          replacement(3000, 2),
        )
      ).statusCode,
    ).toBe(200);

    const flagged = await request(
      'POST',
      `/api/v1/expenses/${expenseId}/disputes`,
      'memberB',
      { reason: 'My share is incorrect.' },
    );
    expect(flagged.statusCode).toBe(201);
    const disputeId = flagged.json().data.id as string;
    expect(
      (
        await request(
          'POST',
          `/api/v1/expenses/${expenseId}/disputes`,
          'memberB',
          { reason: 'Again' },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request(
          'GET',
          `/api/v1/expenses/${expenseId}/disputes`,
          'memberB',
        )
      ).json().data,
    ).toHaveLength(1);
    expect(
      (
        await request('GET', `/api/v1/expenses/${expenseId}/disputes`, 'owner')
      ).json().data,
    ).toHaveLength(1);
    expect(
      (
        await request(
          'GET',
          `/api/v1/expenses/${expenseId}/disputes`,
          'outsider',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'POST',
          `/api/v1/expense-disputes/${disputeId}/withdraw`,
          'owner',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'POST',
          `/api/v1/expense-disputes/${disputeId}/withdraw`,
          'memberB',
        )
      ).json().data.status,
    ).toBe('WITHDRAWN');
    expect(await database.expenseDispute.count({ where: { expenseId } })).toBe(
      1,
    );

    await database.trip.update({
      where: { id: tripId },
      data: { status: 'COMPLETED' },
    });
    expect(
      (
        await request('POST', expenseUrl, 'owner', {
          description: 'Late expense',
          category: 'FOOD',
          amountPaise: 100,
          paidByUserId: users.owner,
          splitMethod: 'EQUAL',
          participants: [{ userId: users.owner }],
        })
      ).statusCode,
    ).toBe(409);
    const postTripPayment = await request('POST', settlementUrl, 'memberA', {
      receiverId: users.owner,
      amountPaise: 400,
    });
    expect(postTripPayment.statusCode).toBe(201);
    expect(
      (
        await request(
          'POST',
          `/api/v1/settlements/${postTripPayment.json().data.id}/confirm`,
          'owner',
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await ownerBalance()).find(
        (balance: { userId: string }) => balance.userId === users.memberA,
      ).remainingNetPaise,
    ).toBe(0);

    await database.userBlock.create({
      data: { blockerId: users.owner, blockedId: users.memberB },
    });
    expect(
      (
        await request('POST', settlementUrl, 'memberB', {
          receiverId: users.owner,
          amountPaise: 100,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('records an optional payment method and refuses numbers that could be PINs or card details', async () => {
    // Its own trip, so the balances above are not involved.
    await database.trip.create({
      data: {
        id: methodTripId,
        ownerId: users.owner,
        communityId,
        originCity: 'Jaipur',
        startDate: new Date('2026-10-10'),
        endDate: new Date('2026-10-12'),
        durationDays: 3,
        desiredGroupSize: 2,
        currentGroupSize: 2,
        description: 'Settlement method test trip',
        status: 'FULL',
        publishedAt: new Date(),
        memberships: {
          create: [
            { userId: users.owner, role: 'OWNER' },
            { userId: users.payer, role: 'MEMBER' },
          ],
        },
      },
    });
    const url = `/api/v1/trips/${methodTripId}/settlements`;
    expect(
      (
        await request(
          'POST',
          `/api/v1/trips/${methodTripId}/expenses`,
          'owner',
          {
            description: 'Fuel',
            category: 'TRANSPORT',
            amountPaise: 3000,
            paidByUserId: users.owner,
            splitMethod: 'EQUAL',
            participants: [{ userId: users.owner }, { userId: users.payer }],
          },
        )
      ).statusCode,
    ).toBe(201);
    const pay = (method?: unknown) =>
      request('POST', url, 'payer', {
        receiverId: users.owner,
        amountPaise: 500,
        ...(method !== undefined && { method }),
      });

    const withMethod = await pay('  UPI  ');
    expect(withMethod.statusCode).toBe(201);
    expect(withMethod.json().data.method).toBe('UPI');
    const paidId = withMethod.json().data.id as string;
    expect((await request('GET', url, 'owner')).json().data[0]).toMatchObject({
      id: paidId,
      method: 'UPI',
    });
    expect(
      (await request('GET', `${url}/me`, 'payer')).json().data[0].method,
    ).toBe('UPI');
    const confirmed = await request(
      'POST',
      `/api/v1/settlements/${paidId}/confirm`,
      'owner',
    );
    expect(confirmed.json().data).toMatchObject({
      status: 'CONFIRMED',
      method: 'UPI',
    });
    // Notifications keep their fixed wording; the method is not copied in.
    const notices = await database.notification.findMany({
      where: { sourceId: paidId },
    });
    expect(notices.length).toBeGreaterThan(0);
    expect(JSON.stringify(notices)).not.toContain('UPI');

    expect((await pay('x'.repeat(51))).statusCode).toBe(400);
    for (const method of ['UPI PIN 1234', '4111 1111 1111 1111']) {
      const refused = await pay(method);
      expect(refused.statusCode, method).toBe(400);
      expect(refused.json().error.code, method).toBe(
        'INVALID_SETTLEMENT_METHOD',
      );
    }
    expect(
      await database.settlement.count({ where: { tripId: methodTripId } }),
    ).toBe(1);

    // Three digits are allowed; blank, null or left out means not stated.
    for (const [method, stored] of [
      ['GPay 123', 'GPay 123'],
      ['   ', null],
      [null, null],
      [undefined, null],
    ] as const) {
      const recorded = await pay(method);
      expect(recorded.statusCode).toBe(201);
      expect(recorded.json().data.method).toBe(stored);
      expect(
        (
          await request(
            'POST',
            `/api/v1/settlements/${recorded.json().data.id}/cancel`,
            'payer',
          )
        ).json().data.method,
      ).toBe(stored);
    }

    const exported = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-export',
      headers: headers('payer'),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().activity.settlements).toContainEqual(
      expect.objectContaining({ id: paidId, method: 'UPI' }),
    );
  });
  it('discloses which shares of an equal split absorbed the leftover paise', async () => {
    // Its own trip of three, so the balances above are not involved.
    await database.trip.create({
      data: {
        id: roundingTripId,
        ownerId: users.owner,
        communityId,
        originCity: 'Pune',
        startDate: new Date('2026-10-10'),
        endDate: new Date('2026-10-12'),
        durationDays: 3,
        desiredGroupSize: 3,
        currentGroupSize: 3,
        description: 'Rounding disclosure test trip',
        status: 'FULL',
        publishedAt: new Date(),
        memberships: {
          create: [
            { userId: users.owner, role: 'OWNER' },
            { userId: users.memberA, role: 'MEMBER' },
            { userId: users.payer, role: 'MEMBER' },
          ],
        },
      },
    });
    const expensesUrl = `/api/v1/trips/${roundingTripId}/expenses`;
    const members = {
      owner: users.owner,
      memberA: users.memberA,
      payer: users.payer,
    };
    // Leftover paise go one each to participants in ascending ID order.
    const byId = Object.entries(members).sort(([, a], [, b]) =>
      a < b ? -1 : 1,
    );
    const expense = (amountPaise: number, extra: object = {}) => ({
      description: 'Taxi',
      category: 'TRANSPORT',
      amountPaise,
      paidByUserId: users.owner,
      splitMethod: 'EQUAL',
      participants: Object.values(members).map((userId) => ({ userId })),
      ...extra,
    });
    const roundingOf = (data: {
      shares: { user: { id: string }; roundingPaise: number }[];
    }) =>
      Object.fromEntries(
        data.shares.map((share) => [share.user.id, share.roundingPaise]),
      );
    const ownLine = async (role: string, expenseId: string) =>
      (await request('GET', `${expensesUrl}/me`, role))
        .json()
        .data.expenses.find((line: { id: string }) => line.id === expenseId);

    // ₹100 between three: ₹33.33 each and one leftover paisa.
    const created = await request(
      'POST',
      expensesUrl,
      'owner',
      expense(10_000),
    );
    expect(created.statusCode).toBe(201);
    const expenseId = created.json().data.id as string;
    expect(created.json().data.rounding).toEqual({
      remainderPaise: 1,
      baseSharePaise: 3333,
    });
    expect(roundingOf(created.json().data)).toEqual({
      [byId[0]![1]]: 1,
      [byId[1]![1]]: 0,
      [byId[2]![1]]: 0,
    });
    const listed = (await request('GET', expensesUrl, 'payer'))
      .json()
      .data.find((item: { id: string }) => item.id === expenseId);
    expect(listed.rounding).toEqual(created.json().data.rounding);
    expect(
      (await request('GET', `/api/v1/expenses/${expenseId}`, 'memberA')).json()
        .data.rounding,
    ).toEqual({ remainderPaise: 1, baseSharePaise: 3333 });

    // Each member's own view says only whether their share took a paisa.
    for (const [index, [role]] of byId.entries()) {
      const line = await ownLine(role, expenseId);
      expect(line).toMatchObject({
        ownSharePaise: index === 0 ? 3334 : 3333,
        ownRoundingPaise: index === 0 ? 1 : 0,
      });
      expect(line.rounding).toBeUndefined();
      expect(line.shares).toBeUndefined();
    }

    // Editing to ₹100.01 leaves two leftover paise for the first two.
    const edited = await request(
      'PUT',
      `/api/v1/expenses/${expenseId}`,
      'owner',
      expense(10_001, { expectedVersion: 1 }),
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data.rounding).toEqual({
      remainderPaise: 2,
      baseSharePaise: 3333,
    });
    expect(roundingOf(edited.json().data)).toEqual({
      [byId[0]![1]]: 1,
      [byId[1]![1]]: 1,
      [byId[2]![1]]: 0,
    });
    expect((await ownLine(byId[1]![0], expenseId)).ownRoundingPaise).toBe(1);

    // Even divisions and custom amounts have nothing to disclose.
    for (const body of [
      expense(9_000),
      expense(10_000, {
        splitMethod: 'CUSTOM',
        participants: [
          { userId: users.owner, amountPaise: 3_334 },
          { userId: users.memberA, amountPaise: 3_333 },
          { userId: users.payer, amountPaise: 3_333 },
        ],
      }),
    ]) {
      const response = await request('POST', expensesUrl, 'owner', body);
      expect(response.statusCode).toBe(201);
      expect(response.json().data.rounding).toBeNull();
      expect(
        response
          .json()
          .data.shares.every(
            (share: { roundingPaise: number }) => share.roundingPaise === 0,
          ),
      ).toBe(true);
      expect(
        (await ownLine('memberA', response.json().data.id)).ownRoundingPaise,
      ).toBe(0);
    }
  });
});
