import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

type App = ReturnType<typeof createApp>;

// Each block gets its own app, so each test has a fresh rate-limit store.
// Startup runs under the hook timeout, not the test's 5 s budget.
function startApp(trustProxy?: (address: string, hop: number) => boolean) {
  let app: App | undefined;
  beforeAll(async () => {
    app = createApp(trustProxy);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  return () => {
    if (!app) throw new Error('The test app did not start.');
    return app;
  };
}

async function exhaust(app: App, headers: Record<string, string>) {
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
  describe('accounts sharing an address', () => {
    const app = startApp();

    it('keeps separate limits for accounts that share one IP address', async () => {
      await exhaust(app(), { authorization: 'Bearer alice-token' });

      const otherAccount = await app().inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { authorization: 'Bearer bob-token' },
      });
      const anonymous = await app().inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      expect(otherAccount.statusCode).toBe(200);
      expect(anonymous.statusCode).toBe(200);
    });
  });

  describe('invalid tokens', () => {
    const app = startApp();

    it('limits an invalid token by address instead of by its claimed account', async () => {
      await exhaust(app(), { authorization: 'Bearer invalid-token' });

      const anonymous = await app().inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      const validAccount = await app().inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { authorization: 'Bearer alice-token' },
      });
      expect(anonymous.statusCode).toBe(429);
      expect(validAccount.statusCode).toBe(200);
    });
  });

  describe('trusted proxy', () => {
    const app = startApp((_address, hop) => hop < 1);

    it('uses the forwarded client address behind a trusted proxy', async () => {
      await exhaust(app(), { 'x-forwarded-for': '203.0.113.10' });

      const otherClient = await app().inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { 'x-forwarded-for': '203.0.113.11' },
      });
      expect(otherClient.statusCode).toBe(200);
    });
  });
});
