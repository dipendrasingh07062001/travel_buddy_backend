import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';

const app = buildApp({ logger: false });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.$disconnect();
});

describe('PostgreSQL integration', () => {
  it('reports ready when the database is reachable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/readiness',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { database: 'up' },
    });
  });

  it('persists and reads the foundational account relationships', async () => {
    const identity = `integration-${randomUUID()}@example.com`;

    const user = await database.user.create({
      data: {
        displayName: 'Integration Test User',
        identities: {
          create: {
            type: 'EMAIL',
            normalizedValue: identity,
            verifiedAt: new Date(),
          },
        },
        policyAcceptances: {
          create: {
            policyType: 'TERMS',
            version: 'test-v1',
          },
        },
      },
      include: {
        identities: true,
        policyAcceptances: true,
      },
    });

    expect(user.identities[0]?.normalizedValue).toBe(identity);
    expect(user.policyAcceptances[0]?.policyType).toBe('TERMS');

    await database.$transaction([
      database.policyAcceptance.deleteMany({ where: { userId: user.id } }),
      database.user.delete({ where: { id: user.id } }),
    ]);
  });
});
