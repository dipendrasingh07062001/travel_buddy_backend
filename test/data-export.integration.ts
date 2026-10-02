import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const aliceId = randomUUID();
const bobId = randomUUID();
const communityId = randomUUID();
const aliceTripId = randomUUID();
const bobTripId = randomUUID();
const aliceSubject = `export-alice-${randomUUID()}`;
const bobSubject = `export-bob-${randomUUID()}`;
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject:
        token === 'alice' ? aliceSubject : token === 'bob' ? bobSubject : token,
      emailVerified: true,
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });

beforeAll(async () => {
  await database.user.create({
    data: {
      id: aliceId,
      displayName: 'Alice Export',
      profile: { create: { biography: 'Alice only biography' } },
      authAccounts: {
        create: { provider: 'FIREBASE', providerSubject: aliceSubject },
      },
      identities: {
        create: {
          type: 'EMAIL',
          normalizedValue: `alice-${randomUUID()}@example.com`,
        },
      },
      policyAcceptances: {
        create: {
          policyType: 'TERMS',
          version: 'test-v1',
          ipHash: 'internal-ip-hash',
        },
      },
    },
  });
  await database.user.create({
    data: {
      id: bobId,
      displayName: 'Bob Private',
      profile: { create: { biography: 'Bob secret biography' } },
      authAccounts: {
        create: { provider: 'FIREBASE', providerSubject: bobSubject },
      },
    },
  });
  await database.community.create({
    data: {
      id: communityId,
      slug: `export-${randomUUID()}`,
      name: 'Export Test',
    },
  });
  for (const [id, ownerId] of [
    [aliceTripId, aliceId],
    [bobTripId, bobId],
  ] as const) {
    await database.trip.create({
      data: {
        id,
        ownerId,
        communityId,
        originCity: 'Delhi',
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-01-03'),
        durationDays: 3,
        desiredGroupSize: 2,
        description: ownerId === aliceId ? 'Alice trip' : 'Bob secret trip',
      },
    });
  }
  await database.tripMembership.create({
    data: { tripId: aliceTripId, userId: aliceId, role: 'OWNER' },
  });
  await database.communityPost.create({
    data: {
      communityId,
      authorId: aliceId,
      type: 'EXPERIENCE',
      title: 'Alice post',
      body: 'Alice content',
    },
  });
  await database.communityPost.create({
    data: {
      communityId,
      authorId: bobId,
      type: 'EXPERIENCE',
      title: 'Bob private post',
      body: 'Bob secret content',
    },
  });
  await database.notification.create({
    data: {
      recipientId: aliceId,
      type: 'TRIP_UPDATED',
      eventKey: `export-${randomUUID()}`,
      sourceId: aliceTripId,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.notification.deleteMany({ where: { recipientId: aliceId } });
  await database.communityPost.deleteMany({ where: { communityId } });
  await database.tripMembership.deleteMany({ where: { tripId: aliceTripId } });
  await database.trip.deleteMany({ where: { communityId } });
  await database.community.delete({ where: { id: communityId } });
  await database.policyAcceptance.deleteMany({ where: { userId: aliceId } });
  await database.user.deleteMany({ where: { id: { in: [aliceId, bobId] } } });
  await database.$disconnect();
});

describe('account data export', () => {
  it('requires a verified account and never accepts a user id from the caller', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-export',
    });
    expect(missing.statusCode).toBe(401);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-export',
      headers: { authorization: 'Bearer unknown' },
    });
    expect(unknown.statusCode).toBe(403);
  });

  it('downloads only the caller data without internal policy metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-export',
      headers: { authorization: 'Bearer alice' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-disposition']).toContain(
      'attachment; filename=',
    );
    expect(response.json()).toMatchObject({
      formatVersion: 1,
      account: {
        id: aliceId,
        profile: { biography: 'Alice only biography' },
        policyAcceptances: [{ policyType: 'TERMS', version: 'test-v1' }],
      },
      activity: {
        trips: [{ id: aliceTripId }],
        memberships: [{ tripId: aliceTripId }],
        communityPosts: [{ title: 'Alice post' }],
        notifications: [{ sourceId: aliceTripId }],
      },
    });
    expect(response.body).not.toContain('Bob secret');
    expect(response.body).not.toContain(bobSubject);
    expect(response.body).not.toContain(bobTripId);
    expect(response.body).not.toContain('internal-ip-hash');
    expect(response.body).not.toContain('staffRole');
  });

  it('remains available to a suspended account but rejects a deleted account', async () => {
    await database.user.update({
      where: { id: aliceId },
      data: { status: 'SUSPENDED' },
    });
    const suspended = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-export',
      headers: { authorization: 'Bearer alice' },
    });
    expect(suspended.statusCode).toBe(200);

    await database.user.update({
      where: { id: aliceId },
      data: { status: 'DELETED' },
    });
    const deleted = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-export',
      headers: { authorization: 'Bearer alice' },
    });
    expect(deleted.statusCode).toBe(403);
    expect(deleted.json().error.code).toBe('ACCOUNT_DISABLED');
  });
});
