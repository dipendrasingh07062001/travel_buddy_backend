import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

// Schema checks run before the handler, so these requests never reach the
// database. Everything else is in the integration test.
const tokenVerifier: TokenVerifier = {
  async verify(subject) {
    return { subject, emailVerified: false };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const requestId = '80000000-0000-4000-8000-000000000003';
const note = 'Export emailed to the account owner.';

function complete(payload: object, id = requestId) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/admin/data-requests/${id}/complete`,
    headers: { authorization: 'Bearer admin' },
    payload,
  });
}

beforeAll(() => app.ready());
afterAll(() => app.close());

describe('data request completion schema', () => {
  it.each([
    ['a missing note', {}],
    ['a note under 10 characters', { note: 'too short' }],
    ['a note over 1000 characters', { note: 'x'.repeat(1001) }],
  ])('rejects %s', async (_name, payload) => {
    const response = await complete(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_ERROR' } });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects a request ID that is not a UUID', async () => {
    const response = await complete({ note }, 'not-a-uuid');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_ERROR' } });
  });

  it('rejects an unknown type filter on the list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/data-requests?type=EXPORT',
      headers: { authorization: 'Bearer admin' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_ERROR' } });
  });
});
