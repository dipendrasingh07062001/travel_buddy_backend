import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors/app-error.js';
import type {
  EmailCategory,
  EmailPreference,
  NotificationType,
} from '../src/generated/prisma/client.js';
import type {
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import { configuredEmailSender } from '../src/modules/email/email.configuration.js';
import { startEmailDelivery } from '../src/modules/email/email-delivery.js';
import { emailCategory } from '../src/modules/email/email-policy.js';
import type { EmailPreferenceRepository } from '../src/modules/email/email.types.js';

const userId = 'b0000000-0000-4000-8000-000000000001';
const now = new Date('2030-01-01T00:00:00.000Z');
let record: EmailPreference | null = null;
let disabled = false;
let sequence = 0;
const calls: unknown[][] = [];
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    if (token === 'invalid')
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    return { subject: token, emailVerified: false };
  },
};
const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    throw new Error('Unused');
  },
  async findFirebaseUser(subject) {
    if (subject === 'unknown') return null;
    return {
      id: userId,
      status: disabled ? 'SUSPENDED' : 'ACTIVE',
      profile: null,
      displayName: null,
      birthDate: null,
      createdAt: now,
    };
  },
};
const repository: EmailPreferenceRepository = {
  async find(id) {
    calls.push(['find', id]);
    return record;
  },
  async update(id, version, patch) {
    calls.push(['update', id, version, patch]);
    return {
      userId,
      connections: false,
      trips: false,
      finances: false,
      safety: false,
      version: version + 1,
      updatedAt: now,
      ...patch,
    };
  },
};
const app = buildApp({
  logger: false,
  auth: { tokenVerifier, repository: authRepository },
  emailPreferences: { repository },
});
beforeAll(() => app.ready());
afterAll(() => app.close());
beforeEach(() => {
  record = null;
  disabled = false;
  calls.length = 0;
});
function api(
  method: 'GET' | 'PATCH',
  payload?: object,
  token = `actor-${sequence++}`,
) {
  return app.inject({
    method,
    url: '/api/v1/me/email-preferences',
    ...(token && { headers: { authorization: `Bearer ${token}` } }),
    ...(payload && { payload }),
  });
}

describe('safe email configuration and allowlist', () => {
  it('has no real sender configured', () => {
    expect(configuredEmailSender()).toBeNull();
  });
  const expected: Record<NotificationType, EmailCategory | null> = {
    CONNECTION_REQUEST_RECEIVED: 'CONNECTIONS',
    CONNECTION_REQUEST_ACCEPTED: 'CONNECTIONS',
    CONNECTION_REQUEST_DECLINED: 'CONNECTIONS',
    CONNECTION_REQUEST_WITHDRAWN: 'CONNECTIONS',
    TRIP_UPDATED: 'TRIPS',
    TRIP_STATUS_CHANGED: 'TRIPS',
    EXPENSE_CREATED: 'FINANCES',
    EXPENSE_UPDATED: 'FINANCES',
    EXPENSE_VOIDED: 'FINANCES',
    SETTLEMENT_PENDING: 'FINANCES',
    SETTLEMENT_CONFIRMED: 'FINANCES',
    SETTLEMENT_REJECTED: 'FINANCES',
    SETTLEMENT_CANCELLED: 'FINANCES',
    PROFILE_PHOTO_REMOVED: 'SAFETY',
    TRIP_REMOVED: 'SAFETY',
    COMMUNITY_POST_REMOVED: 'SAFETY',
    COMMUNITY_COMMENT_REMOVED: 'SAFETY',
    MESSAGE_REMOVED: 'SAFETY',
    ACCOUNT_SUSPENDED: 'SAFETY',
    ACCOUNT_RESTORED: 'SAFETY',
    FEATURE_RESTRICTED: 'SAFETY',
    FEATURE_RESTRICTION_LIFTED: 'SAFETY',
    MESSAGE_RECEIVED: null,
    MATCHING_TRIP_PUBLISHED: null,
  };
  it.each(Object.entries(expected))(
    'routes %s only to its explicit category',
    (type, category) => {
      expect(emailCategory(type as NotificationType)).toBe(category);
    },
  );
  it('can stop before its first tick without contacting a sender or resolver', async () => {
    const send = vi.fn();
    const resolve = vi.fn();
    const worker = startEmailDelivery(
      { sender: { send }, recipients: { resolve } },
      app.log,
    );
    await worker.stop();
    expect(send).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('email preferences HTTP contract', () => {
  it('returns private, all-off defaults and exposes that delivery is unconfigured', async () => {
    const response = await api('GET');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({
      data: {
        connections: false,
        trips: false,
        finances: false,
        safety: false,
        version: 0,
        updatedAt: null,
        deliveryConfigured: false,
      },
    });
    expect(calls).toEqual([['find', userId]]);
  });
  it('changes only explicitly supplied categories using the authenticated account', async () => {
    const response = await api('PATCH', { expectedVersion: 0, trips: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      trips: true,
      connections: false,
      version: 1,
      deliveryConfigured: false,
    });
    expect(response.json().data).not.toHaveProperty('userId');
    expect(calls).toEqual([['update', userId, 0, { trips: true }]]);
  });
  it('does not accept a delivery address or another account as writable fields', async () => {
    const response = await api('PATCH', {
      expectedVersion: 1,
      trips: false,
      email: 'attacker@example.test',
      userId: 'other-user',
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([['update', userId, 1, { trips: false }]]);
  });
  it.each([
    {},
    { expectedVersion: 0 },
    { expectedVersion: -1, trips: true },
    { expectedVersion: 1.5, trips: true },
    { expectedVersion: 2147483647, trips: true },
    { expectedVersion: 0, trips: 'maybe' },
    { expectedVersion: 0, connections: {} },
    { expectedVersion: 0, email: 'not-a-supported-setting@example.test' },
  ])('rejects malformed or empty updates %j', async (payload) => {
    expect((await api('PATCH', payload)).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
  it.each(['', 'invalid', 'unknown'])(
    'requires authenticated bootstrapped users (%s)',
    async (token) => {
      expect((await api('GET', undefined, token)).statusCode).toBe(
        token === 'unknown' ? 403 : 401,
      );
      expect(calls).toEqual([]);
    },
  );
  it('rejects disabled users before loading preferences', async () => {
    disabled = true;
    expect((await api('GET')).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
  it('does not provide an arbitrary-address send endpoint', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/me/send-email',
          payload: { to: 'other@example.test' },
        })
      ).statusCode,
    ).toBe(404);
  });
});
