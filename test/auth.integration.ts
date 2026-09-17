import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const subject = `integration-firebase-${randomUUID()}`;
const email = `firebase-${randomUUID()}@example.com`;
let createdUserId: string | undefined;

const tokenVerifier: TokenVerifier = {
  async verify() {
    return {
      subject,
      displayName: 'Firebase Integration User',
      email,
      emailVerified: true,
    };
  },
};

const app = buildApp({
  logger: false,
  auth: { tokenVerifier },
});

beforeAll(async () => app.ready());

afterAll(async () => {
  await app.close();
  if (createdUserId) {
    await database.user.deleteMany({ where: { id: createdUserId } });
  }
  await database.$disconnect();
});

describe('Firebase account persistence', () => {
  it('creates one linked PostgreSQL user and returns it from /me', async () => {
    const headers = { authorization: 'Bearer integration-token' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers,
    });
    createdUserId = first.json().data?.id;
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers,
    });
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(me.statusCode).toBe(200);
    expect(second.json().data.id).toBe(createdUserId);
    expect(me.json().data.id).toBe(createdUserId);

    const account = await database.authAccount.findUnique({
      where: {
        provider_providerSubject: {
          provider: 'FIREBASE',
          providerSubject: subject,
        },
      },
      include: { user: { include: { identities: true } } },
    });

    expect(account?.user.id).toBe(createdUserId);
    expect(account?.user.identities).toHaveLength(1);
    expect(account?.user.identities[0]).toMatchObject({
      type: 'EMAIL',
      normalizedValue: email,
    });
  });
});
