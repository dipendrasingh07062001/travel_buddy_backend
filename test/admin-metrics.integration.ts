import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { AppError } from '../src/errors/app-error.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { prismaAdminMetricsRepository } from '../src/modules/admin-metrics/admin-metrics.repository.js';
import {
  connectionMetricStatuses,
  reportMetricStatuses,
  tripMetricStatuses,
  type AdminMetricsOverview,
  type MetricWindowDays,
} from '../src/modules/admin-metrics/admin-metrics.types.js';

const run = randomUUID();
const roles = [
  'admin',
  'owner',
  'member',
  'moderator',
  'suspended',
  'pending',
  'deleted',
  'old',
  'future',
] as const;
type Role = (typeof roles)[number];
const ids = Object.fromEntries(
  roles.map((role) => [role, randomUUID()]),
) as Record<Role, string>;
const communityId = randomUUID();
const tripIds: string[] = [];
const baseline = {} as Record<MetricWindowDays, AdminMetricsOverview>;
const dayMs = 86_400_000;
let fixtureClock: Date;
const ago = (days: number) => new Date(fixtureClock.getTime() - days * dayMs);
const subject = (token: string) => `metrics-${run}-${token}`;
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    if (token === 'invalid')
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    return { subject: subject(token), emailVerified: false };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const read = (token: string = 'admin', query = '') =>
  app.inject({
    method: 'GET',
    url: `/api/v1/admin/metrics/overview${query}`,
    headers: { authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  await database.user.create({
    data: {
      id: ids.admin,
      displayName: 'METRICS_PRIVATE admin',
      staffRole: 'ADMIN',
      authAccounts: {
        create: { provider: 'FIREBASE', providerSubject: subject('admin') },
      },
    },
  });
  const [clock] = await database.$queryRaw<
    Array<{ now: Date }>
  >`SELECT CURRENT_TIMESTAMP AS now`;
  fixtureClock = clock!.now;
  for (const days of [7, 30, 90] as const)
    baseline[days] = await prismaAdminMetricsRepository.readOverview(
      ids.admin,
      days,
    );
  const ages: Record<Exclude<Role, 'admin'>, number> = {
    owner: 2,
    member: 12,
    moderator: 50,
    suspended: 1,
    pending: 1,
    deleted: 1,
    old: 120,
    future: -2,
  };
  for (const role of roles.filter(
    (value): value is Exclude<Role, 'admin'> => value !== 'admin',
  )) {
    await database.user.create({
      data: {
        id: ids[role],
        displayName: role === 'deleted' ? null : `METRICS_PRIVATE ${role}`,
        status:
          role === 'suspended'
            ? 'SUSPENDED'
            : role === 'pending'
              ? 'PENDING_DELETION'
              : role === 'deleted'
                ? 'DELETED'
                : 'ACTIVE',
        statusBeforeDeletion: role === 'pending' ? 'ACTIVE' : null,
        deletedAt: role === 'deleted' ? ago(1) : null,
        staffRole: role === 'moderator' ? 'MODERATOR' : 'USER',
        createdAt: ago(ages[role]),
        ...(role !== 'deleted' && {
          profile: { create: { biography: 'METRICS_PRIVATE biography' } },
        }),
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subject(role) },
        },
      },
    });
  }
  await database.authIdentity.create({
    data: {
      userId: ids.owner,
      type: 'EMAIL',
      normalizedValue: `private-${run}@example.invalid`,
    },
  });
  await database.community.create({
    data: {
      id: communityId,
      slug: `metrics-${run}`,
      name: 'METRICS_PRIVATE destination',
    },
  });
  const agesForTrips = [2, 12, 50, 120, 2, 2];
  for (const [index, status] of tripMetricStatuses.entries()) {
    const id = randomUUID();
    tripIds.push(id);
    await database.trip.create({
      data: {
        id,
        ownerId: status === 'CANCELLED' ? ids.deleted : ids.owner,
        communityId,
        originCity: 'Delhi',
        startDate: ago(-40),
        endDate: ago(-44),
        durationDays: 5,
        desiredGroupSize: 3,
        description: 'METRICS_PRIVATE trip description',
        status,
        publishedAt: status === 'DRAFT' ? null : ago(agesForTrips[index]!),
        moderationRemovedAt: status === 'DRAFT' ? ago(1) : null,
        createdAt: ago(agesForTrips[index]!),
      },
    });
  }
  const futureTripId = randomUUID();
  tripIds.push(futureTripId);
  await database.trip.create({
    data: {
      id: futureTripId,
      ownerId: ids.owner,
      communityId,
      originCity: 'Delhi',
      startDate: ago(-40),
      endDate: ago(-44),
      durationDays: 5,
      desiredGroupSize: 3,
      description: 'METRICS_PRIVATE future record',
      status: 'PUBLISHED',
      publishedAt: ago(-2),
      createdAt: ago(-2),
    },
  });
  const agesForRequests = [2, 12, 50, 120, -2];
  for (const [index, status] of connectionMetricStatuses.entries()) {
    await database.connectionRequest.create({
      data: {
        tripId: tripIds[index]!,
        requesterId: ids.member,
        recipientId: ids.owner,
        message: 'METRICS_PRIVATE connection message',
        status,
        createdAt: ago(agesForRequests[index]!),
      },
    });
  }
  const agesForReports = [2, 12, 50, 120];
  for (const [index, status] of reportMetricStatuses.entries()) {
    await database.report.create({
      data: {
        reporterId: ids.member,
        targetType: 'TRIP',
        reportedTripId: tripIds[index]!,
        reason: 'COMMERCIAL_TOUR_SPAM',
        details: 'METRICS_PRIVATE report details',
        status,
        reviewerId: status === 'SUBMITTED' ? null : ids.admin,
        reviewedAt: status === 'SUBMITTED' ? null : ago(1),
        resolvedAt: ['ACTIONED', 'DISMISSED'].includes(status) ? ago(1) : null,
        createdAt: ago(agesForReports[index]!),
      },
    });
  }
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await database.report.deleteMany({ where: { reporterId: ids.member } });
  await database.trip.deleteMany({ where: { id: { in: tripIds } } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await database.$disconnect();
});

describe('admin-only operational aggregates', () => {
  it('counts all retained trip/request/report statuses, excludes erased accounts, and sums the open report backlog', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    const metrics = response.json().data as AdminMetricsOverview;
    const base = baseline[30];
    expect(metrics.accounts.total - base.accounts.total).toBe(7);
    expect(
      metrics.accounts.byStatus.ACTIVE - base.accounts.byStatus.ACTIVE,
    ).toBe(5);
    expect(
      metrics.accounts.byStatus.SUSPENDED - base.accounts.byStatus.SUSPENDED,
    ).toBe(1);
    expect(
      metrics.accounts.byStatus.PENDING_DELETION -
        base.accounts.byStatus.PENDING_DELETION,
    ).toBe(1);
    expect(Object.keys(metrics.accounts.byStatus)).not.toContain('DELETED');
    expect(metrics.trips.total - base.trips.total).toBe(7);
    for (const status of tripMetricStatuses)
      expect(metrics.trips.byStatus[status] - base.trips.byStatus[status]).toBe(
        status === 'PUBLISHED' ? 2 : 1,
      );
    expect(
      metrics.connectionRequests.total - base.connectionRequests.total,
    ).toBe(5);
    for (const status of connectionMetricStatuses)
      expect(
        metrics.connectionRequests.byStatus[status] -
          base.connectionRequests.byStatus[status],
      ).toBe(1);
    expect(metrics.reports.total - base.reports.total).toBe(4);
    for (const status of reportMetricStatuses)
      expect(
        metrics.reports.byStatus[status] - base.reports.byStatus[status],
      ).toBe(1);
    expect(metrics.reports.open - base.reports.open).toBe(2);
    for (const counts of [
      metrics.accounts,
      metrics.trips,
      metrics.connectionRequests,
      metrics.reports,
    ])
      expect(counts.total).toBe(
        Object.values(counts.byStatus).reduce((sum, count) => sum + count, 0),
      );
  });

  it.each([
    { days: 7, accounts: 3, trips: 3, requests: 1, reports: 1 },
    { days: 30, accounts: 4, trips: 4, requests: 2, reports: 2 },
    { days: 90, accounts: 5, trips: 5, requests: 3, reports: 3 },
  ] as const)(
    'counts only creations in the $days-day window and excludes future dates',
    async (expected) => {
      const response = await read('admin', `?days=${expected.days}`);
      expect(response.statusCode).toBe(200);
      const metrics = response.json().data as AdminMetricsOverview;
      const base = baseline[expected.days];
      expect(
        metrics.accounts.createdInWindow - base.accounts.createdInWindow,
      ).toBe(expected.accounts);
      expect(metrics.trips.createdInWindow - base.trips.createdInWindow).toBe(
        expected.trips,
      );
      expect(
        metrics.connectionRequests.createdInWindow -
          base.connectionRequests.createdInWindow,
      ).toBe(expected.requests);
      expect(
        metrics.reports.createdInWindow - base.reports.createdInWindow,
      ).toBe(expected.reports);
      expect(metrics.window.days).toBe(expected.days);
      expect(metrics.generatedAt).toBe(metrics.window.to);
      expect(
        Date.parse(metrics.window.to) - Date.parse(metrics.window.from),
      ).toBe(expected.days * dayMs);
    },
  );

  it('does not disclose identities, content, destinations or database identifiers', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    for (const value of [
      'METRICS_PRIVATE',
      '@example.invalid',
      subject('admin'),
      communityId,
      ...tripIds,
      ...Object.values(ids),
    ])
      expect(response.body).not.toContain(value);
    expect(Object.keys(response.json().data)).toEqual([
      'generatedAt',
      'window',
      'accounts',
      'trips',
      'connectionRequests',
      'reports',
    ]);
  });

  it.each(['owner', 'member', 'moderator'] as const)(
    'rejects the non-admin %s regardless of caller-supplied role/id',
    async (role) => {
      const response = await read(role, `?role=ADMIN&userId=${ids.admin}`);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('ADMIN_ONLY');
      expect(response.json().data).toBeUndefined();
    },
  );

  it.each(['suspended', 'pending', 'deleted'] as const)(
    'rejects %s accounts',
    async (role) => {
      expect((await read(role)).statusCode).toBe(403);
    },
  );

  it('rejects guests, invalid tokens and unprovisioned accounts', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/admin/metrics/overview',
        })
      ).statusCode,
    ).toBe(401);
    expect((await read('invalid')).statusCode).toBe(401);
    expect((await read('unprovisioned')).statusCode).toBe(403);
  });

  it('honors role revocation on the very next request without using a cached response', async () => {
    expect((await read()).statusCode).toBe(200);
    try {
      await database.user.update({
        where: { id: ids.admin },
        data: { staffRole: 'MODERATOR' },
      });
      const response = await read();
      expect(response.statusCode).toBe(403);
      expect(response.json().data).toBeUndefined();
    } finally {
      await database.user.update({
        where: { id: ids.admin },
        data: { staffRole: 'ADMIN' },
      });
    }
  });

  it('does not update activity, create notifications or add audit records when metrics are read', async () => {
    const readState = async () => ({
      actor: await database.user.findUniqueOrThrow({
        where: { id: ids.admin },
        select: { updatedAt: true },
      }),
      notifications: await database.notification.count(),
      moderationActions: await database.moderationAction.count(),
      tripChanges: await database.tripChange.count(),
    });
    const before = await readState();
    expect((await read()).statusCode).toBe(200);
    expect(await readState()).toEqual(before);
  });
});
