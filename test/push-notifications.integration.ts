import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { NotificationType } from '../src/generated/prisma/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { createNotifications } from '../src/modules/notifications/notification.repository.js';
import {
  processPushBatch,
  startPushDelivery,
  type PushMessage,
  type PushSendResult,
  type PushSender,
} from '../src/modules/notifications/push-delivery.js';

const run = randomUUID();
const roles = ['alice', 'bob', 'carol'] as const;
type Role = (typeof roles)[number];
const userIds = {} as Record<Role, string>;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: `push-${token}-${run}`, emailVerified: false };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });

const deviceToken = (label: string) => `fcm-${label}-${run}`;

function api(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  role: Role,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${role}` },
    ...(payload && { payload }),
  });
}

function registerDevice(role: Role, token: string, platform = 'ANDROID') {
  return api('POST', '/me/push-devices', role, { token, platform });
}

async function notify(
  recipient: Role,
  type: NotificationType = 'CONNECTION_REQUEST_RECEIVED',
  createdAt = new Date(),
) {
  const sourceId = randomUUID();
  await database.$transaction((transaction) =>
    createNotifications(transaction, {
      recipientIds: [userIds[recipient]],
      type,
      eventKey: `push-test:${sourceId}`,
      sourceId,
      actorId: userIds.bob,
      createdAt,
    }),
  );
  return database.notification.findFirstOrThrow({ where: { sourceId } });
}

function recordingSender(
  outcome: (message: PushMessage) => PushSendResult = () => 'sent',
) {
  const sent: PushMessage[] = [];
  const sender: PushSender = {
    async send(messages) {
      sent.push(...messages);
      return messages.map(outcome);
    },
  };
  return { sent, sender };
}

// Other test files leave pending notifications behind, so each delivery test
// drains the whole queue and then looks only at its own rows.
async function drain(sender: PushSender) {
  for (;;) {
    const result = await processPushBatch(sender, { batchSize: 500 });
    if (result.claimed === 0) return;
  }
}

beforeAll(async () => {
  await app.ready();
  for (const role of roles) {
    const response = await api('POST', '/auth/bootstrap', role);
    userIds[role] = response.json().data.id as string;
  }
  await drain(recordingSender().sender);
});

afterAll(async () => {
  await app.close();
  await database.user.deleteMany({
    where: { id: { in: Object.values(userIds) } },
  });
  await database.$disconnect();
});

describe('push device registration', () => {
  it('registers, refreshes, lists, and removes a device without exposing its token', async () => {
    const token = deviceToken('alice-phone');
    const first = await registerDevice('alice', token, 'WEB');
    const refreshed = await registerDevice('alice', token, 'ANDROID');
    expect(first.statusCode).toBe(200);
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().data).toMatchObject({
      id: first.json().data.id,
      platform: 'ANDROID',
    });

    const listed = await api('GET', '/me/push-devices', 'alice');
    expect(listed.json().data).toHaveLength(1);
    expect(listed.body).not.toContain(token);

    const removedByOther = await api(
      'DELETE',
      `/me/push-devices/${first.json().data.id}`,
      'carol',
    );
    expect(removedByOther.statusCode).toBe(404);
    expect(removedByOther.json().error.code).toBe('PUSH_DEVICE_NOT_FOUND');

    const removed = await api(
      'DELETE',
      `/me/push-devices/${first.json().data.id}`,
      'alice',
    );
    expect(removed.statusCode).toBe(204);
    expect((await api('GET', '/me/push-devices', 'alice')).json().data).toEqual(
      [],
    );
  });

  it('moves a device to the account that registers it last', async () => {
    const token = deviceToken('shared-tablet');
    await registerDevice('alice', token);
    await registerDevice('carol', token);

    expect((await api('GET', '/me/push-devices', 'alice')).json().data).toEqual(
      [],
    );
    expect(
      (await api('GET', '/me/push-devices', 'carol')).json().data,
    ).toHaveLength(1);
    await database.pushDevice.deleteMany({ where: { token } });
  });

  it('keeps only the ten most recently registered devices per account', async () => {
    for (let index = 0; index < 11; index += 1) {
      const response = await registerDevice(
        'carol',
        deviceToken(`carol-${index}`),
      );
      expect(response.statusCode).toBe(200);
    }
    const remaining = await database.pushDevice.findMany({
      where: { userId: userIds.carol },
      select: { token: true },
    });
    expect(remaining).toHaveLength(10);
    expect(remaining.map((device) => device.token)).not.toContain(
      deviceToken('carol-0'),
    );
    await database.pushDevice.deleteMany({ where: { userId: userIds.carol } });
  });
});

describe('push delivery', () => {
  it('sends a generic alert to every registered device and marks it sent', async () => {
    await registerDevice('alice', deviceToken('alice-a'), 'ANDROID');
    await registerDevice('alice', deviceToken('alice-b'), 'WEB');
    const notification = await notify('alice', 'MESSAGE_RECEIVED');

    const { sent, sender } = recordingSender();
    await drain(sender);

    const mine = sent.filter(
      (message) => message.data.notificationId === notification.id,
    );
    expect(mine.map((message) => message.token).sort()).toEqual(
      [deviceToken('alice-a'), deviceToken('alice-b')].sort(),
    );
    expect(mine[0]).toMatchObject({
      title: 'New trip message',
      data: {
        notificationId: notification.id,
        type: 'MESSAGE_RECEIVED',
        sourceId: notification.sourceId,
      },
    });
    const stored = await database.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(stored.pushStatus).toBe('SENT');
    expect(stored.pushedAt).toBeInstanceOf(Date);

    const { sent: resent, sender: secondSender } = recordingSender();
    await drain(secondSender);
    expect(
      resent.filter(
        (message) => message.data.notificationId === notification.id,
      ),
    ).toEqual([]);
  });

  it('removes devices whose tokens FCM rejects', async () => {
    const deadToken = deviceToken('alice-a');
    const notification = await notify('alice');

    const { sender } = recordingSender((message) =>
      message.token === deadToken ? 'invalid_token' : 'sent',
    );
    await drain(sender);

    expect(
      await database.pushDevice.count({ where: { token: deadToken } }),
    ).toBe(0);
    expect(
      await database.pushDevice.count({
        where: { token: deviceToken('alice-b') },
      }),
    ).toBe(1);
    const stored = await database.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(stored.pushStatus).toBe('SENT');
  });

  it('skips stale alerts, alerts already read, and suspended recipients', async () => {
    const stale = await notify(
      'alice',
      'TRIP_UPDATED',
      new Date(Date.now() - 60 * 60 * 1000),
    );
    const read = await notify('alice', 'TRIP_UPDATED');
    const markRead = await api(
      'POST',
      `/me/notifications/${read.id}/read`,
      'alice',
    );
    expect(markRead.statusCode).toBe(200);

    await registerDevice('carol', deviceToken('carol-phone'));
    await database.user.update({
      where: { id: userIds.carol },
      data: { status: 'SUSPENDED' },
    });
    const suspended = await notify('carol', 'TRIP_UPDATED');

    const { sent, sender } = recordingSender();
    try {
      await drain(sender);
    } finally {
      await database.user.update({
        where: { id: userIds.carol },
        data: { status: 'ACTIVE' },
      });
    }

    const ids = [stale.id, read.id, suspended.id];
    expect(
      sent.filter((message) => ids.includes(message.data.notificationId ?? '')),
    ).toEqual([]);
    const stored = await database.notification.findMany({
      where: { id: { in: ids } },
      select: { pushStatus: true },
    });
    expect(stored.map((item) => item.pushStatus)).toEqual([
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
    ]);
  });

  it('marks a batch failed when the sender is unavailable', async () => {
    const notification = await notify('alice');
    const outage: PushSender = {
      async send() {
        throw new Error('FCM unavailable');
      },
    };

    await expect(processPushBatch(outage, { batchSize: 500 })).rejects.toThrow(
      'FCM unavailable',
    );
    const stored = await database.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(stored.pushStatus).toBe('FAILED');
  });

  it('delivers from the background worker and stops cleanly', async () => {
    const notification = await notify('alice', 'SETTLEMENT_PENDING');
    const { sent, sender } = recordingSender();
    const worker = startPushDelivery(sender, app.log);
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (
          sent.some(
            (message) => message.data.notificationId === notification.id,
          )
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await worker.stop();
    }
    expect(
      sent.some((message) => message.data.notificationId === notification.id),
    ).toBe(true);
  });

  it('includes device registrations, without tokens, in the data export', async () => {
    const response = await api('POST', '/me/data-export', 'alice');
    expect(response.statusCode).toBe(200);
    const devices = response.json().activity.pushDevices as object[];
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ platform: 'WEB' });
    expect(response.body).not.toContain(deviceToken('alice-b'));
  });
});
