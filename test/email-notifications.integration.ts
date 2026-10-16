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
import type { NotificationType } from '../src/generated/prisma/client.js';
import { processAccountErasures } from '../src/modules/account-deletion/account-erasure.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { createAccountDataExport } from '../src/modules/data-export/data-export.repository.js';
import * as emailConfiguration from '../src/modules/email/email.configuration.js';
import { processEmailBatch } from '../src/modules/email/email-delivery.js';
import { prismaEmailPreferenceRepository } from '../src/modules/email/email-preference.repository.js';
import { createFirebaseEmailRecipientResolver } from '../src/modules/email/firebase-email-recipient.js';
import type {
  EmailDeliveryDependencies,
  EmailMessage,
} from '../src/modules/email/email.types.js';
import { createNotifications } from '../src/modules/notifications/notification.repository.js';

const run = randomUUID();
const ids = { owner: randomUUID(), alice: randomUUID(), bob: randomUUID() };
type Role = keyof typeof ids;
const userIds = Object.values(ids);
const communityId = randomUUID();
const tripId = randomUUID();
const subject = (role: string) => `email-${run}-${role}`;
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: subject(token),
      emailVerified: false,
      authTime: new Date(),
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const messages: EmailMessage[] = [];
const dependencies: EmailDeliveryDependencies = {
  sender: {
    async send(message) {
      messages.push(message);
      return 'accepted';
    },
  },
  recipients: {
    async resolve(userId) {
      return userId === ids.alice
        ? 'alice-current@example.test'
        : 'bob-current@example.test';
    },
  },
};
const now = () => new Date(Date.now() + 100);
function api(
  method: 'GET' | 'PATCH' | 'POST',
  role: Role = 'alice',
  payload?: object,
  path = '/me/email-preferences',
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${role}` },
    ...(payload && { payload }),
  });
}
async function optIn(role: Role = 'alice') {
  return prismaEmailPreferenceRepository.update(ids[role], 0, {
    connections: true,
    trips: true,
    finances: true,
    safety: true,
  });
}
async function notify(
  options: {
    role?: Role;
    type?: NotificationType;
    eventKey?: string;
    readAt?: Date;
  } = {},
) {
  const recipientId = ids[options.role ?? 'alice'];
  const eventKey = options.eventKey ?? `email:${randomUUID()}`;
  await database.$transaction((tx) =>
    createNotifications(tx, {
      recipientIds: [recipientId],
      type: options.type ?? 'CONNECTION_REQUEST_RECEIVED',
      eventKey,
      sourceId: tripId,
      tripId,
      actorId: ids.owner,
    }),
  );
  return database.notification.findUniqueOrThrow({
    where: { recipientId_eventKey: { recipientId, eventKey } },
  });
}
async function delivery(notificationId: string) {
  return database.emailDelivery.findUniqueOrThrow({
    where: { notificationId },
  });
}
async function clear() {
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
  await database.emailPreference.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.authIdentity.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.userBlock.deleteMany({
    where: { blockerId: { in: userIds } },
  });
}
beforeAll(async () => {
  await app.ready();
  await database.community.create({
    data: {
      id: communityId,
      name: 'Email Test Community',
      slug: `email-${run}`,
    },
  });
  for (const role of Object.keys(ids) as Role[])
    await database.user.create({
      data: {
        id: ids[role],
        displayName: role,
        birthDate: new Date('1995-01-01'),
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subject(role) },
        },
      },
    });
  await database.trip.create({
    data: {
      id: tripId,
      ownerId: ids.owner,
      communityId,
      originCity: 'Delhi',
      startDate: new Date(Date.now() + 60 * 86_400_000),
      endDate: new Date(Date.now() + 65 * 86_400_000),
      durationDays: 6,
      desiredGroupSize: 4,
      currentGroupSize: 2,
      description: 'Never include this private description in an email.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      memberships: {
        create: [
          { userId: ids.owner, role: 'OWNER' },
          { userId: ids.alice, role: 'MEMBER' },
        ],
      },
    },
  });
});
beforeEach(async () => {
  await clear();
  messages.length = 0;
  await database.user.updateMany({
    where: { id: { in: userIds } },
    data: { status: 'ACTIVE', deletedAt: null, statusBeforeDeletion: null },
  });
  // Only tests can install this capability override. The production sender
  // factory remains null and no real sender, SMTP client or API key is used.
  vi.spyOn(emailConfiguration, 'emailDeliveryConfigured').mockReturnValue(true);
});
afterAll(async () => {
  await app.close();
  await clear();
  await database.trip.deleteMany({ where: { id: tripId } });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.$disconnect();
});

describe('email preferences and transactional routing', () => {
  it('defaults off, patches only your choices, and isolates other accounts', async () => {
    const initial = await api('GET');
    expect(initial.statusCode).toBe(200);
    expect(initial.headers['cache-control']).toBe('private, no-store');
    expect(initial.json().data).toMatchObject({
      version: 0,
      connections: false,
      trips: false,
      finances: false,
      safety: false,
    });
    expect(
      await database.emailPreference.count({ where: { userId: ids.alice } }),
    ).toBe(0);
    const changed = await api('PATCH', 'alice', {
      expectedVersion: 0,
      connections: true,
      userId: ids.bob,
      email: 'other@example.test',
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data).toMatchObject({
      version: 1,
      connections: true,
      trips: false,
    });
    expect(changed.json().data).not.toHaveProperty('userId');
    expect((await api('GET', 'bob')).json().data.version).toBe(0);
    expect(
      (await api('PATCH', 'alice', { expectedVersion: 1, trips: true })).json()
        .data,
    ).toMatchObject({ version: 2, connections: true, trips: true });
    expect(
      (await api('PATCH', 'alice', { expectedVersion: 1, trips: false }))
        .statusCode,
    ).toBe(409);
  });
  it('serializes concurrent first consent updates', async () => {
    const results = await Promise.allSettled([
      prismaEmailPreferenceRepository.update(ids.alice, 0, { trips: true }),
      prismaEmailPreferenceRepository.update(ids.alice, 0, {
        connections: true,
      }),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'EMAIL_PREFERENCE_VERSION_CONFLICT' },
    });
  });
  it.each(['SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const)(
    'blocks stale writes to %s accounts',
    async (status) => {
      await database.user.update({
        where: { id: ids.alice },
        data: {
          status,
          ...(status === 'PENDING_DELETION' && {
            statusBeforeDeletion: 'ACTIVE',
          }),
        },
      });
      await expect(optIn()).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
      expect((await api('GET')).statusCode).toBe(403);
    },
  );
  it('does not enqueue while unconfigured, and does not replay an old duplicate after configuration', async () => {
    await optIn();
    vi.mocked(emailConfiguration.emailDeliveryConfigured).mockReturnValue(
      false,
    );
    expect((await api('GET')).json().data.deliveryConfigured).toBe(false);
    const eventKey = `disabled:${run}`;
    const old = await notify({ eventKey });
    expect(
      await database.emailDelivery.count({ where: { notificationId: old.id } }),
    ).toBe(0);
    vi.mocked(emailConfiguration.emailDeliveryConfigured).mockReturnValue(true);
    await notify({ eventKey });
    expect(
      await database.emailDelivery.count({ where: { notificationId: old.id } }),
    ).toBe(0);
    const next = await notify();
    expect((await delivery(next.id)).status).toBe('PENDING');
  });
  it('does not queue for defaults, disabled categories, messages or matching-trip alerts', async () => {
    const before = await notify();
    await prismaEmailPreferenceRepository.update(ids.alice, 0, {
      connections: true,
    });
    await notify({ type: 'TRIP_UPDATED' });
    await notify({ type: 'MESSAGE_RECEIVED' });
    await notify({ type: 'MATCHING_TRIP_PUBLISHED' });
    await notify({ eventKey: before.eventKey });
    expect(
      await database.emailDelivery.count({
        where: { notification: { recipientId: ids.alice } },
      }),
    ).toBe(0);
  });
  it('queues once per new notification and commits/rolls back with the source action', async () => {
    await optIn();
    const eventKey = `atomic:${run}`;
    const record = await notify({ eventKey });
    await notify({ eventKey });
    expect(
      await database.emailDelivery.count({
        where: { notificationId: record.id },
      }),
    ).toBe(1);
    const rollbackKey = `rollback:${run}`;
    await expect(
      database.$transaction(async (tx) => {
        await createNotifications(tx, {
          recipientIds: [ids.alice],
          type: 'TRIP_UPDATED',
          eventKey: rollbackKey,
          tripId,
          sourceId: tripId,
          actorId: ids.owner,
        });
        throw new Error('Intentional source rollback');
      }),
    ).rejects.toThrow('Intentional source rollback');
    expect(
      await database.notification.count({ where: { eventKey: rollbackKey } }),
    ).toBe(0);
    expect(
      await database.emailDelivery.count({
        where: { notification: { recipientId: ids.alice } },
      }),
    ).toBe(1);
  });
  it('exports only your preference and delivery metadata, never claim tokens or another account', async () => {
    await optIn();
    await optIn('bob');
    const own = await notify();
    const other = await notify({ role: 'bob' });
    const exported = await createAccountDataExport(ids.alice);
    expect(exported.account.emailPreference).toMatchObject({
      connections: true,
      version: 1,
    });
    expect(exported.activity.emailDeliveries).toHaveLength(1);
    expect(exported.activity.emailDeliveries[0]).toMatchObject({
      notificationId: own.id,
      status: 'PENDING',
    });
    expect(exported.activity.emailDeliveries[0]).not.toHaveProperty(
      'claimToken',
    );
    expect(JSON.stringify(exported.activity.emailDeliveries)).not.toContain(
      other.id,
    );
  });
});

describe('fake-sender delivery and recovery', () => {
  it('delivers only generic content with a stable idempotency key', async () => {
    await optIn();
    const notification = await notify({ type: 'EXPENSE_CREATED' });
    const result = await processEmailBatch(dependencies, { now: now() });
    expect(result).toMatchObject({ claimed: 1, accepted: 1, retrying: 0 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      to: 'alice-current@example.test',
      subject: 'New shared expense',
      idempotencyKey: `email-notification:${notification.id}`,
    });
    expect(messages[0]!.text).not.toContain('description');
    expect(messages[0]!.text).not.toContain(tripId);
    expect(await delivery(notification.id)).toMatchObject({
      status: 'SENT',
      attempts: 1,
      claimToken: null,
      sentAt: expect.any(Date),
    });
    expect((await processEmailBatch(dependencies)).claimed).toBe(0);
  });
  it('shares claims safely across concurrent workers', async () => {
    await optIn();
    for (let i = 0; i < 5; i++) await notify();
    await Promise.all([
      processEmailBatch(dependencies, { batchSize: 5 }),
      processEmailBatch(dependencies, { batchSize: 5 }),
    ]);
    expect(messages).toHaveLength(5);
    expect(new Set(messages.map((item) => item.idempotencyKey)).size).toBe(5);
  });
  it('retries temporary errors with backoff then stops after four attempts', async () => {
    await optIn();
    const notification = await notify();
    const send = vi.fn(async () => {
      throw new Error(
        'Provider error containing private address/key must not escape',
      );
    });
    const failing = { ...dependencies, sender: { send } };
    const clock = now();
    for (const offset of [0, 31_000, 152_000, 453_000])
      await processEmailBatch(failing, {
        now: new Date(clock.getTime() + offset),
      });
    expect(send).toHaveBeenCalledTimes(4);
    expect(await delivery(notification.id)).toMatchObject({
      status: 'FAILED',
      attempts: 4,
    });
    expect(
      new Set(
        send.mock.calls.map(
          (call) => (call as unknown as [EmailMessage])[0].idempotencyKey,
        ),
      ).size,
    ).toBe(1);
    expect(
      (
        await processEmailBatch(failing, {
          now: new Date(clock.getTime() + 900_000),
        })
      ).claimed,
    ).toBe(0);
  });
  it('recovers abandoned claims with the same provider idempotency key', async () => {
    await optIn();
    const notification = await notify();
    const clock = now();
    const key = `email-notification:${notification.id}`;
    const acceptedKeys = new Set([key]);
    let actualDeliveries = 1;
    await database.emailDelivery.update({
      where: { notificationId: notification.id },
      data: {
        status: 'SENDING',
        attempts: 1,
        claimToken: randomUUID(),
        claimedAt: new Date(clock.getTime() - 180_000),
      },
    });
    await processEmailBatch(
      {
        ...dependencies,
        sender: {
          async send(message) {
            if (!acceptedKeys.has(message.idempotencyKey)) {
              actualDeliveries++;
              acceptedKeys.add(message.idempotencyKey);
            }
            return 'accepted';
          },
        },
      },
      { now: clock },
    );
    expect(actualDeliveries).toBe(1);
    expect(await delivery(notification.id)).toMatchObject({
      status: 'SENT',
      attempts: 2,
    });
  });
  it('does not let a stale worker overwrite a newer claim', async () => {
    await optIn();
    const notification = await notify();
    const newerToken = randomUUID();
    await processEmailBatch({
      ...dependencies,
      sender: {
        async send() {
          await database.emailDelivery.update({
            where: { notificationId: notification.id },
            data: { claimToken: newerToken },
          });
          return 'accepted';
        },
      },
    });
    expect(await delivery(notification.id)).toMatchObject({
      status: 'SENDING',
      claimToken: newerToken,
    });
  });
  it('stops pending mail on preference change, without replay after re-enable', async () => {
    await optIn();
    const first = await notify();
    await prismaEmailPreferenceRepository.update(ids.alice, 1, {
      connections: false,
    });
    expect((await delivery(first.id)).status).toBe('SKIPPED');
    await prismaEmailPreferenceRepository.update(ids.alice, 2, {
      connections: true,
    });
    await processEmailBatch(dependencies);
    expect(messages).toHaveLength(0);
    await notify();
    await processEmailBatch(dependencies);
    expect(messages).toHaveLength(1);
  });
  it('rechecks consent after recipient resolution and before sending', async () => {
    await optIn();
    const notification = await notify();
    await processEmailBatch({
      ...dependencies,
      recipients: {
        async resolve() {
          await prismaEmailPreferenceRepository.update(ids.alice, 1, {
            connections: false,
          });
          return 'previously-resolved@example.test';
        },
      },
    });
    expect(messages).toHaveLength(0);
    expect((await delivery(notification.id)).status).toBe('SKIPPED');
  });
  it.each([
    'read',
    'expired',
    'disabled',
    'block-recipient',
    'block-actor',
    'former-member',
    'no-verified-email',
  ] as const)('skips ineligible mail: %s', async (reason) => {
    await optIn();
    const notification = await notify({
      type:
        reason === 'former-member'
          ? 'TRIP_UPDATED'
          : 'CONNECTION_REQUEST_RECEIVED',
    });
    if (reason === 'read')
      await database.notification.update({
        where: { id: notification.id },
        data: { readAt: new Date() },
      });
    if (reason === 'expired')
      await database.notification.update({
        where: { id: notification.id },
        data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
      });
    if (reason === 'disabled')
      await database.user.update({
        where: { id: ids.alice },
        data: { status: 'SUSPENDED' },
      });
    if (reason === 'block-recipient')
      await database.userBlock.create({
        data: { blockerId: ids.alice, blockedId: ids.owner },
      });
    if (reason === 'block-actor')
      await database.userBlock.create({
        data: { blockerId: ids.owner, blockedId: ids.alice },
      });
    if (reason === 'former-member')
      await database.tripMembership.updateMany({
        where: { tripId, userId: ids.alice },
        data: { status: 'LEFT', leftAt: new Date() },
      });
    await processEmailBatch(
      reason === 'no-verified-email'
        ? {
            ...dependencies,
            recipients: {
              async resolve() {
                return null;
              },
            },
          }
        : dependencies,
    );
    expect(messages).toHaveLength(0);
    expect((await delivery(notification.id)).status).toBe('SKIPPED');
    if (reason === 'former-member')
      await database.tripMembership.updateMany({
        where: { tripId, userId: ids.alice },
        data: { status: 'ACTIVE', leftAt: null },
      });
  });
  it('makes a permanent provider rejection terminal without retry', async () => {
    await optIn();
    const notification = await notify();
    await processEmailBatch({
      ...dependencies,
      sender: {
        async send() {
          return 'rejected';
        },
      },
    });
    expect(await delivery(notification.id)).toMatchObject({
      status: 'FAILED',
      attempts: 1,
    });
  });
});

describe('current Firebase recipient verification', () => {
  it('uses current provider email, never a historically verified database address', async () => {
    await database.authIdentity.create({
      data: {
        userId: ids.alice,
        type: 'EMAIL',
        normalizedValue: `old-${run}@example.test`,
        verifiedAt: new Date(),
      },
    });
    const lookup = vi.fn(async () => ({
      disabled: false,
      emailVerified: true,
      email: 'new-current@example.test',
    }));
    expect(
      await createFirebaseEmailRecipientResolver(lookup).resolve(ids.alice),
    ).toBe('new-current@example.test');
    expect(lookup).toHaveBeenCalledWith(subject('alice'));
  });
  it.each([
    { disabled: true, emailVerified: true, email: 'disabled@example.test' },
    { disabled: false, emailVerified: false, email: 'unverified@example.test' },
    { disabled: false, emailVerified: true },
    {
      disabled: false,
      emailVerified: true,
      email: 'invalid\r\nInjected: value',
    },
  ])('rejects an ineligible provider email %j', async (account) => {
    expect(
      await createFirebaseEmailRecipientResolver(async () => account).resolve(
        ids.alice,
      ),
    ).toBeNull();
  });
  it('handles removed provider users and sanitizes temporary lookup failures', async () => {
    const removed = createFirebaseEmailRecipientResolver(async () => {
      throw { code: 'auth/user-not-found' };
    });
    expect(await removed.resolve(ids.alice)).toBeNull();
    const failed = createFirebaseEmailRecipientResolver(async () => {
      throw new Error('secret-address-and-token');
    });
    await expect(failed.resolve(ids.alice)).rejects.toThrow(
      'EMAIL_RECIPIENT_LOOKUP_UNAVAILABLE',
    );
    await database.user.update({
      where: { id: ids.alice },
      data: { status: 'SUSPENDED' },
    });
    const lookup = vi.fn(async () => ({
      disabled: false,
      emailVerified: true,
      email: 'current@example.test',
    }));
    expect(
      await createFirebaseEmailRecipientResolver(lookup).resolve(ids.alice),
    ).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
  it('erases preferences/outbox with the account and rejects stale opt-in writes', async () => {
    await optIn();
    const notification = await notify();
    const response = await api(
      'POST',
      'alice',
      { type: 'ACCOUNT_DELETION', confirm: true },
      '/me/data-requests',
    );
    expect(response.statusCode, response.body).toBe(201);
    await processEmailBatch(dependencies);
    expect(messages).toHaveLength(0);
    await processAccountErasures({
      now: new Date(Date.now() + 32 * 86_400_000),
      storage: null,
      signInAccounts: { async remove() {} },
      logger: app.log,
    });
    expect(
      await database.emailPreference.findUnique({
        where: { userId: ids.alice },
      }),
    ).toBeNull();
    expect(
      await database.emailDelivery.count({
        where: { notificationId: notification.id },
      }),
    ).toBe(0);
    await expect(optIn()).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
});
