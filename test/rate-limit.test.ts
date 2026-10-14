import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors/app-error.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const globalLimit = 100;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    if (token === 'invalid-token') {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    }
    return { subject: token, emailVerified: false };
  },
};

function createApp(trustProxy?: (address: string, hop: number) => boolean) {
  return buildApp({
    logger: false,
    ...(trustProxy && { trustProxy }),
    health: { checkReadiness: async () => undefined },
    auth: { tokenVerifier },
  });
}

async function exhaust(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
) {
  for (let index = 0; index < globalLimit; index += 1) {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers,
    });
    expect(response.statusCode).toBe(200);
  }
  const limited = await app.inject({
    method: 'GET',
    url: '/api/v1/health',
    headers,
  });
  expect(limited.statusCode).toBe(429);
}

describe('rate limiting', () => {
  it('keeps separate limits for accounts that share one IP address', async () => {
    const app = createApp();
    try {
      await exhaust(app, { authorization: 'Bearer alice-token' });

      const otherAccount = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { authorization: 'Bearer bob-token' },
      });
      const anonymous = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      expect(otherAccount.statusCode).toBe(200);
      expect(anonymous.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('limits an invalid token by address instead of by its claimed account', async () => {
    const app = createApp();
    try {
      await exhaust(app, { authorization: 'Bearer invalid-token' });

      const anonymous = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      const validAccount = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { authorization: 'Bearer alice-token' },
      });
      expect(anonymous.statusCode).toBe(429);
      expect(validAccount.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('uses the forwarded client address behind a trusted proxy', async () => {
    const app = createApp((_address, hop) => hop < 1);
    try {
      await exhaust(app, { 'x-forwarded-for': '203.0.113.10' });

      const otherClient = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { 'x-forwarded-for': '203.0.113.11' },
      });
      expect(otherClient.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
