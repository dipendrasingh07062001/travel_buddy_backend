import type { BatchResponse, Message } from 'firebase-admin/messaging';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import { createFcmPushSender } from '../src/modules/notifications/fcm-push-sender.js';
import type { PushMessage } from '../src/modules/notifications/push-delivery.js';

const user: AuthenticatedUser = {
  id: '90000000-0000-4000-8000-000000000001',
  displayName: 'Push Tester',
  birthDate: null,
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  profile: null,
};
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: false };
  },
};
const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    return { user, created: false };
  },
  async findFirebaseUser() {
    return user;
  },
};
const app = buildApp({
  logger: false,
  auth: { tokenVerifier, repository: authRepository },
});

beforeAll(async () => app.ready());
afterAll(async () => app.close());

function message(index: number): PushMessage {
  return {
    token: `device-token-${index}`,
    title: 'New trip message',
    data: { notificationId: `n-${index}`, type: 'MESSAGE_RECEIVED' },
  };
}

describe('FCM push sender', () => {
  it('splits large batches into requests of at most 500 messages', async () => {
    const requests: Message[][] = [];
    const sender = createFcmPushSender({
      async sendEach(messages) {
        requests.push(messages);
        return {
          responses: messages.map(() => ({ success: true, messageId: 'id' })),
          successCount: messages.length,
          failureCount: 0,
        } as BatchResponse;
      },
    });

    const results = await sender.send(
      Array.from({ length: 501 }, (_, index) => message(index)),
    );

    expect(requests.map((request) => request.length)).toEqual([500, 1]);
    expect(results).toHaveLength(501);
    expect(results.every((result) => result === 'sent')).toBe(true);
    expect(requests[0]?.[0]).toMatchObject({
      token: 'device-token-0',
      notification: { title: 'New trip message' },
      data: { notificationId: 'n-0', type: 'MESSAGE_RECEIVED' },
    });
  });

  it('reports dead tokens separately from other failures', async () => {
    const sender = createFcmPushSender({
      async sendEach() {
        return {
          responses: [
            { success: true, messageId: 'id' },
            {
              success: false,
              error: { code: 'messaging/registration-token-not-registered' },
            },
            {
              success: false,
              error: { code: 'messaging/invalid-registration-token' },
            },
            { success: false, error: { code: 'messaging/internal-error' } },
          ],
          successCount: 1,
          failureCount: 3,
        } as BatchResponse;
      },
    });

    await expect(
      sender.send([message(0), message(1), message(2), message(3)]),
    ).resolves.toEqual(['sent', 'invalid_token', 'invalid_token', 'failed']);
  });

  it('raises Firebase setup errors instead of counting failed sends', async () => {
    const sender = createFcmPushSender({
      async sendEach(messages) {
        return {
          responses: messages.map(() => ({
            success: false,
            error: { code: 'app/invalid-credential' },
          })),
          successCount: 0,
          failureCount: messages.length,
        } as BatchResponse;
      },
    });

    await expect(sender.send([message(0), message(1)])).rejects.toThrow(
      'app/invalid-credential',
    );
  });
});

describe('push device routes', () => {
  it('requires authentication to register a device', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/push-devices',
      payload: { token: 'a'.repeat(40), platform: 'WEB' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects malformed tokens and unknown platforms', async () => {
    for (const payload of [
      { token: 'short', platform: 'WEB' },
      { token: `${'a'.repeat(40)} <script>`, platform: 'WEB' },
      { token: 'a'.repeat(40), platform: 'DESKTOP' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/me/push-devices',
        headers: { authorization: 'Bearer push-tester' },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
