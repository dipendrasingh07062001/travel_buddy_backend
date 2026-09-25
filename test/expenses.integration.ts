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
  Object.entries(users).map(([role]) => [
    role,
    `expense-${role}-${randomUUID()}`,
  ]),
);
const verifier: TokenVerifier = {
  async verify(token) {
    return { subject: subjects[token] ?? 'unknown', emailVerified: false };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier: verifier } });
const headers = (role: string) => ({ authorization: `Bearer ${role}` });
const url = `/api/v1/trips/${tripId}/expenses`;
const base = () => ({
  description: 'Shared hotel',
  category: 'ACCOMMODATION',
  amountPaise: 1001,
  paidByUserId: users.owner,
  splitMethod: 'EQUAL',
  participants: [users.memberB, users.owner, users.memberA].map((userId) => ({
    userId,
  })),
});

beforeAll(async () => {
  await app.ready();
  await database.community.create({
    data: {
      id: communityId,
      slug: `expense-${communityId}`,
      name: 'Expense Test Community',
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
      description: 'Expense integration test trip',
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

describe('private shared expense ledger', () => {
  let expenseId = '';

  it('requires authentication and active trip membership', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url });
    const outsider = await app.inject({
      method: 'GET',
      url,
      headers: headers('outsider'),
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(outsider.statusCode).toBe(404);
  });

  it('records an equal split and calculates balances to the paisa', async () => {
    const created = await app.inject({
      method: 'POST',
      url,
      headers: headers('owner'),
      payload: base(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      amountPaise: 1001,
      currency: 'INR',
      version: 1,
      status: 'ACTIVE',
    });
    expenseId = created.json().data.id;
    expect(
      created
        .json()
        .data.shares.map((share: { amountPaise: number }) => share.amountPaise)
        .sort((a: number, b: number) => a - b),
    ).toEqual([333, 334, 334]);

    const listed = await app.inject({
      method: 'GET',
      url,
      headers: headers('memberA'),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().pagination.total).toBe(1);
    const balances = await app.inject({
      method: 'GET',
      url: `${url}/balances`,
      headers: headers('memberB'),
    });
    expect(balances.statusCode).toBe(200);
    expect(balances.json().data.totalExpensePaise).toBe(1001);
    expect(
      balances
        .json()
        .data.balances.reduce(
          (sum: number, balance: { netPaise: number }) =>
            sum + balance.netPaise,
          0,
        ),
    ).toBe(0);
    const ownerShare = created
      .json()
      .data.shares.find(
        (share: { user: { id: string } }) => share.user.id === users.owner,
      ).amountPaise;
    expect(
      balances
        .json()
        .data.balances.find(
          (balance: { userId: string }) => balance.userId === users.owner,
        ).netPaise,
    ).toBe(1001 - ownerShare);
  });

  it('rejects incorrect splits and non-member participants', async () => {
    const mismatch = await app.inject({
      method: 'POST',
      url,
      headers: headers('owner'),
      payload: {
        ...base(),
        splitMethod: 'CUSTOM',
        participants: [{ userId: users.owner, amountPaise: 1000 }],
      },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('CUSTOM_SPLIT_TOTAL_MISMATCH');
    const outsider = await app.inject({
      method: 'POST',
      url,
      headers: headers('owner'),
      payload: {
        ...base(),
        participants: [{ userId: users.outsider }],
      },
    });
    expect(outsider.statusCode).toBe(400);
    expect(outsider.json().error.code).toBe('EXPENSE_MEMBER_INVALID');
  });

  it('only lets the creator edit or void and retains every revision', async () => {
    const changed = {
      ...base(),
      amountPaise: 1200,
      splitMethod: 'CUSTOM',
      participants: [
        { userId: users.owner, amountPaise: 200 },
        { userId: users.memberA, amountPaise: 500 },
        { userId: users.memberB, amountPaise: 500 },
      ],
      expectedVersion: 1,
    };
    const forbidden = await app.inject({
      method: 'PUT',
      url: `/api/v1/expenses/${expenseId}`,
      headers: headers('memberA'),
      payload: changed,
    });
    expect(forbidden.statusCode).toBe(404);
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/v1/expenses/${expenseId}`,
      headers: headers('owner'),
      payload: changed,
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data).toMatchObject({ version: 2, amountPaise: 1200 });
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/expenses/${expenseId}`,
      headers: headers('owner'),
      payload: changed,
    });
    expect(stale.statusCode).toBe(409);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/expenses/${expenseId}`,
      headers: headers('memberA'),
    });
    expect(
      detail
        .json()
        .data.revisions.map((revision: { action: string }) => revision.action),
    ).toEqual(['CREATE', 'EDIT']);

    const voided = await app.inject({
      method: 'DELETE',
      url: `/api/v1/expenses/${expenseId}`,
      headers: headers('owner'),
      payload: { expectedVersion: 2 },
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().data).toMatchObject({ version: 3, status: 'VOIDED' });
    const balances = await app.inject({
      method: 'GET',
      url: `${url}/balances`,
      headers: headers('memberB'),
    });
    expect(balances.json().data.totalExpensePaise).toBe(0);
    expect(await database.expenseRevision.count({ where: { expenseId } })).toBe(
      3,
    );
    expect(await database.expenseShare.count({ where: { expenseId } })).toBe(3);
  });

  it('keeps former members in balances while revoking their ledger access', async () => {
    const created = await app.inject({
      method: 'POST',
      url,
      headers: headers('owner'),
      payload: base(),
    });
    expect(created.statusCode).toBe(201);
    await database.tripMembership.update({
      where: { tripId_userId: { tripId, userId: users.memberB } },
      data: { status: 'LEFT', leftAt: new Date() },
    });
    const forbidden = await app.inject({
      method: 'GET',
      url: `${url}/balances`,
      headers: headers('memberB'),
    });
    expect(forbidden.statusCode).toBe(404);
    const balances = await app.inject({
      method: 'GET',
      url: `${url}/balances`,
      headers: headers('memberA'),
    });
    const formerShare = created
      .json()
      .data.shares.find(
        (share: { user: { id: string } }) => share.user.id === users.memberB,
      ).amountPaise;
    expect(
      balances
        .json()
        .data.balances.find(
          (balance: { userId: string }) => balance.userId === users.memberB,
        ),
    ).toMatchObject({ membershipStatus: 'LEFT', owedPaise: formerShare });
    const newCharge = await app.inject({
      method: 'POST',
      url,
      headers: headers('owner'),
      payload: base(),
    });
    expect(newCharge.statusCode).toBe(400);
    expect(newCharge.json().error.code).toBe('EXPENSE_MEMBER_INVALID');
  });

  it('makes completed trips read only while retaining their ledger', async () => {
    await database.trip.update({
      where: { id: tripId },
      data: { status: 'COMPLETED' },
    });
    const create = await app.inject({
      method: 'POST',
      url,
      headers: headers('owner'),
      payload: {
        ...base(),
        participants: [{ userId: users.owner }],
      },
    });
    expect(create.statusCode).toBe(409);
    const balances = await app.inject({
      method: 'GET',
      url: `${url}/balances`,
      headers: headers('owner'),
    });
    expect(balances.statusCode).toBe(200);
  });
});
