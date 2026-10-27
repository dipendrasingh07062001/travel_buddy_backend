import { randomUUID } from 'node:crypto';
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
import { database } from '../src/database/client.js';
import { AppError } from '../src/errors/app-error.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { processAccountErasures } from '../src/modules/account-deletion/account-erasure.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { createAccountDataExport } from '../src/modules/data-export/data-export.repository.js';
import * as notificationRepository from '../src/modules/notifications/notification.repository.js';
import { prismaTripAlertRepository } from '../src/modules/trip-alerts/trip-alert.repository.js';
import { normalizeTripAlert } from '../src/modules/trip-alerts/trip-alert.service.js';
import {
  lockOwnerAlertBudget,
  lockRecipientAlertLimits,
} from '../src/modules/trip-alerts/trip-alert.limits.js';
import { processTripAlertBatch } from '../src/modules/trip-alerts/trip-alert.worker.js';
import { utcStartOfToday } from '../src/modules/trips/trip.types.js';

const run = randomUUID();
const roles = [
  'owner',
  'alice',
  'bob',
  'member',
  'blocked',
  'suspended',
  'pending',
  'deleted',
] as const;
type Role = (typeof roles)[number];
const ids = Object.fromEntries(
  roles.map((role) => [role, randomUUID()]),
) as Record<Role, string>;
const userIds = Object.values(ids);
const communityId = randomUUID();
const otherCommunityId = randomUUID();
const tripIds: string[] = [];
const today = utcStartOfToday();
const date = (offset: number) =>
  new Date(today.getTime() + offset * 86_400_000);
const subject = (role: string) => `alerts-${run}-${role}`;
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    if (!(roles as readonly string[]).includes(token))
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    return {
      subject: subject(token),
      emailVerified: false,
      authTime: new Date(),
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
function api(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  actor: Role = 'alice',
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${actor}` },
    ...(payload && { payload }),
  });
}
const input = () =>
  normalizeTripAlert({
    name: 'My private Manali search',
    communityId,
    enabled: true,
  });
async function subscribe(
  role: Role = 'alice',
  extra: Partial<Prisma.TripAlertSubscriptionUncheckedCreateInput> = {},
) {
  const before = new Date(Date.now() - 60_000);
  return database.tripAlertSubscription.create({
    data: {
      userId: ids[role],
      ...input(),
      createdAt: before,
      updatedAt: before,
      ...extra,
    },
  });
}
async function createTrip(
  extra: Partial<Prisma.TripUncheckedCreateInput> = {},
) {
  const row = await database.trip.create({
    data: {
      ownerId: ids.owner,
      communityId,
      originCity: 'New Delhi',
      startDate: date(30),
      endDate: date(35),
      durationDays: 6,
      budgetMin: '12000.50',
      budgetMax: '18000.25',
      transport: 'BUS',
      desiredGroupSize: 4,
      description: 'Private description not copied into alerts.',
      memberships: { create: { userId: ids.owner, role: 'OWNER' } },
      ...extra,
    },
  });
  tripIds.push(row.id);
  return row;
}
async function publish(extra: Partial<Prisma.TripUncheckedCreateInput> = {}) {
  const trip = await createTrip(extra);
  const response = await api('POST', `/trips/${trip.id}/publish`, 'owner', {
    expectedVersion: 1,
    confirmsPersonalPlan: true,
  });
  expect(response.statusCode, response.body).toBe(200);
  return trip;
}
async function drain(batchSize = 100, now = new Date()) {
  const results = [];
  for (let i = 0; i < 100; i++) {
    const result = await processTripAlertBatch({ now, batchSize });
    if (!result.tripId) return results;
    results.push(result);
  }
  throw new Error('Alert queue did not drain in bounded test iterations.');
}
async function matchingNotifications(role: Role = 'alice') {
  return database.notification.findMany({
    where: { recipientId: ids[role], type: 'MATCHING_TRIP_PUBLISHED' },
  });
}
async function clearFixtures() {
  vi.restoreAllMocks();
  await database.accountCleanupTask.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.accountDataRequest.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.notification.deleteMany({
    where: { recipientId: { in: userIds } },
  });
  await database.trip.deleteMany({ where: { id: { in: tripIds } } });
  tripIds.length = 0;
  await database.tripAlertSubscription.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.userBlock.deleteMany({
    where: { blockerId: { in: userIds } },
  });
}
beforeAll(async () => {
  await app.ready();
  await database.community.createMany({
    data: [
      { id: communityId, slug: `alerts-${run}`, name: 'Manali Alerts' },
      {
        id: otherCommunityId,
        slug: `alerts-other-${run}`,
        name: 'Other Destination',
      },
    ],
  });
  for (const role of roles)
    await database.user.create({
      data: {
        id: ids[role],
        displayName: `Alert ${role}`,
        birthDate: new Date('1995-01-01'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Complete profile for trip publishing.',
            languages: ['english'],
          },
        },
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subject(role) },
        },
      },
    });
});
beforeEach(async () => {
  await clearFixtures();
  await database.community.updateMany({
    where: { id: { in: [communityId, otherCommunityId] } },
    data: { status: 'ACTIVE' },
  });
  await database.user.updateMany({
    where: { id: { in: userIds } },
    data: { status: 'ACTIVE', deletedAt: null, statusBeforeDeletion: null },
  });
});
afterAll(async () => {
  await app.close();
  await clearFixtures();
  await database.user.deleteMany({ where: { id: { in: userIds } } });
  await database.community.deleteMany({
    where: { id: { in: [communityId, otherCommunityId] } },
  });
  await database.$disconnect();
});

describe('private saved trip alerts', () => {
  it("creates, lists, replaces, pauses and deletes only the owner's saved preferences", async () => {
    const created = await api('POST', '/me/trip-alerts', 'alice', {
      name: ' Manali holiday ',
      communityId,
      enabled: true,
      origin: ' Delhi ',
      minBudget: 10000.01,
      maxBudget: 20000,
      transport: 'BUS',
      departureFrom: date(30).toISOString().slice(0, 10),
      departureTo: date(40).toISOString().slice(0, 10),
    });
    expect(created.statusCode, created.body).toBe(201);
    const saved = created.json().data;
    expect(saved).toMatchObject({
      name: 'Manali holiday',
      minBudget: '10000.01',
      currency: 'INR',
      origin: 'Delhi',
      version: 1,
    });
    expect(saved).not.toHaveProperty('userId');
    expect((await api('GET', '/me/trip-alerts', 'bob')).json().data).toEqual(
      [],
    );
    const list = await api('GET', '/me/trip-alerts');
    expect(list.headers['cache-control']).toBe('private, no-store');
    expect(list.json().data).toHaveLength(1);
    for (const method of ['PUT', 'DELETE'] as const) {
      const response = await api(
        method,
        `/me/trip-alerts/${saved.id}`,
        'bob',
        method === 'PUT'
          ? { name: 'Steal', communityId, enabled: false, expectedVersion: 1 }
          : undefined,
      );
      expect(response.statusCode).toBe(404);
    }
    const updated = await api('PUT', `/me/trip-alerts/${saved.id}`, 'alice', {
      name: 'Paused',
      communityId,
      enabled: false,
      expectedVersion: 1,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({
      enabled: false,
      version: 2,
      minBudget: null,
      maxBudget: null,
      origin: null,
      transport: null,
      departureFrom: null,
    });
    expect(
      (
        await api('PUT', `/me/trip-alerts/${saved.id}`, 'alice', {
          name: 'Stale',
          communityId,
          enabled: true,
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await api('DELETE', `/me/trip-alerts/${saved.id}`)).statusCode,
    ).toBe(204);
    expect((await api('GET', '/me/trip-alerts')).json().data).toEqual([]);
  });
  it('serializes concurrent quota checks, including paused alerts', async () => {
    for (let i = 0; i < 19; i++) await subscribe('alice', { enabled: false });
    const results = await Promise.allSettled([
      prismaTripAlertRepository.create(ids.alice, input()),
      prismaTripAlertRepository.create(ids.alice, input()),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'TRIP_ALERT_LIMIT_REACHED' } });
    expect(
      await database.tripAlertSubscription.count({
        where: { userId: ids.alice },
      }),
    ).toBe(20);
  });
  it('rejects stale concurrent replacements rather than silently overwriting', async () => {
    const sub = await subscribe();
    const results = await Promise.allSettled([
      prismaTripAlertRepository.replace(ids.alice, sub.id, 1, {
        ...input(),
        name: 'First edit',
      }),
      prismaTripAlertRepository.replace(ids.alice, sub.id, 1, {
        ...input(),
        name: 'Second edit',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'TRIP_ALERT_VERSION_CONFLICT' } });
  });
  it('requires active destinations for enabling but still allows pause and unsubscribe after archive', async () => {
    const sub = await subscribe();
    await database.community.update({
      where: { id: communityId },
      data: { status: 'ARCHIVED' },
    });
    await expect(
      prismaTripAlertRepository.create(ids.alice, input()),
    ).rejects.toMatchObject({ code: 'COMMUNITY_NOT_FOUND' });
    await expect(
      prismaTripAlertRepository.replace(ids.alice, sub.id, 1, input()),
    ).rejects.toMatchObject({ code: 'COMMUNITY_NOT_FOUND' });
    await expect(
      prismaTripAlertRepository.replace(ids.alice, sub.id, 1, {
        ...input(),
        enabled: false,
      }),
    ).resolves.toMatchObject({ enabled: false });
    await expect(
      prismaTripAlertRepository.remove(ids.alice, sub.id),
    ).resolves.toBeUndefined();
  });
  it.each(['SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const)(
    'rechecks %s accounts inside writes',
    async (status) => {
      const sub = await subscribe();
      await database.user.update({
        where: { id: ids.alice },
        data: {
          status,
          ...(status === 'PENDING_DELETION' && {
            statusBeforeDeletion: 'ACTIVE',
          }),
        },
      });
      await expect(
        prismaTripAlertRepository.create(ids.alice, input()),
      ).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
      await expect(
        prismaTripAlertRepository.replace(ids.alice, sub.id, 1, input()),
      ).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
      expect((await api('GET', '/me/trip-alerts')).statusCode).toBe(403);
    },
  );
  it("exports only the requesting account's saved criteria", async () => {
    const own = await subscribe('alice', { minBudget: '12000.50' });
    const other = await subscribe('bob', { name: 'Bob secret search' });
    const exported = await createAccountDataExport(ids.alice);
    expect(exported.activity.tripAlerts).toHaveLength(1);
    expect(exported.activity.tripAlerts[0]).toMatchObject({
      id: own.id,
      communityId,
    });
    expect(JSON.stringify(exported)).not.toContain(other.name);
  });
});

describe('durable matching-trip delivery', () => {
  it('queues only first publication, creates generic inbox alerts, and never opts into push', async () => {
    await subscribe();
    const trip = await createTrip();
    expect(
      await database.tripPublicationAlert.count({ where: { tripId: trip.id } }),
    ).toBe(0);
    const published = await api('POST', `/trips/${trip.id}/publish`, 'owner', {
      expectedVersion: 1,
      confirmsPersonalPlan: true,
    });
    expect(published.statusCode).toBe(200);
    expect(
      await database.tripPublicationAlert.count({ where: { tripId: trip.id } }),
    ).toBe(1);
    expect(await matchingNotifications()).toHaveLength(0);
    await drain();
    const records = await matchingNotifications();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tripId: trip.id,
      sourceId: trip.id,
      actorId: ids.owner,
      pushStatus: 'SKIPPED',
      readAt: null,
      pushAttempts: 0,
    });
    const inbox = await api('GET', '/me/notifications');
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().data[0]).toMatchObject({
      type: 'MATCHING_TRIP_PUBLISHED',
      title: 'A new trip matches your saved alert',
    });
    expect(inbox.body).not.toContain('My private Manali search');
    expect(inbox.body).not.toContain(trip.description);
    expect(
      (await api('GET', '/me/notifications/unread-count')).json().data.count,
    ).toBe(1);
    expect(
      (await api('POST', `/me/notifications/${records[0]!.id}/read`))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await api('POST', `/trips/${trip.id}/pause`, 'owner', {
          expectedVersion: 2,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api('POST', `/trips/${trip.id}/publish`, 'owner', {
          expectedVersion: 3,
          confirmsPersonalPlan: true,
        })
      ).statusCode,
    ).toBe(200);
    await drain();
    expect(
      await database.tripPublicationAlert.count({ where: { tripId: trip.id } }),
    ).toBe(1);
    expect(await matchingNotifications()).toHaveLength(1);
  });
  it('does not backfill existing published trips or include subscriptions created/edited after publication', async () => {
    await createTrip({ status: 'PUBLISHED', publishedAt: new Date() });
    await subscribe();
    expect(await drain()).toHaveLength(0);
    const trip = await publish();
    const job = await database.tripPublicationAlert.findUniqueOrThrow({
      where: { tripId: trip.id },
    });
    await database.tripAlertSubscription.updateMany({
      where: { userId: ids.alice },
      data: { updatedAt: new Date(job.publishedAt.getTime() + 1000) },
    });
    await subscribe('bob', {
      createdAt: new Date(job.publishedAt.getTime() + 1000),
      updatedAt: new Date(job.publishedAt.getTime() + 1000),
    });
    await drain();
    expect(await matchingNotifications('alice')).toHaveLength(0);
    expect(await matchingNotifications('bob')).toHaveLength(0);
  });
  it('deduplicates multiple matching subscriptions across bounded batches and parallel workers', async () => {
    for (const role of ['alice', 'alice', 'bob', 'bob'] as const)
      await subscribe(role);
    const trip = await publish();
    await Promise.all([
      processTripAlertBatch({ batchSize: 1 }),
      processTripAlertBatch({ batchSize: 1 }),
    ]);
    await drain(1);
    expect(await matchingNotifications('alice')).toHaveLength(1);
    expect(await matchingNotifications('bob')).toHaveLength(1);
    expect(await drain(1)).toEqual([]);
    expect(
      await database.tripPublicationAlert.findUniqueOrThrow({
        where: { tripId: trip.id },
      }),
    ).toMatchObject({ completedAt: expect.any(Date) });
  });
  it('never retargets a pending job when the trip moves to another destination', async () => {
    await subscribe();
    await subscribe('bob', { communityId: otherCommunityId });
    const trip = await publish();
    await database.trip.update({
      where: { id: trip.id },
      data: { communityId: otherCommunityId },
    });
    await drain();
    expect(await matchingNotifications('alice')).toHaveLength(0);
    expect(await matchingNotifications('bob')).toHaveLength(0);
  });
  it('honors all inclusive discovery bounds without inferring missing prices', async () => {
    await subscribe('alice', {
      origin: 'delHI',
      departureFrom: date(35),
      departureTo: date(40),
      minBudget: '18000.25',
      maxBudget: '18000.25',
      minDuration: 6,
      maxDuration: 6,
      transport: 'BUS',
    });
    await subscribe('bob', { minBudget: '18000.26' });
    await publish();
    await drain();
    expect(await matchingNotifications('alice')).toHaveLength(1);
    expect(await matchingNotifications('bob')).toHaveLength(0);
    await publish({ budgetMin: null, budgetMax: null });
    await drain();
    expect(await matchingNotifications('alice')).toHaveLength(1);
  });
  it('excludes self, current members, either block direction and non-active accounts', async () => {
    for (const role of roles) await subscribe(role);
    const trip = await publish();
    await database.tripMembership.create({
      data: { tripId: trip.id, userId: ids.member, role: 'MEMBER' },
    });
    await database.userBlock.createMany({
      data: [
        { blockerId: ids.blocked, blockedId: ids.owner },
        { blockerId: ids.owner, blockedId: ids.bob },
      ],
    });
    await database.user.update({
      where: { id: ids.suspended },
      data: { status: 'SUSPENDED' },
    });
    await database.user.update({
      where: { id: ids.pending },
      data: { status: 'PENDING_DELETION', statusBeforeDeletion: 'ACTIVE' },
    });
    await database.user.update({
      where: { id: ids.deleted },
      data: { status: 'DELETED', deletedAt: new Date() },
    });
    await drain();
    expect(await matchingNotifications('alice')).toHaveLength(1);
    for (const role of roles.filter((role) => role !== 'alice'))
      expect(await matchingNotifications(role)).toHaveLength(0);
  });
  it('honors pause/delete committed before a pending batch, without deleting existing inbox history', async () => {
    const alice = await subscribe();
    const bob = await subscribe('bob');
    await publish();
    await prismaTripAlertRepository.replace(ids.alice, alice.id, 1, {
      ...input(),
      enabled: false,
    });
    await prismaTripAlertRepository.remove(ids.bob, bob.id);
    await drain();
    expect(await matchingNotifications('alice')).toHaveLength(0);
    expect(await matchingNotifications('bob')).toHaveLength(0);
    const resumed = await prismaTripAlertRepository.replace(
      ids.alice,
      alice.id,
      2,
      input(),
    );
    await publish();
    await drain();
    expect(await matchingNotifications()).toHaveLength(1);
    await prismaTripAlertRepository.remove(ids.alice, resumed.id);
    expect(await matchingNotifications()).toHaveLength(1);
  });
  it.each(['FULL', 'PAUSED', 'CANCELLED', 'COMPLETED'] as const)(
    'skips a queued trip now %s',
    async (status) => {
      await subscribe();
      const trip = await publish();
      await database.trip.update({ where: { id: trip.id }, data: { status } });
      await drain();
      expect(await matchingNotifications()).toHaveLength(0);
    },
  );
  it.each(['capacity', 'expired', 'removed', 'owner', 'destination'] as const)(
    'rechecks trip eligibility: %s',
    async (reason) => {
      await subscribe();
      const trip = await publish();
      if (reason === 'capacity')
        await database.trip.update({
          where: { id: trip.id },
          data: { currentGroupSize: 4 },
        });
      if (reason === 'expired')
        await database.trip.update({
          where: { id: trip.id },
          data: { startDate: date(-10), endDate: date(-5) },
        });
      if (reason === 'removed')
        await database.trip.update({
          where: { id: trip.id },
          data: { moderationRemovedAt: new Date() },
        });
      if (reason === 'owner')
        await database.user.update({
          where: { id: ids.owner },
          data: { status: 'SUSPENDED' },
        });
      if (reason === 'destination')
        await database.community.update({
          where: { id: communityId },
          data: { status: 'ARCHIVED' },
        });
      await drain();
      expect(await matchingNotifications()).toHaveLength(0);
    },
  );
  it('rolls back a failed batch and retries from the same cursor after durable backoff', async () => {
    await subscribe();
    const trip = await publish();
    const clock = new Date(Date.now() + 100);
    vi.spyOn(
      notificationRepository,
      'createNotifications',
    ).mockRejectedValueOnce(new Error('Injected delivery failure'));
    await expect(processTripAlertBatch({ now: clock })).rejects.toThrow(
      'Injected delivery failure',
    );
    vi.restoreAllMocks();
    expect(await matchingNotifications()).toHaveLength(0);
    const job = await database.tripPublicationAlert.findUniqueOrThrow({
      where: { tripId: trip.id },
    });
    expect(job).toMatchObject({
      cursorId: null,
      completedAt: null,
      failedAttempts: 1,
    });
    expect((await processTripAlertBatch({ now: clock })).tripId).toBeNull();
    await drain(100, new Date(clock.getTime() + 61_000));
    expect(await matchingNotifications()).toHaveLength(1);
  });
  it('does not commit publication or its job when the publishing transaction fails', async () => {
    const trip = await createTrip();
    vi.spyOn(
      notificationRepository,
      'createNotifications',
    ).mockRejectedValueOnce(new Error('Injected publish failure'));
    const response = await api('POST', `/trips/${trip.id}/publish`, 'owner', {
      expectedVersion: 1,
      confirmsPersonalPlan: true,
    });
    vi.restoreAllMocks();
    expect(response.statusCode).toBe(500);
    expect(
      await database.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ status: 'DRAFT', publishedAt: null, version: 1 });
    expect(
      await database.tripPublicationAlert.count({ where: { tripId: trip.id } }),
    ).toBe(0);
  });
  it('erases saved criteria with the account and cannot deliver a queued alert afterward', async () => {
    await subscribe();
    await publish();
    const requested = await api('POST', '/me/data-requests', 'alice', {
      type: 'ACCOUNT_DELETION',
      confirm: true,
    });
    expect(requested.statusCode, requested.body).toBe(201);
    await drain();
    expect(await matchingNotifications()).toHaveLength(0);
    await processAccountErasures({
      now: new Date(Date.now() + 32 * 86_400_000),
      storage: null,
      signInAccounts: { async remove() {} },
      logger: app.log,
    });
    expect(
      await database.tripAlertSubscription.count({
        where: { userId: ids.alice },
      }),
    ).toBe(0);
    expect(await matchingNotifications()).toHaveLength(0);
    await expect(
      prismaTripAlertRepository.create(ids.alice, input()),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
});

// Matching alerts the person already received, the given hours ago.
function seedMatchingAlerts(role: Role, count: number, hoursAgo = 2) {
  return database.notification.createMany({
    data: Array.from({ length: count }, () => {
      const sourceId = randomUUID();
      return {
        recipientId: ids[role],
        type: 'MATCHING_TRIP_PUBLISHED' as const,
        eventKey: `trip:${sourceId}:matching-published`,
        sourceId,
        createdAt: new Date(Date.now() - hoursAgo * 3_600_000),
        pushStatus: 'SKIPPED' as const,
      };
    }),
  });
}

// Earlier alerting publications by the owner, at the given ages.
async function seedAlertingPublications(...hoursAgo: number[]) {
  for (const hours of hoursAgo) {
    const trip = await createTrip();
    await database.tripPublicationAlert.create({
      data: {
        tripId: trip.id,
        communityId,
        publishedAt: new Date(Date.now() - hours * 3_600_000),
        completedAt: new Date(),
      },
    });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Holds a quota lock in another transaction until released.
async function holdLock(
  take: (transaction: Prisma.TransactionClient) => Promise<void>,
) {
  const taken = deferred();
  const release = deferred();
  const finished = database.$transaction(
    async (transaction) => {
      await take(transaction);
      taken.resolve();
      await release.promise;
    },
    { timeout: 20_000 },
  );
  await taken.promise;
  return async () => {
    release.resolve();
    await finished;
  };
}

// Waits until this many transactions are blocked on a lock.
async function waitForLockWaiters(count: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await database.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted
    `;
    if ((row?.waiting ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fewer than ${count} transactions reached a lock wait.`);
}

const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

describe('matching-trip alert limits', () => {
  it('keeps concurrent publications by one account within its alert budget', async () => {
    await seedAlertingPublications(1, 2, 3, 4);
    const drafts = [await createTrip(), await createTrip()];
    // Hold back alert-job inserts until both publications have reached that
    // point, which is when an unserialized budget check lets both through.
    const release = await holdLock(async (transaction) => {
      await transaction.$executeRaw`LOCK TABLE "trip_publication_alerts" IN SHARE MODE`;
    });
    const publishing = Promise.all(
      drafts.map((trip) =>
        api('POST', `/trips/${trip.id}/publish`, 'owner', {
          expectedVersion: 1,
          confirmsPersonalPlan: true,
        }),
      ),
    );
    try {
      await waitForLockWaiters(2);
    } finally {
      await release();
    }

    expect((await publishing).map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);
    expect(
      await database.tripPublicationAlert.count({
        where: { tripId: { in: drafts.map((trip) => trip.id) } },
      }),
    ).toBe(1);
  });

  it('makes a publication wait while another holds the owner budget', async () => {
    const draft = await createTrip();
    const release = await holdLock((transaction) =>
      lockOwnerAlertBudget(transaction, ids.owner),
    );
    const publishing = api('POST', `/trips/${draft.id}/publish`, 'owner', {
      expectedVersion: 1,
      confirmsPersonalPlan: true,
    });
    try {
      expect(await settledWithin(publishing, 300)).toBe(false);
    } finally {
      await release();
    }
    expect((await publishing).statusCode).toBe(200);
  });

  it('counts only publications from the last 24 hours', async () => {
    await seedAlertingPublications(24.02, 24.02, 24.02, 24.02, 24.02);
    const outside = await publish();
    expect(
      await database.tripPublicationAlert.count({
        where: { tripId: outside.id },
      }),
    ).toBe(1);

    await seedAlertingPublications(23.98, 23.98, 23.98, 23.98);
    const inside = await publish();
    expect(
      await database.tripPublicationAlert.count({
        where: { tripId: inside.id },
      }),
    ).toBe(0);
  });

  it('alerts for only the first five trips an account publishes in a day', async () => {
    await subscribe();
    const trips = [];
    for (let index = 0; index < 6; index += 1) trips.push(await publish());

    expect(
      await database.trip.count({
        where: {
          id: { in: trips.map((trip) => trip.id) },
          status: 'PUBLISHED',
        },
      }),
    ).toBe(6);
    expect(
      await database.tripPublicationAlert.count({
        where: { tripId: { in: trips.map((trip) => trip.id) } },
      }),
    ).toBe(5);
    await drain();
    expect(await matchingNotifications()).toHaveLength(5);
  });

  it('keeps the daily limit when workers alert the same person from two destinations at once', async () => {
    await seedMatchingAlerts('alice', 9);
    await subscribe('alice');
    await subscribe('alice', { communityId: otherCommunityId });
    const trips = [
      await publish(),
      await publish({ communityId: otherCommunityId }),
    ];
    // Hold back notification inserts until both workers reach them, which
    // is when an unserialized limit check lets both through.
    const release = await holdLock(async (transaction) => {
      await transaction.$executeRaw`LOCK TABLE "notifications" IN SHARE MODE`;
    });
    const working = Promise.all([
      processTripAlertBatch(),
      processTripAlertBatch(),
    ]);
    try {
      await waitForLockWaiters(2);
    } finally {
      await release();
    }
    const results = await working;

    expect(results.map((result) => result.tripId).sort()).toEqual(
      trips.map((trip) => trip.id).sort(),
    );
    expect(await matchingNotifications('alice')).toHaveLength(10);
  });

  it('makes a worker wait while another holds a recipient limit', async () => {
    await subscribe('alice');
    await publish();
    const release = await holdLock((transaction) =>
      lockRecipientAlertLimits(transaction, [ids.alice]),
    );
    const working = processTripAlertBatch();
    try {
      expect(await settledWithin(working, 300)).toBe(false);
    } finally {
      await release();
    }
    expect((await working).matchedRecipients).toBe(1);
  });

  it('stops alerting a person who already had ten matching alerts today', async () => {
    await seedMatchingAlerts('alice', 10);
    await seedMatchingAlerts('bob', 10, 25);
    await subscribe('alice');
    await subscribe('bob');
    const trip = await publish();

    const [result] = await drain();
    expect(result).toMatchObject({
      matchedRecipients: 1,
      limitedRecipients: 1,
    });
    const latest = (role: Role) =>
      database.notification.count({
        where: { recipientId: ids[role], tripId: trip.id },
      });
    expect(await latest('alice')).toBe(0);
    expect(await latest('bob')).toBe(1);
  });
});
