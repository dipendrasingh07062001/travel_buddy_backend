import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const ids = { alice: randomUUID(), bob: randomUUID(), admin: randomUUID() };
const subjects = {
  alice: `request-alice-${randomUUID()}`,
  bob: `request-bob-${randomUUID()}`,
  admin: `request-admin-${randomUUID()}`,
};
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: subjects[token as keyof typeof subjects] ?? token,
      emailVerified: false,
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const headers = (person: keyof typeof ids) => ({
  authorization: `Bearer ${person}`,
});
let aliceAccessId: string;
let bobAccessId: string;

beforeAll(async () => {
  for (const person of ['alice', 'bob', 'admin'] as const) {
    await database.user.create({
      data: {
        id: ids[person],
        displayName: person,
        staffRole: person === 'admin' ? 'ADMIN' : 'USER',
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subjects[person] },
        },
      },
    });
  }
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.accountDataRequest.deleteMany({
    where: { userId: { in: Object.values(ids) } },
  });
  await database.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await database.$disconnect();
});

describe('account data request intake', () => {
  it('validates the token and request type', async () => {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-requests',
      payload: { type: 'ACCESS' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const unprovisioned = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-requests',
      headers: { authorization: 'Bearer unknown' },
      payload: { type: 'ACCESS' },
    });
    expect(unprovisioned.statusCode).toBe(403);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-requests',
      headers: headers('alice'),
      payload: { type: 'OTHER', userId: ids.bob },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('creates one open request per type, including concurrent submissions', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-requests',
      headers: headers('alice'),
      payload: { type: 'ACCESS' },
    });
    expect(created.statusCode).toBe(201);
    aliceAccessId = created.json().data.id;
    expect(created.json().data).toMatchObject({
      userId: ids.alice,
      type: 'ACCESS',
      status: 'OPEN',
    });

    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-requests',
      headers: headers('alice'),
      payload: { type: 'ACCESS' },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().data.id).toBe(aliceAccessId);

    const simultaneous = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/me/data-requests',
          headers: headers('alice'),
          payload: { type: 'ACCOUNT_DELETION' },
        }),
      ),
    );
    expect(simultaneous.map((response) => response.statusCode).sort()).toEqual([
      200, 200, 201,
    ]);
    expect(
      new Set(simultaneous.map((response) => response.json().data.id)).size,
    ).toBe(1);
    const stillActive = await database.user.findUniqueOrThrow({
      where: { id: ids.alice },
      select: { status: true, deletedAt: true },
    });
    expect(stillActive).toEqual({ status: 'ACTIVE', deletedAt: null });

    const exportResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-export',
      headers: headers('alice'),
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.json().account.dataRequests).toHaveLength(2);
  });

  it('keeps user requests private and restricts the queue to admins', async () => {
    const bob = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-requests',
      headers: headers('bob'),
      payload: { type: 'ACCESS' },
    });
    bobAccessId = bob.json().data.id;

    const aliceList = await app.inject({
      method: 'GET',
      url: '/api/v1/me/data-requests',
      headers: headers('alice'),
    });
    expect(aliceList.statusCode).toBe(200);
    expect(aliceList.json().data).toHaveLength(2);
    expect(aliceList.body).not.toContain(bobAccessId);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/data-requests',
      headers: headers('alice'),
    });
    expect(forbidden.statusCode).toBe(403);

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/data-requests?status=OPEN&pageSize=2',
      headers: headers('admin'),
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().pagination.totalItems).toBe(3);
    expect(adminList.json().data).toHaveLength(2);
  });

  it('cancels only an owned request and permits a fresh request afterward', async () => {
    const otherUser = await app.inject({
      method: 'POST',
      url: `/api/v1/me/data-requests/${bobAccessId}/cancel`,
      headers: headers('alice'),
    });
    expect(otherUser.statusCode).toBe(404);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/me/data-requests/${aliceAccessId}/cancel`,
      headers: headers('alice'),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.status).toBe('CANCELLED');

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/me/data-requests/${aliceAccessId}/cancel`,
      headers: headers('alice'),
    });
    expect(repeated.json().data.id).toBe(aliceAccessId);

    const reopened = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-requests',
      headers: headers('alice'),
      payload: { type: 'ACCESS' },
    });
    expect(reopened.statusCode).toBe(201);
    expect(reopened.json().data.id).not.toBe(aliceAccessId);
  });

  it('works for suspended accounts and denies deleted accounts', async () => {
    await database.user.update({
      where: { id: ids.bob },
      data: { status: 'SUSPENDED' },
    });
    const suspended = await app.inject({
      method: 'GET',
      url: '/api/v1/me/data-requests',
      headers: headers('bob'),
    });
    expect(suspended.statusCode).toBe(200);

    await database.user.update({
      where: { id: ids.bob },
      data: { status: 'DELETED' },
    });
    const deleted = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-requests',
      headers: headers('bob'),
      payload: { type: 'ACCOUNT_DELETION' },
    });
    expect(deleted.statusCode).toBe(403);
  });
});
