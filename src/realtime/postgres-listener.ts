import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';

import { postgresConnectionString } from '../database/connection-settings.js';
import {
  parseRealtimeEvent,
  realtimeChannel,
  type RealtimeEvent,
} from './realtime-events.js';

export interface RealtimeListener {
  stop(): Promise<void>;
}

export interface RealtimeListenerOptions {
  onEvent(event: RealtimeEvent): void;
  // Called after a reconnect, when events may have been missed.
  onReconnect(): void;
  logger: FastifyBaseLogger;
  initialRetryMs?: number;
  maximumRetryMs?: number;
}

// Holds one dedicated connection that LISTENs for realtime events, so every
// API instance hears every committed change. LISTEN needs a direct database
// connection; it does not work through a transaction-mode pooler (PgBouncer).
export function startRealtimeListener(
  databaseUrl: string,
  options: RealtimeListenerOptions,
): RealtimeListener {
  const initialRetryMs = options.initialRetryMs ?? 1_000;
  const maximumRetryMs = options.maximumRetryMs ?? 30_000;
  const connectionString = postgresConnectionString(databaseUrl);
  if (new URL(databaseUrl).searchParams.get('pgbouncer') === 'true') {
    options.logger.warn(
      'DATABASE_URL points at PgBouncer; realtime events need a direct connection',
    );
  }

  let stopped = false;
  let client: pg.Client | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryMs = initialRetryMs;
  let connectedBefore = false;

  const scheduleReconnect = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, maximumRetryMs);
  };

  const connect = async () => {
    const next = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 10_000,
      application_name: 'travel-buddy-realtime',
    });
    next.on('notification', (message) => {
      if (message.channel !== realtimeChannel || !message.payload) return;
      const event = parseRealtimeEvent(message.payload);
      if (event) options.onEvent(event);
    });
    next.on('error', (error) => {
      options.logger.warn({ err: error }, 'Realtime listener connection lost');
    });
    next.on('end', () => {
      if (client === next) client = undefined;
      scheduleReconnect();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${realtimeChannel}`);
    } catch (error) {
      options.logger.warn(
        { err: error },
        'Realtime listener could not connect',
      );
      await next.end().catch(() => undefined);
      scheduleReconnect();
      return;
    }
    if (stopped) {
      await next.end().catch(() => undefined);
      return;
    }
    client = next;
    retryMs = initialRetryMs;
    if (connectedBefore) {
      options.logger.info('Realtime listener reconnected');
      options.onReconnect();
    }
    connectedBefore = true;
  };

  void connect();
  return {
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      await client?.end().catch(() => undefined);
    },
  };
}
