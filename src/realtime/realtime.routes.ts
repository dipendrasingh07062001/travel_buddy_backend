import { PassThrough } from 'node:stream';

import type { FastifyInstance } from 'fastify';

import { AppError } from '../errors/app-error.js';
import { authenticateRequest } from '../modules/auth/auth.service.js';
import type { AuthRouteDependencies } from '../modules/auth/auth.types.js';
import type { RealtimeHub, RealtimeSubscriber } from './realtime-hub.js';

export interface RealtimeStreamSettings {
  heartbeatMs: number;
  // Streams end after this so a revoked token or a suspended account cannot
  // keep receiving events; the client reconnects with a fresh token.
  maximumLifetimeMs: number;
  maximumStreamsPerUser: number;
  // A client that stops reading is disconnected instead of buffering forever.
  maximumBufferedBytes: number;
}

export const defaultStreamSettings: RealtimeStreamSettings = {
  heartbeatMs: 25_000,
  maximumLifetimeMs: 60 * 60 * 1000,
  maximumStreamsPerUser: 5,
  maximumBufferedBytes: 1024 * 1024,
};

export async function registerRealtimeRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  hub: RealtimeHub,
  settings: RealtimeStreamSettings = defaultStreamSettings,
): Promise<void> {
  app.get(
    '/realtime/stream',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Realtime'],
        summary: 'Receive live chat and notification events',
        description:
          'A Server-Sent Events stream for the signed-in account. Events: ready, message.created, message.updated, message.deleted (data: { tripId, message }), notifications.changed, and resync. Send the Firebase ID token in the Authorization header. Refetch the open room and the unread count after ready and resync, because events missed while disconnected are not replayed. The server ends each stream after at most 60 minutes.',
        produces: ['text/event-stream'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      if (hub.connectionCount(user.id) >= settings.maximumStreamsPerUser) {
        throw new AppError(
          429,
          'REALTIME_STREAM_LIMIT',
          `An account can keep at most ${settings.maximumStreamsPerUser} live streams open.`,
        );
      }

      const stream = new PassThrough();
      let closed = false;
      const subscriber: RealtimeSubscriber = {
        userId: user.id,
        send(event, data) {
          if (closed) return;
          if (stream.writableLength > settings.maximumBufferedBytes) {
            subscriber.close();
            return;
          }
          stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        close() {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          clearTimeout(lifetime);
          hub.remove(subscriber);
          stream.end();
        },
      };
      const heartbeat = setInterval(() => {
        if (!closed) stream.write(': ping\n\n');
      }, settings.heartbeatMs);
      const lifetime = setTimeout(
        () => subscriber.close(),
        settings.maximumLifetimeMs,
      );
      reply.raw.on('close', () => subscriber.close());

      hub.add(subscriber);
      stream.write('retry: 5000\n\n');
      subscriber.send('ready', {
        heartbeatSeconds: settings.heartbeatMs / 1000,
        maximumLifetimeSeconds: settings.maximumLifetimeMs / 1000,
      });

      return (
        reply
          .header('content-type', 'text/event-stream; charset=utf-8')
          .header('cache-control', 'no-cache, no-transform')
          // Stops nginx and similar proxies from buffering the stream.
          .header('x-accel-buffering', 'no')
          .send(stream)
      );
    },
  );
}
