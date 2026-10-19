import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { AppError } from '../src/errors/app-error.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const run = randomUUID();
const roles = ['member', 'admin'] as const;
type Role = (typeof roles)[number];
const ids = { member: randomUUID(), admin: randomUUID() };
const subject = (role: Role) => `freshness-${role}-${run}`;

// Simulates Firebase: fresh checks can be made to fail as if Firebase were
// unreachable or the login had been revoked; local checks always pass.
let firebase: 'ok' | 'unavailable' | 'revoked' = 'ok';
let checks: boolean[] = [];
const tokenVerifier: TokenVerifier = {
  async verify(token, options) {
    const fresh = options?.checkRevoked === true;
    checks.push(fresh);
    if (fresh && firebase === 'unavailable')
      throw new AppError(
        503,
        'AUTHENTICATION_UNAVAILABLE',
        'Authentication is temporarily unavailable.',
      );
    if (fresh && firebase === 'revoked')
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        'The authentication token is invalid or expired.',
      );
    return {
      subject: subject(token as Role),
      emailVerified: false,
      authTime: new Date(),
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
let accessRequestId = '';

interface Call {
  method: 'GET' | 'POST';
  url: string;
  role: Role;
  payload?: object;
}

const sensitive: Call[] = [
  { method: 'POST', url: '/auth/bootstrap', role: 'member' },
  {
    method: 'POST',
    url: '/me/data-requests',
    role: 'member',
    payload: { type: 'ACCESS' },
  },
  { method: 'POST', url: '/me/data-export', role: 'member' },
  { method: 'POST', url: '/me/verification-signals/refresh', role: 'member' },
  { method: 'GET', url: '/admin/reports', role: 'admin' },
  {
    method: 'POST',
    url: `/admin/reports/${randomUUID()}/start-review`,
    role: 'admin',
  },
  { method: 'GET', url: '/admin/communities', role: 'admin' },
  { method: 'GET', url: '/admin/metrics/overview', role: 'admin' },
  { method: 'GET', url: '/admin/data-requests', role: 'admin' },
];
const ordinary: Call[] = [
  { method: 'GET', url: '/me', role: 'member' },
  { method: 'GET', url: '/me/notifications', role: 'member' },
  { method: 'GET', url: '/me/data-requests', role: 'member' },
];

function call({ method, url, role, payload }: Call) {
  checks = [];
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${role}` },
    ...(payload && { payload }),
  });
}

const cancelCall = (): Call => ({
  method: 'POST',
  url: `/me/data-requests/${accessRequestId}/cancel`,
  role: 'member',
});

beforeAll(async () => {
  await app.ready();
  for (const role of roles)
    await database.user.create({
      data: {
        id: ids[role],
        displayName: `Freshness ${role}`,
        staffRole: role === 'admin' ? 'ADMIN' : 'USER',
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subject(role) },
        },
      },
    });
});

beforeEach(async () => {
  firebase = 'ok';
  await database.accountDataRequest.deleteMany({
    where: { userId: { in: Object.values(ids) } },
  });
  accessRequestId = (
    await database.accountDataRequest.create({
      data: { userId: ids.member, type: 'ACCESS' },
    })
  ).id;
  await database.user.update({
    where: { id: ids.member },
    data: { status: 'ACTIVE' },
  });
});

afterAll(async () => {
  await app.close();
  const userIds = Object.values(ids);
  await database.accountDataRequest.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.authIdentity.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
  await database.$disconnect();
});

describe('Firebase account checks (Option B)', () => {
  it('asks Firebase for the account state on every sensitive action', async () => {
    for (const route of [...sensitive, cancelCall()]) {
      const response = await call(route);
      expect(
        response.statusCode,
        `${route.url}: ${response.body}`,
      ).toBeLessThan(500);
      expect([401, 403]).not.toContain(response.statusCode);
      expect(checks, route.url).toContain(true);
    }
  });

  it('verifies ordinary requests locally without asking Firebase', async () => {
    for (const route of ordinary) {
      const response = await call(route);
      expect(response.statusCode, route.url).toBe(200);
      expect(checks, route.url).not.toContain(true);
    }
  });

  it('fails closed on sensitive actions when Firebase cannot be reached', async () => {
    firebase = 'unavailable';
    for (const route of [...sensitive, cancelCall()]) {
      const response = await call(route);
      expect(response.statusCode, route.url).toBe(503);
      expect(response.json().error.code).toBe('AUTHENTICATION_UNAVAILABLE');
    }
    for (const route of ordinary) {
      expect((await call(route)).statusCode, route.url).toBe(200);
    }
    expect(
      await database.accountDataRequest.findUniqueOrThrow({
        where: { id: accessRequestId },
        select: { status: true },
      }),
    ).toEqual({ status: 'OPEN' });
  });

  it('does not let a local check earlier in the request stand in for a fresh one', async () => {
    firebase = 'revoked';
    const response = await call(sensitive[2]!);
    expect(response.statusCode).toBe(401);
    // The rate limiter verified the same token locally first.
    expect(checks).toEqual([false, true]);
  });

  it('still applies a local suspension on ordinary requests', async () => {
    await database.user.update({
      where: { id: ids.member },
      data: { status: 'SUSPENDED' },
    });
    const response = await call(ordinary[0]!);
    expect(response.statusCode).toBe(403);
    expect(checks).not.toContain(true);
  });
});
