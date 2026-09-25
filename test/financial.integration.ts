import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const communityId = randomUUID();
const tripId = randomUUID();
const users = {
  owner: randomUUID(),
  memberA: randomUUID(),
  memberB: randomUUID(),
  outsider: randomUUID(),
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
  await database.trip.deleteMany({ where: { id: tripId } });
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
});
