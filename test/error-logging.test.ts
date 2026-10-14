import { Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

interface LogLine {
  level: number;
  msg: string;
  statusCode?: number;
  code?: string;
  err?: { message?: string; stack?: string };
}

const lines: LogLine[] = [];
const stream = new Writable({
  write(chunk, _encoding, callback) {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      lines.push(JSON.parse(line) as LogLine);
    }
    callback();
  },
});

const app = buildApp({
  logger: { level: 'info', stream },
  health: {
    checkReadiness: async () => {
      throw new Error('Database unavailable');
    },
  },
  trips: {
    repository: {
      async listPublic() {
        throw new Error('Trip query exploded');
      },
      async findPublicById() {
        return null;
      },
    },
  },
});

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe('error logging', () => {
  it('logs the message and stack of an unexpected error but hides it from the client', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/trips' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('Trip query exploded');
    const logged = lines.find((line) => line.msg === 'Request failed');
    expect(logged?.level).toBe(50);
    expect(logged?.err?.message).toBe('Trip query exploded');
    expect(logged?.err?.stack).toContain('Trip query exploded');
  });

  it('logs client errors at info level without a stack', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/trips?pageSize=1000',
    });

    expect(response.statusCode).toBe(400);
    const logged = lines.find((line) => line.msg === 'Request rejected');
    expect(logged).toMatchObject({ level: 30, statusCode: 400 });
    expect(logged?.err).toBeUndefined();
  });

  it('logs why the readiness check failed', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/readiness' });

    const logged = lines.find((line) => line.msg === 'Readiness check failed');
    expect(logged?.err?.message).toBe('Database unavailable');
  });
});
