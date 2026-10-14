import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import {
  startRealtimeListener,
  type RealtimeListener,
} from '../src/realtime/postgres-listener.js';
import { RealtimeHub } from '../src/realtime/realtime-hub.js';

const run = randomUUID();
const roles = ['owner', 'member', 'blocker', 'outsider'] as const;
type Role = (typeof roles)[number];
const userIds = {} as Record<Role, string>;
const communityId = randomUUID();
const tripId = randomUUID();

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: `realtime-${token}-${run}`, emailVerified: false };
  },
};
const hub = new RealtimeHub();
const app = buildApp({
  logger: false,
  auth: { tokenVerifier },
  realtime: hub,
  realtimeStreams: {
    heartbeatMs: 200,
    maximumLifetimeMs: 60_000,
    maximumStreamsPerUser: 2,
    maximumBufferedBytes: 1024 * 1024,
  },
});
let listener: RealtimeListener;
let baseUrl: string;

interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

async function openStream(role: Role) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/v1/realtime/stream`, {
    headers: { authorization: `Bearer ${role}` },
    signal: controller.signal,
  });
  const events: StreamEvent[] = [];
  let comments = 0;
  let ended = false;
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (block.startsWith(':')) comments += 1;
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data) events.push({ event, data: JSON.parse(data) });
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Aborted by the test.
      } finally {
        ended = true;
      }
    })();
  }
  return {
    response,
    events,
    heartbeats: () => comments,
    ended: () => ended,
    close: () => controller.abort(),
    async waitFor(predicate: (event: StreamEvent) => boolean) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const match = events.find(predicate);
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for a realtime event');
    },
  };
}

function api(
  method: 'POST' | 'PATCH' | 'DELETE',
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

// Waits until every committed event has reached the hub and been delivered.
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await hub.idle();
}

beforeAll(async () => {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  baseUrl = `http://127.0.0.1:${address.port}`;
  listener = startRealtimeListener(process.env.DATABASE_URL ?? '', {
    onEvent: (event) => hub.dispatch(event),
    onReconnect: () => hub.broadcast('resync'),
    logger: app.log,
    initialRetryMs: 100,
  });

  for (const role of roles) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: { authorization: `Bearer ${role}` },
    });
    userIds[role] = response.json().data.id as string;
  }
  await database.community.create({
    data: {
      id: communityId,
      slug: `realtime-${communityId}`,
      name: 'Realtime Community',
    },
  });
  await database.trip.create({
    data: {
      id: tripId,
      ownerId: userIds.owner,
      communityId,
      originCity: 'Delhi',
      startDate: new Date('2027-04-01T00:00:00.000Z'),
      endDate: new Date('2027-04-05T00:00:00.000Z'),
      durationDays: 5,
      currentGroupSize: 3,
      desiredGroupSize: 5,
      description: 'Trip for realtime integration testing.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      memberships: {
        create: [
          { userId: userIds.owner, role: 'OWNER' },
          { userId: userIds.member, role: 'MEMBER' },
          { userId: userIds.blocker, role: 'MEMBER' },
        ],
      },
      conversation: {
        create: {
          participants: {
            create: [
              { userId: userIds.owner },
              { userId: userIds.member },
              { userId: userIds.blocker },
            ],
          },
        },
      },
    },
  });
  await database.userBlock.create({
    data: { blockerId: userIds.blocker, blockedId: userIds.owner },
  });
  // Give the listener time to connect before any test publishes events.
  await new Promise((resolve) => setTimeout(resolve, 500));
});

afterAll(async () => {
  await listener.stop();
  const closing = app.close();
  // fetch keeps spare connections that never send a request; they would hold
  // the server open until Node's header timeout.
  app.server.closeAllConnections();
  await closing;
  await database.trip.deleteMany({ where: { id: tripId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.userBlock.deleteMany({
    where: { blockerId: userIds.blocker },
  });
  await database.user.deleteMany({
    where: { id: { in: Object.values(userIds) } },
  });
  await database.$disconnect();
});

describe('realtime stream', () => {
  it('requires authentication', async () => {
    const response = await fetch(`${baseUrl}/api/v1/realtime/stream`);
    expect(response.status).toBe(401);
  });

  it('delivers chat events to members only, respecting blocks', async () => {
    const member = await openStream('member');
    const ownerOtherDevice = await openStream('owner');
    const blocker = await openStream('blocker');
    const outsider = await openStream('outsider');
    try {
      expect(member.response.headers.get('content-type')).toBe(
        'text/event-stream; charset=utf-8',
      );
      await member.waitFor((event) => event.event === 'ready');

      const sent = await api('POST', `/trips/${tripId}/messages`, 'owner', {
        body: 'Bus leaves at 6 am from Kashmere Gate.',
      });
      expect(sent.statusCode).toBe(201);
      const messageId = sent.json().data.id as string;

      const created = await member.waitFor(
        (event) => event.event === 'message.created',
      );
      expect(created.data).toMatchObject({
        tripId,
        message: {
          id: messageId,
          body: 'Bus leaves at 6 am from Kashmere Gate.',
          isOwn: false,
          sender: { id: userIds.owner },
        },
      });
      const own = await ownerOtherDevice.waitFor(
        (event) => event.event === 'message.created',
      );
      expect(own.data).toMatchObject({ message: { isOwn: true } });
      await member.waitFor((event) => event.event === 'notifications.changed');

      await api('PATCH', `/messages/${messageId}`, 'owner', {
        body: 'Bus leaves at 6:30 am from Kashmere Gate.',
      });
      const updated = await member.waitFor(
        (event) => event.event === 'message.updated',
      );
      expect(updated.data).toMatchObject({
        message: {
          status: 'EDITED',
          body: 'Bus leaves at 6:30 am from Kashmere Gate.',
        },
      });

      await api('DELETE', `/messages/${messageId}`, 'owner');
      const deleted = await member.waitFor(
        (event) => event.event === 'message.deleted',
      );
      expect(deleted.data).toMatchObject({
        message: { id: messageId, status: 'DELETED', body: null },
      });

      await settle();
      for (const stream of [blocker, outsider]) {
        expect(
          stream.events.filter((event) => event.event.startsWith('message.')),
        ).toEqual([]);
      }
    } finally {
      for (const stream of [member, ownerOtherDevice, blocker, outsider]) {
        stream.close();
      }
    }
  });

  it('publishes nothing for a change that fails', async () => {
    const member = await openStream('member');
    try {
      await member.waitFor((event) => event.event === 'ready');
      const rejected = await api(
        'POST',
        `/trips/${tripId}/messages`,
        'outsider',
        { body: 'I am not a member of this trip.' },
      );
      expect(rejected.statusCode).toBe(404);
      await settle();
      expect(member.events.filter((event) => event.event !== 'ready')).toEqual(
        [],
      );
    } finally {
      member.close();
    }
  });

  it('sends heartbeats and limits open streams per account', async () => {
    const first = await openStream('outsider');
    const second = await openStream('outsider');
    const third = await openStream('outsider');
    try {
      expect(third.response.status).toBe(429);
      expect((await third.response.json()).error.code).toBe(
        'REALTIME_STREAM_LIMIT',
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(first.heartbeats()).toBeGreaterThan(0);
    } finally {
      for (const stream of [first, second, third]) stream.close();
    }
  });

  it('tells clients to resync after the database connection drops', async () => {
    const member = await openStream('member');
    try {
      await member.waitFor((event) => event.event === 'ready');
      await database.$executeRaw`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name = 'travel-buddy-realtime'
      `;
      await member.waitFor((event) => event.event === 'resync');

      await api('POST', `/trips/${tripId}/messages`, 'owner', {
        body: 'Still connected after the reconnect.',
      });
      await member.waitFor(
        (event) =>
          event.event === 'message.created' &&
          (event.data.message as { body: string }).body ===
            'Still connected after the reconnect.',
      );
    } finally {
      member.close();
    }
  });

  it('ends open streams when the server shuts down', async () => {
    const member = await openStream('member');
    await member.waitFor((event) => event.event === 'ready');
    hub.closeAll();
    for (let attempt = 0; attempt < 40 && !member.ended(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(member.ended()).toBe(true);
    expect(hub.connectionCount(userIds.member)).toBe(0);
  });
});
