import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors/app-error.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
  VerifiedIdentity,
} from '../src/modules/auth/auth.types.js';

const activeUserId = '40000000-0000-4000-8000-000000000001';
const suspendedUserId = '40000000-0000-4000-8000-000000000002';
const users = new Map<string, AuthenticatedUser>([
  [
    'suspended-subject',
    {
      id: suspendedUserId,
      displayName: 'Suspended User',
      status: 'SUSPENDED',
      createdAt: new Date('2026-09-17T00:00:00.000Z'),
    },
  ],
]);

const identities: Record<string, VerifiedIdentity> = {
  'valid-token': {
    subject: 'firebase-user-1',
    displayName: 'Firebase User',
    email: 'user@example.com',
    emailVerified: true,
  },
  'unprovisioned-token': {
    subject: 'unprovisioned-subject',
    emailVerified: false,
  },
  'suspended-token': {
    subject: 'suspended-subject',
    emailVerified: false,
  },
};

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    if (token === 'expired-token') {
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        'The authentication token is invalid or expired.',
      );
    }
    const identity = identities[token];
    if (!identity) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    }
    return identity;
  },
};

const repository: AuthRepository = {
  async bootstrapFirebaseUser(identity) {
    const existing = users.get(identity.subject);
    if (existing) return { user: existing, created: false };

    const user: AuthenticatedUser = {
      id: activeUserId,
      displayName: identity.displayName ?? null,
      status: 'ACTIVE',
      createdAt: new Date('2026-09-17T00:00:00.000Z'),
    };
    users.set(identity.subject, user);
    return { user, created: true };
  },
  async findFirebaseUser(subject) {
    return users.get(subject) ?? null;
  },
};

const app = buildApp({
  logger: false,
  health: { checkReadiness: async () => undefined },
  auth: { tokenVerifier, repository },
});

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe('Firebase authentication HTTP contract', () => {
  it('rejects missing and malformed Bearer headers', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/v1/me' });
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Basic credentials' },
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    expect(missing.json().error.code).toBe('UNAUTHENTICATED');
    expect(malformed.statusCode).toBe(401);
  });

  it('rejects invalid or expired tokens', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer expired-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('creates the local account exactly once', async () => {
    const request = {
      method: 'POST' as const,
      url: '/api/v1/auth/bootstrap',
      headers: { authorization: 'Bearer valid-token' },
    };
    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      created: true,
      data: {
        id: activeUserId,
        displayName: 'Firebase User',
        status: 'ACTIVE',
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ created: false });
    expect(users.size).toBe(2);
  });

  it('returns only the safe local profile for an authenticated user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      id: activeUserId,
      displayName: 'Firebase User',
      status: 'ACTIVE',
      createdAt: '2026-09-17T00:00:00.000Z',
    });
    expect(response.json().data.email).toBeUndefined();
  });

  it('requires bootstrap before accessing authenticated resources', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer unprovisioned-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACCOUNT_NOT_PROVISIONED');
  });

  it('blocks suspended users', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer suspended-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACCOUNT_DISABLED');
  });
});
