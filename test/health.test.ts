import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

const app = buildApp({
  logger: false,
  health: {
    checkReadiness: async () => undefined,
  },
});

const unreadyApp = buildApp({
  logger: false,
  health: {
    checkReadiness: async () => {
      throw new Error('Database unavailable');
    },
  },
});

beforeAll(async () => {
  await Promise.all([app.ready(), unreadyApp.ready()]);
});

afterAll(async () => {
  await Promise.all([app.close(), unreadyApp.close()]);
});

describe('system endpoints', () => {
  it('reports that the process is healthy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('reports that dependencies are ready', async () => {
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

  it('reports not ready when a dependency is unavailable', async () => {
    const response = await unreadyApp.inject({
      method: 'GET',
      url: '/api/v1/readiness',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      checks: { database: 'down' },
    });
  });

  it('uses the shared API error format for unknown routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
      },
    });
  });
});
