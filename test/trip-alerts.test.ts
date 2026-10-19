import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  Prisma,
  type Trip,
  type TripAlertSubscription,
} from '../src/generated/prisma/client.js';
import type {
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import { AppError } from '../src/errors/app-error.js';
import { matchesTripAlert } from '../src/modules/trip-alerts/trip-alert.matcher.js';
import { normalizeTripAlert } from '../src/modules/trip-alerts/trip-alert.service.js';
import type {
  TripAlertBody,
  TripAlertRepository,
} from '../src/modules/trip-alerts/trip-alert.types.js';

const id = 'a0000000-0000-4000-8000-000000000001';
const userId = 'a0000000-0000-4000-8000-000000000002';
const communityId = 'a0000000-0000-4000-8000-000000000003';
const now = new Date('2030-01-01T00:00:00.000Z');
const body: TripAlertBody = {
  name: 'Manali holiday',
  communityId,
  enabled: true,
};
const base: TripAlertSubscription = {
  id,
  userId,
  ...normalizeTripAlert(body),
  minBudget: null,
  maxBudget: null,
  version: 1,
  createdAt: now,
  updatedAt: now,
};
const trip: Trip = {
  id,
  ownerId: id,
  communityId,
  originCity: 'New Delhi',
  startDate: new Date('2030-02-10'),
  endDate: new Date('2030-02-15'),
  durationDays: 6,
  flexibilityDays: 0,
  currentGroupSize: 1,
  desiredGroupSize: 3,
  budgetMin: new Prisma.Decimal('12000.50'),
  budgetMax: new Prisma.Decimal('18000.25'),
  currency: 'INR',
  transport: 'BUS',
  description: 'Never copied to alerts',
  status: 'PUBLISHED',
  version: 1,
  publishedAt: now,
  moderationRemovedAt: null,
  createdAt: now,
  updatedAt: now,
};

describe('matching-trip criteria', () => {
  it.each([
    ['destination only', {}, true],
    ['different destination', { communityId: userId }, false],
    ['literal case-insensitive origin', { origin: 'delHI' }, true],
    ['different origin', { origin: 'Mumbai' }, false],
    ['percent is not a wildcard', { origin: '%' }, false],
    ['underscore is not a wildcard', { origin: '_' }, false],
    ['SQL characters are literal', { origin: "Delhi' OR 1=1" }, false],
    ['date overlap at end', { departureFrom: new Date('2030-02-15') }, true],
    ['date overlap at start', { departureTo: new Date('2030-02-10') }, true],
    [
      'date window after trip',
      { departureFrom: new Date('2030-02-16') },
      false,
    ],
    ['date window before trip', { departureTo: new Date('2030-02-09') }, false],
    [
      'inclusive minimum budget',
      { minBudget: new Prisma.Decimal('18000.25') },
      true,
    ],
    [
      'inclusive maximum budget',
      { maxBudget: new Prisma.Decimal('12000.50') },
      true,
    ],
    [
      'minimum budget mismatch',
      { minBudget: new Prisma.Decimal('18000.26') },
      false,
    ],
    [
      'maximum budget mismatch',
      { maxBudget: new Prisma.Decimal('12000.49') },
      false,
    ],
    ['inclusive duration', { minDuration: 6, maxDuration: 6 }, true],
    ['minimum duration mismatch', { minDuration: 7 }, false],
    ['maximum duration mismatch', { maxDuration: 5 }, false],
    ['transport matches', { transport: 'BUS' }, true],
    ['transport mismatch', { transport: 'TRAIN' }, false],
  ] as Array<[string, Partial<TripAlertSubscription>, boolean]>)(
    '%s',
    (_name, criteria, expected) => {
      expect(matchesTripAlert({ ...base, ...criteria }, trip)).toBe(expected);
    },
  );
  it('does not infer missing budget bounds or convert currencies', () => {
    expect(
      matchesTripAlert(
        { ...base, minBudget: new Prisma.Decimal(1) },
        { ...trip, budgetMax: null },
      ),
    ).toBe(false);
    expect(
      matchesTripAlert(
        { ...base, maxBudget: new Prisma.Decimal(20000) },
        { ...trip, budgetMin: null },
      ),
    ).toBe(false);
    expect(
      matchesTripAlert(base, { ...trip, budgetMin: null, budgetMax: null }),
    ).toBe(true);
    expect(matchesTripAlert(base, { ...trip, currency: 'USD' })).toBe(false);
  });
  it('normalizes strings, preserves zero, and clears omitted criteria', () => {
    expect(
      normalizeTripAlert({
        ...body,
        name: ' Holiday ',
        origin: ' Delhi ',
        minBudget: 0,
      }),
    ).toEqual({
      name: 'Holiday',
      communityId,
      enabled: true,
      origin: 'Delhi',
      minBudget: 0,
      maxBudget: null,
      departureFrom: null,
      departureTo: null,
      minDuration: null,
      maxDuration: null,
      transport: null,
    });
  });
});

let sequence = 0;
let disabled = false;
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
      displayName: null,
      birthDate: null,
      profile: null,
      createdAt: now,
    };
  },
};
const repository: TripAlertRepository = {
  async list(actor) {
    calls.push(['list', actor]);
    return [base];
  },
  async create(actor, input) {
    calls.push(['create', actor, input]);
    return base;
  },
  async replace(actor, alertId, version, input) {
    calls.push(['replace', actor, alertId, version, input]);
    return { ...base, version: 2, enabled: input.enabled };
  },
  async remove(actor, alertId) {
    calls.push(['remove', actor, alertId]);
  },
};
const app = buildApp({
  logger: false,
  auth: { repository: authRepository, tokenVerifier },
  tripAlerts: { repository },
});
beforeAll(() => app.ready());
afterAll(() => app.close());
beforeEach(() => {
  calls.length = 0;
  disabled = false;
});
function api(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  suffix = '',
  payload?: object,
  token = `actor-${sequence++}`,
) {
  return app.inject({
    method,
    url: `/api/v1/me/trip-alerts${suffix}`,
    ...(token && { headers: { authorization: `Bearer ${token}` } }),
    ...(payload && { payload }),
  });
}

describe('saved-alert HTTP contract', () => {
  it('lists only the authenticated account and excludes internal account IDs', async () => {
    const response = await api('GET');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().data[0]).toMatchObject({
      id,
      enabled: true,
      currency: 'INR',
      version: 1,
    });
    expect(response.json().data[0]).not.toHaveProperty('userId');
    expect(calls).toEqual([['list', userId]]);
  });
  it('creates a private alert with normalized filters', async () => {
    const response = await api('POST', '', {
      ...body,
      name: ' Holiday ',
      origin: ' Delhi ',
      minBudget: 12.34,
    });
    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([
      [
        'create',
        userId,
        {
          ...normalizeTripAlert(body),
          name: 'Holiday',
          origin: 'Delhi',
          minBudget: 12.34,
        },
      ],
    ]);
  });
  it.each([19.99, 1234.56, 0.29, 9999999999.99])(
    'accepts a budget with two decimal places: %s',
    async (minBudget) => {
      const response = await api('POST', '', { ...body, minBudget });
      expect(response.statusCode, response.body).toBe(201);
      expect(calls.at(-1)?.[2]).toMatchObject({ minBudget });
    },
  );
  it('rejects a budget with more than two decimal places', async () => {
    const response = await api('POST', '', { ...body, maxBudget: 19.999 });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_TRIP_ALERT_BUDGET');
  });
  it('fully replaces criteria and explicitly pauses an alert', async () => {
    const response = await api('PUT', `/${id}`, {
      ...body,
      enabled: false,
      expectedVersion: 1,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ version: 2, enabled: false });
    expect(calls).toEqual([
      [
        'replace',
        userId,
        id,
        1,
        { ...normalizeTripAlert(body), enabled: false },
      ],
    ]);
  });
  it('unsubscribes using only the authenticated owner ID', async () => {
    const response = await api('DELETE', `/${id}`);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(calls).toEqual([['remove', userId, id]]);
  });
  it.each(['', 'invalid', 'unknown'])(
    'requires valid bootstrapped authentication (%s)',
    async (token) => {
      expect((await api('POST', '', body, token)).statusCode).toBe(
        token === 'unknown' ? 403 : 401,
      );
      expect(calls).toEqual([]);
    },
  );
  it('rejects disabled accounts before repository access', async () => {
    disabled = true;
    expect((await api('GET')).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
  it.each([
    { enabled: undefined },
    { name: '   ' },
    { name: 'x'.repeat(81) },
    { origin: '   ' },
    { communityId: 'not-a-uuid' },
    { departureFrom: '2030-02-30' },
    { departureFrom: '0000-01-01' },
    { departureFrom: '2030-02-20', departureTo: '2030-02-10' },
    { minBudget: 200, maxBudget: 100 },
    { minBudget: -1 },
    { maxBudget: 10000000000 },
    { minBudget: 1.001 },
    { minDuration: 4, maxDuration: 3 },
    { maxDuration: 366 },
    { minDuration: 1.5 },
    { transport: 'SPACESHIP' },
  ])('rejects invalid criteria %j', async (change) => {
    expect((await api('POST', '', { ...body, ...change })).statusCode).toBe(
      400,
    );
    expect(calls).toEqual([]);
  });
  it('requires a version for replacement and validates path UUIDs', async () => {
    expect((await api('PUT', `/${id}`, body)).statusCode).toBe(400);
    expect((await api('DELETE', '/invalid')).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});
