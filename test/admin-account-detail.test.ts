import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors/app-error.js';
import type { AdminUserRepository } from '../src/modules/admin-users/admin-users.types.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

// Schema checks run before the handler, so these requests never reach the
// database. Everything else is in the integration test.
const calls: unknown[] = [];
const repository: AdminUserRepository = {
  async search(input) {
    calls.push(input);
    throw new Error('Unused');
  },
  async lookup(input) {
    calls.push(input);
    throw new Error('Unused');
  },
  async detail(input) {
    calls.push(input);
    throw new Error('Unused');
  },
};
const tokenVerifier: TokenVerifier = {
  async verify(subject) {
    if (subject === 'invalid') {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    }
    return { subject, emailVerified: false };
  },
};
const app = buildApp({
  logger: false,
  auth: { tokenVerifier },
  adminUsers: { repository },
});
const userId = '80000000-0000-4000-8000-000000000004';

function get(url: string, token = 'admin') {
  return app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(() => app.ready());
afterAll(() => app.close());

describe('account detail and filter schemas', () => {
  it.each([
    ['a non-UUID account ID on the detail', '/admin/users/not-a-uuid'],
    ['a non-UUID userId on the report list', '/admin/reports?userId=abc'],
    [
      'targetId without targetType',
      `/admin/moderation-actions?targetId=${userId}`,
    ],
    [
      'targetType without targetId',
      '/admin/moderation-actions?targetType=USER',
    ],
    [
      'an unknown targetType',
      `/admin/moderation-actions?targetType=EXPENSE&targetId=${userId}`,
    ],
    [
      'a non-UUID targetId',
      '/admin/moderation-actions?targetType=USER&targetId=abc',
    ],
  ])('rejects %s', async (_name, url) => {
    const response = await get(url);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_ERROR' } });
  });

  it('sends no-store with a 401 on the detail', async () => {
    const response = await get(`/admin/users/${userId}`, 'invalid');
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('never reaches the repository for these requests', () => {
    expect(calls).toEqual([]);
  });
});
