import { getMessaging, type Messaging } from 'firebase-admin/messaging';

import { firebaseApp } from '../auth/firebase-app.js';
import type { PushSender, PushSendResult } from './push-delivery.js';

// FCM accepts at most 500 messages per sendEach call.
const maximumMessagesPerRequest = 500;

// FCM reports these when a token belongs to an uninstalled app, a cleared
// browser, or was never valid, so the device registration should be removed.
const invalidTokenCodes = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export function createFcmPushSender(
  messaging: Pick<Messaging, 'sendEach'> = getMessaging(firebaseApp()),
): PushSender {
  return {
    async send(messages) {
      const results: PushSendResult[] = [];
      for (
        let start = 0;
        start < messages.length;
        start += maximumMessagesPerRequest
      ) {
        const chunk = messages.slice(start, start + maximumMessagesPerRequest);
        const response = await messaging.sendEach(
          chunk.map((message) => ({
            token: message.token,
            notification: { title: message.title },
            data: message.data,
            android: {
              priority: 'high' as const,
              notification: { tag: message.collapseId },
            },
            apns: {
              headers: { 'apns-collapse-id': message.collapseId },
              payload: { aps: { sound: 'default' } },
            },
            webpush: { notification: { tag: message.collapseId } },
          })),
        );
        // An app/ error on every message means the server's Firebase setup is
        // wrong (usually missing credentials), not that the devices are bad.
        const setupError = response.responses.every((item) =>
          item.error?.code.startsWith('app/'),
        )
          ? response.responses[0]?.error
          : undefined;
        if (setupError) {
          throw new Error(
            `Firebase Cloud Messaging rejected the request: ${setupError.code}`,
            { cause: setupError },
          );
        }
        for (const item of response.responses) {
          results.push(
            item.success
              ? 'sent'
              : item.error && invalidTokenCodes.has(item.error.code)
                ? 'invalid_token'
                : 'failed',
          );
        }
      }
      return results;
    },
  };
}
