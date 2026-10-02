import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import type { PolicyCatalog } from '../src/modules/policies/policy.service.js';

const users = { alice: randomUUID(), bob: randomUUID() };
const subjects = {
  alice: `policy-alice-${randomUUID()}`,
  bob: `policy-bob-${randomUUID()}`,
};
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: subjects[token as keyof typeof subjects] ?? token,
      emailVerified: false,
    };
  },
};
const currentCatalog = {
  TERMS: {
    version: '2026-10',
    url: 'https://example.org/travel-buddy/terms',
  },
  PRIVACY: {
    version: '2026-10',
    url: 'https://example.org/travel-buddy/privacy',
  },
  COMMUNITY_STANDARDS: {
    version: '2026-10',
    url: 'https://example.org/travel-buddy/community-standards',
  },
} satisfies NonNullable<PolicyCatalog>;
const updatedCatalog = {
  ...currentCatalog,
  TERMS: { ...currentCatalog.TERMS, version: '2027-01' },
} satisfies NonNullable<PolicyCatalog>;

const app = buildApp({
  logger: false,
  auth: { tokenVerifier },
  policyCatalog: currentCatalog,
});
const unconfiguredApp = buildApp({
  logger: false,
  auth: { tokenVerifier },
  policyCatalog: null,
});
const upgradedApp = buildApp({
  logger: false,
  auth: { tokenVerifier },
  policyCatalog: updatedCatalog,
});
const headers = (account: 'alice' | 'bob') => ({
  authorization: `Bearer ${account}`,
});

beforeAll(async () => {
  for (const account of ['alice', 'bob'] as const) {
    await database.user.create({
      data: {
        id: users[account],
        displayName: account,
        authAccounts: {
          create: {
            provider: 'FIREBASE',
            providerSubject: subjects[account],
          },
        },
      },
    });
  }
  await Promise.all([
    app.ready(),
    unconfiguredApp.ready(),
    upgradedApp.ready(),
  ]);
});

beforeEach(async () => {
  await database.policyAcceptance.deleteMany({
    where: { userId: { in: Object.values(users) } },
  });
});

afterAll(async () => {
  await Promise.all([
    app.close(),
    unconfiguredApp.close(),
    upgradedApp.close(),
  ]);
  await database.policyAcceptance.deleteMany({
    where: { userId: { in: Object.values(users) } },
  });
  await database.user.deleteMany({
    where: { id: { in: Object.values(users) } },
  });
  await database.$disconnect();
});

describe('versioned policy acceptance', () => {
  it('publishes only configured document links and fails closed without them', async () => {
    const configured = await app.inject({
      method: 'GET',
      url: '/api/v1/policies',
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({
      configured: true,
      data: [
        { policyType: 'TERMS', version: '2026-10' },
        { policyType: 'PRIVACY', version: '2026-10' },
        { policyType: 'COMMUNITY_STANDARDS', version: '2026-10' },
      ],
    });
    const unavailable = await unconfiguredApp.inject({
      method: 'GET',
      url: '/api/v1/policies',
    });
    expect(unavailable.json()).toEqual({ configured: false, data: [] });
    const rejected = await unconfiguredApp.inject({
      method: 'POST',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
      payload: {
        policyType: 'TERMS',
        version: '2026-10',
        accepted: true,
      },
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().error.code).toBe('POLICIES_UNAVAILABLE');
    expect(
      await database.policyAcceptance.count({
        where: { userId: users.alice },
      }),
    ).toBe(0);
  });

  it('requires authentication, a current version, and explicit acceptance', async () => {
    const guest = await app.inject({
      method: 'GET',
      url: '/api/v1/me/policy-acceptances',
    });
    expect(guest.statusCode).toBe(401);
    const declined = await app.inject({
      method: 'POST',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
      payload: {
        policyType: 'TERMS',
        version: '2026-10',
        accepted: false,
      },
    });
    expect(declined.statusCode).toBe(400);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
      payload: {
        policyType: 'TERMS',
        version: '2025-01',
        accepted: true,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('POLICY_VERSION_CHANGED');
    expect(
      await database.policyAcceptance.count({
        where: { userId: users.alice },
      }),
    ).toBe(0);
    const attemptedOtherUser = await app.inject({
      method: 'POST',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
      payload: {
        policyType: 'TERMS',
        version: '2026-10',
        accepted: true,
        userId: users.bob,
      },
    });
    expect(attemptedOtherUser.statusCode).toBe(200);
    expect(
      await database.policyAcceptance.count({
        where: { userId: users.alice },
      }),
    ).toBe(1);
    expect(
      await database.policyAcceptance.count({
        where: { userId: users.bob },
      }),
    ).toBe(0);
  });

  it('records only the caller’s acceptance, preserves its timestamp, and tracks new versions', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().data).toHaveLength(3);
    expect(before.json().data[0]).toMatchObject({
      policyType: 'TERMS',
      acceptedAt: null,
      needsAcceptance: true,
    });
    const payload = {
      policyType: 'TERMS',
      version: '2026-10',
      accepted: true,
    };
    const submissions = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/me/policy-acceptances',
          headers: headers('alice'),
          payload,
        }),
      ),
    );
    expect(submissions.map((submission) => submission.statusCode)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(
      new Set(
        submissions.map((submission) => submission.json().data.acceptedAt),
      ).size,
    ).toBe(1);
    expect(
      await database.policyAcceptance.count({
        where: { userId: users.alice },
      }),
    ).toBe(1);
    const alice = await app.inject({
      method: 'GET',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
    });
    const bob = await app.inject({
      method: 'GET',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('bob'),
    });
    expect(alice.json().data[0].needsAcceptance).toBe(false);
    expect(bob.json().data[0].needsAcceptance).toBe(true);
    for (const policyType of ['PRIVACY', 'COMMUNITY_STANDARDS'] as const) {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/me/policy-acceptances',
        headers: headers('alice'),
        payload: { policyType, version: '2026-10', accepted: true },
      });
      expect(accepted.statusCode).toBe(200);
    }
    const allCurrent = await app.inject({
      method: 'GET',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
    });
    expect(
      allCurrent.json().data.every(
        (policy: { needsAcceptance: boolean }) => !policy.needsAcceptance,
      ),
    ).toBe(true);

    const upgraded = await upgradedApp.inject({
      method: 'GET',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
    });
    expect(upgraded.json().data[0]).toMatchObject({
      version: '2027-01',
      acceptedAt: null,
      needsAcceptance: true,
    });
    const oldVersion = await upgradedApp.inject({
      method: 'POST',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
      payload,
    });
    expect(oldVersion.statusCode).toBe(409);
    const newVersion = await upgradedApp.inject({
      method: 'POST',
      url: '/api/v1/me/policy-acceptances',
      headers: headers('alice'),
      payload: { ...payload, version: '2027-01' },
    });
    expect(newVersion.statusCode).toBe(200);
    expect(
      await database.policyAcceptance.count({
        where: { userId: users.alice, policyType: 'TERMS' },
      }),
    ).toBe(2);
  });
});
