import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import type { StaffRoleRepository } from '../src/modules/staff-roles/staff-role.types.js';

// Schema checks run before the handler, so these requests never reach
// authentication or the database. Everything else is in the integration test.
const calls: unknown[] = [];
const repository: StaffRoleRepository = {
  async change(input) {
    calls.push(input);
    throw new Error('Unused');
  },
};
const tokenVerifier: TokenVerifier = {
  async verify(subject) {
    return { subject, emailVerified: false };
  },
};
const app = buildApp({
  logger: false,
  auth: { tokenVerifier },
  staffRoles: { repository },
});
const userId = '80000000-0000-4000-8000-000000000002';
const reason = 'Trusted volunteer for the Goa community.';

function change(payload: object, id = userId) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/admin/users/${id}/staff-role`,
    headers: { authorization: 'Bearer admin' },
    payload,
  });
}

beforeAll(() => app.ready());
afterAll(() => app.close());

describe('staff role route schema', () => {
  it.each([
    ['ADMIN as the role', { role: 'ADMIN', reason }],
    ['an unknown role', { role: 'OWNER', reason }],
    ['a missing role', { reason }],
    ['a missing reason', { role: 'MODERATOR' }],
    [
      'a reason under 10 characters',
      { role: 'MODERATOR', reason: 'too short' },
    ],
  ])('rejects %s', async (_name, payload) => {
    const response = await change(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_ERROR' } });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects a user ID that is not a UUID', async () => {
    const response = await change({ role: 'MODERATOR', reason }, 'not-a-uuid');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_ERROR' } });
  });

  it('never reaches the repository for invalid requests', () => {
    expect(calls).toEqual([]);
  });
});
