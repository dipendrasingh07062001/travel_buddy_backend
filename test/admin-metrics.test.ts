import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors/app-error.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import {
  metricWindow,
  summarizeMetricCounts,
} from '../src/modules/admin-metrics/admin-metrics.service.js';
import {
  accountMetricStatuses,
  connectionMetricStatuses,
  reportMetricStatuses,
  tripMetricStatuses,
  type AdminMetricsOverview,
  type AdminMetricsRepository,
  type MetricWindowDays,
} from '../src/modules/admin-metrics/admin-metrics.types.js';

const userId = '80000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-16T12:34:56.789Z');
let status: AuthenticatedUser['status'] = 'ACTIVE';
let failure: Error | null = null;
const calls: Array<{ userId: string; days: MetricWindowDays }> = [];
const tokenVerifier: TokenVerifier = {
  async verify(subject) {
    if (subject === 'invalid')
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    return { subject, emailVerified: false };
  },
};
const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    throw new Error('Unused');
  },
  async findFirebaseUser(subject) {
    return subject === 'unknown'
      ? null
      : {
          id: userId,
          displayName: 'Admin',
          status,
          birthDate: null,
          profile: null,
          createdAt: now,
        };
  },
};
const repository: AdminMetricsRepository = {
  async readOverview(id, days) {
    calls.push({ userId: id, days });
    if (failure) throw failure;
    // Deliberate extra fields check serialization allowlists at every level.
    const result = {
      generatedAt: now.toISOString(),
      window: { ...metricWindow(days, now), secret: 'PRIVATE' },
      accounts: {
        ...summarizeMetricCounts(accountMetricStatuses, [], 0),
        names: ['PRIVATE'],
      },
      trips: summarizeMetricCounts(tripMetricStatuses, [], 0),
      connectionRequests: summarizeMetricCounts(
        connectionMetricStatuses,
        [],
        0,
      ),
      reports: {
        ...summarizeMetricCounts(reportMetricStatuses, [], 0),
        open: 0,
      },
      identities: ['PRIVATE'],
    };
    return result;
  },
};
const options = {
  logger: false as const,
  auth: { tokenVerifier, repository: authRepository },
  adminMetrics: { repository },
};
const app = buildApp(options);
const read = (query = '', token = 'admin') =>
  app.inject({
    method: 'GET',
    url: `/api/v1/admin/metrics/overview${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
beforeAll(() => app.ready());
afterAll(() => app.close());
beforeEach(() => {
  status = 'ACTIVE';
  failure = null;
  calls.length = 0;
});

describe('admin metrics HTTP contract', () => {
  it('uses the authenticated account and defaults to a 30-day window', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ userId, days: 30 }]);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().data.window.days).toBe(30);
  });
  it.each([7, 30, 90])('accepts the %i-day window', async (days) => {
    expect((await read(`?days=${days}`)).statusCode).toBe(200);
    expect(calls[0]?.days).toBe(days);
  });
  it.each(['0', '-1', '1', '365', '7.5', 'all', '9999999999999999'])(
    'rejects unsupported days=%s before querying metrics',
    async (days) => {
      expect((await read(`?days=${days}`)).statusCode).toBe(400);
      expect(calls).toEqual([]);
    },
  );
  it('does not accept a caller-selected account or role', async () => {
    expect((await read('?userId=someone-else&role=ADMIN')).statusCode).toBe(
      200,
    );
    expect(calls).toEqual([{ userId, days: 30 }]);
  });
  it('requires authentication and a provisioned local account', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/admin/metrics/overview',
        })
      ).statusCode,
    ).toBe(401);
    expect((await read('', 'invalid')).statusCode).toBe(401);
    expect((await read('', 'unknown')).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
  it.each(['SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const)(
    'rejects %s accounts before querying metrics',
    async (value) => {
      status = value;
      expect((await read()).statusCode).toBe(403);
      expect(calls).toEqual([]);
    },
  );
  it('uses strict response allowlists and includes zero-valued statuses', async () => {
    const response = await read();
    const data = response.json().data as AdminMetricsOverview;
    expect(Object.keys(data)).toEqual([
      'generatedAt',
      'window',
      'accounts',
      'trips',
      'connectionRequests',
      'reports',
    ]);
    expect(data.accounts.byStatus).toEqual({
      ACTIVE: 0,
      SUSPENDED: 0,
      PENDING_DELETION: 0,
    });
    expect(data.reports).toMatchObject({
      total: 0,
      createdInWindow: 0,
      open: 0,
    });
    expect(response.body).not.toContain('PRIVATE');
  });
  it('returns repository authorization failures without leaking metrics', async () => {
    failure = new AppError(
      403,
      'ADMIN_ONLY',
      'Administrator access is required.',
    );
    const response = await read();
    expect(response.statusCode).toBe(403);
    expect(response.json().data).toBeUndefined();
  });
  it('redacts unexpected database failure details', async () => {
    failure = new Error('PRIVATE database details');
    const response = await read();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('PRIVATE');
  });
  it('limits polling to 30 requests per minute', async () => {
    const limited = buildApp(options);
    try {
      await limited.ready();
      for (let i = 0; i < 30; i += 1) {
        const response = await limited.inject({
          method: 'GET',
          url: '/api/v1/admin/metrics/overview',
          headers: { authorization: 'Bearer polling-admin' },
        });
        expect(response.statusCode).toBe(200);
      }
      const rejected = await limited.inject({
        method: 'GET',
        url: '/api/v1/admin/metrics/overview',
        headers: { authorization: 'Bearer polling-admin' },
      });
      expect(rejected.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('aggregate presentation and rolling UTC windows', () => {
  it('uses exactly N days, preserving time and milliseconds across month/year changes', () => {
    expect(metricWindow(7, new Date('2027-01-02T05:06:07.008Z'))).toEqual({
      days: 7,
      from: '2026-12-26T05:06:07.008Z',
      to: '2027-01-02T05:06:07.008Z',
    });
  });
  it('zero-fills status buckets and computes totals only from allowed buckets', () => {
    expect(
      summarizeMetricCounts(
        accountMetricStatuses,
        [
          { status: 'ACTIVE', _count: { _all: 4 } },
          { status: 'DELETED', _count: { _all: 8 } },
        ],
        2,
      ),
    ).toEqual({
      total: 4,
      byStatus: { ACTIVE: 4, SUSPENDED: 0, PENDING_DELETION: 0 },
      createdInWindow: 2,
    });
  });
});
