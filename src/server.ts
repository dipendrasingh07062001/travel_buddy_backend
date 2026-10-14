import { buildApp } from './app.js';
import { env } from './config/env.js';
import { database } from './database/client.js';
import {
  startAccountErasure,
  type AccountErasureWorker,
} from './modules/account-deletion/account-erasure.js';
import { firebaseSignInAccounts } from './modules/auth/firebase-sign-in-accounts.js';
import { createFcmPushSender } from './modules/notifications/fcm-push-sender.js';
import {
  startRealtimeListener,
  type RealtimeListener,
} from './realtime/postgres-listener.js';
import { RealtimeHub } from './realtime/realtime-hub.js';
import {
  startPushDelivery,
  type PushDeliveryWorker,
} from './modules/notifications/push-delivery.js';
import { configuredObjectStorage } from './storage/object-storage.js';

const realtime = new RealtimeHub();
const app = buildApp({ realtime });
let pushDelivery: PushDeliveryWorker | undefined;
let realtimeListener: RealtimeListener | undefined;
let accountErasure: AccountErasureWorker | undefined;

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down');

  try {
    await pushDelivery?.stop();
    await accountErasure?.stop();
    await realtimeListener?.stop();
    // Live streams end first (see buildApp). In-flight requests get a few
    // seconds; then connections that never sent a request, which browsers
    // and HTTP clients keep open, are closed instead of delaying shutdown.
    const forceClose = setTimeout(
      () => app.server.closeAllConnections(),
      8_000,
    );
    await app.close();
    clearTimeout(forceClose);
    await database.$disconnect();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  realtimeListener = startRealtimeListener(env.DATABASE_URL, {
    onEvent: (event) => realtime.dispatch(event),
    onReconnect: () => realtime.broadcast('resync'),
    logger: app.log,
  });
  if (env.PUSH_NOTIFICATIONS_ENABLED) {
    pushDelivery = startPushDelivery(createFcmPushSender(), app.log);
  }
  accountErasure = startAccountErasure({
    storage: configuredObjectStorage(),
    signInAccounts: firebaseSignInAccounts,
    logger: app.log,
  });
} catch (error) {
  app.log.fatal({ err: error }, 'API failed to start');
  await database.$disconnect();
  process.exit(1);
}
