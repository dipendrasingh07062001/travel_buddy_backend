import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const communityId = randomUUID();
const tripId = randomUUID();
const users = {
  owner: randomUUID(),
  memberA: randomUUID(),
  memberB: randomUUID(),
  outsider: randomUUID(),
};
const subjects = Object.fromEntries(
  Object.keys(users).map((role) => [
    role,
    `notification-${role}-${randomUUID()}`,
  ]),
);
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: subjects[token] ?? 'unknown', emailVerified: false };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });

async function request(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  role: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${role}` },
    ...(payload && { payload }),
  });
}

async function notifications(role: string) {
  const result = await request('GET', '/api/v1/me/notifications', role);
  expect(result.statusCode).toBe(200);
  return result.json().data as {
    id: string;
    type: string;
    title: string;
    sourceId: string;
    readAt: string | null;
  }[];
}

beforeAll(async () => {
  await app.ready();
  await database.community.create({
    data: {
      id: communityId,
      slug: `notifications-${communityId}`,
      name: 'Notification Test Community',
    },
  });
  for (const [role, id] of Object.entries(users)) {
    await database.user.create({
      data: {
        id,
        displayName: role,
        birthDate: new Date('1995-05-20'),
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subjects[role]! },
        },
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Profile for notification integration tests.',
            languages: ['english'],
          },
        },
      },
    });
  }
  const startDate = new Date(Date.now() + 30 * 86_400_000);
  const endDate = new Date(Date.now() + 32 * 86_400_000);
  await database.trip.create({
    data: {
      id: tripId,
      ownerId: users.owner,
      communityId,
      originCity: 'Delhi',
      startDate,
      endDate,
      durationDays: 3,
      desiredGroupSize: 4,
      currentGroupSize: 2,
      description: 'Published trip for notification integration tests.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      memberships: {
        create: [
          { userId: users.owner, role: 'OWNER' },
          { userId: users.memberA, role: 'MEMBER' },
        ],
      },
      conversation: {
        create: {
          participants: {
            create: [{ userId: users.owner }, { userId: users.memberA }],
          },
        },
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({ where: { id: tripId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({
    where: { id: { in: Object.values(users) } },
  });
  await database.$disconnect();
});

describe('durable in-app notifications', () => {
  it('records events atomically and confines inbox/read actions to the recipient', async () => {
    const sent = await request(
      'POST',
      `/api/v1/trips/${tripId}/connection-requests`,
      'memberB',
      {
        message:
          'I can join on these dates and would like to discuss the plan.',
      },
    );
    expect(sent.statusCode).toBe(201);
    const connectionId = sent.json().data.id as string;
    const ownerInbox = await notifications('owner');
    expect(ownerInbox).toMatchObject([
      {
        type: 'CONNECTION_REQUEST_RECEIVED',
        title: 'New connection request',
        sourceId: connectionId,
        readAt: null,
      },
    ]);
    expect(await notifications('memberB')).toHaveLength(0);
    expect(await notifications('outsider')).toHaveLength(0);
    const duplicate = await request(
      'POST',
      `/api/v1/trips/${tripId}/connection-requests`,
      'memberB',
      { message: 'This duplicate request must not make a second alert.' },
    );
    expect(duplicate.statusCode).toBe(409);
    expect(await notifications('owner')).toHaveLength(1);

    const count = await request(
      'GET',
      '/api/v1/me/notifications/unread-count',
      'owner',
    );
    expect(count.json().data.count).toBe(1);
    expect(
      (
        await request(
          'POST',
          `/api/v1/me/notifications/${ownerInbox[0]!.id}/read`,
          'memberB',
        )
      ).statusCode,
    ).toBe(404);
    const read = await request(
      'POST',
      `/api/v1/me/notifications/${ownerInbox[0]!.id}/read`,
      'owner',
    );
    expect(read.statusCode).toBe(200);
    expect(read.json().data.readAt).not.toBeNull();
    const readAgain = await request(
      'POST',
      `/api/v1/me/notifications/${ownerInbox[0]!.id}/read`,
      'owner',
    );
    expect(readAgain.json().data.readAt).toBe(read.json().data.readAt);

    const accepted = await request(
      'POST',
      `/api/v1/connection-requests/${connectionId}/accept`,
      'owner',
    );
    expect(accepted.statusCode).toBe(200);
    expect((await notifications('memberB'))[0]?.type).toBe(
      'CONNECTION_REQUEST_ACCEPTED',
    );
    const acceptedAgain = await request(
      'POST',
      `/api/v1/connection-requests/${connectionId}/accept`,
      'owner',
    );
    expect(acceptedAgain.statusCode).toBe(200);
    expect(await notifications('memberB')).toHaveLength(1);
    expect((await notifications('owner'))[0]?.readAt).not.toBeNull();

    const updatedTrip = await request(
      'PATCH',
      `/api/v1/trips/${tripId}`,
      'owner',
      {
        expectedVersion: 2,
        description:
          'The updated shared plan includes an earlier meeting point.',
      },
    );
    expect(updatedTrip.statusCode).toBe(200);
    expect((await notifications('memberA'))[0]?.type).toBe('TRIP_UPDATED');
    expect((await notifications('memberB'))[0]?.type).toBe('TRIP_UPDATED');

    const message = await request(
      'POST',
      `/api/v1/trips/${tripId}/messages`,
      'memberB',
      { body: 'Please confirm the meeting point.' },
    );
    expect(message.statusCode).toBe(201);
    expect((await notifications('owner'))[0]?.type).toBe('MESSAGE_RECEIVED');
    expect((await notifications('memberA'))[0]?.type).toBe('MESSAGE_RECEIVED');

    const muted = await request(
      'PATCH',
      `/api/v1/trips/${tripId}/room/preferences`,
      'memberA',
      { muted: true },
    );
    expect(muted.statusCode).toBe(200);
    const beforeMutedMessage = (await notifications('memberA')).length;
    const secondMessage = await request(
      'POST',
      `/api/v1/trips/${tripId}/messages`,
      'memberB',
      { body: 'A second message for unmuted members only.' },
    );
    expect(secondMessage.statusCode).toBe(201);
    expect((await notifications('memberA')).length).toBe(beforeMutedMessage);

    const expense = await request(
      'POST',
      `/api/v1/trips/${tripId}/expenses`,
      'owner',
      {
        description: 'Hotel',
        category: 'ACCOMMODATION',
        amountPaise: 3000,
        paidByUserId: users.owner,
        splitMethod: 'EQUAL',
        participants: [users.owner, users.memberA, users.memberB].map(
          (userId) => ({ userId }),
        ),
      },
    );
    expect(expense.statusCode).toBe(201);
    expect((await notifications('memberA'))[0]?.type).toBe('EXPENSE_CREATED');
    expect((await notifications('memberB'))[0]?.type).toBe('EXPENSE_CREATED');

    const pending = await request(
      'POST',
      `/api/v1/trips/${tripId}/settlements`,
      'memberA',
      { receiverId: users.owner, amountPaise: 500 },
    );
    expect(pending.statusCode).toBe(201);
    const settlementId = pending.json().data.id as string;
    expect((await notifications('owner'))[0]?.type).toBe('SETTLEMENT_PENDING');
    const confirmed = await request(
      'POST',
      `/api/v1/settlements/${settlementId}/confirm`,
      'owner',
    );
    expect(confirmed.statusCode).toBe(200);
    expect((await notifications('memberA'))[0]?.type).toBe(
      'SETTLEMENT_CONFIRMED',
    );

    const otherRequest = await request(
      'POST',
      `/api/v1/trips/${tripId}/connection-requests`,
      'outsider',
      { message: 'I would like to discuss whether I can join this trip.' },
    );
    expect(otherRequest.statusCode).toBe(201);
    const declined = await request(
      'POST',
      `/api/v1/connection-requests/${otherRequest.json().data.id}/decline`,
      'owner',
    );
    expect(declined.statusCode).toBe(200);
    expect((await notifications('outsider'))[0]?.type).toBe(
      'CONNECTION_REQUEST_DECLINED',
    );

    const unmuted = await request(
      'PATCH',
      `/api/v1/trips/${tripId}/room/preferences`,
      'memberA',
      { muted: false },
    );
    expect(unmuted.statusCode).toBe(200);
    const blocked = await request(
      'POST',
      `/api/v1/users/${users.memberB}/block`,
      'memberA',
    );
    expect(blocked.statusCode).toBe(200);
    const beforeBlockedMessage = (await notifications('memberA')).length;
    const blockedMessage = await request(
      'POST',
      `/api/v1/trips/${tripId}/messages`,
      'memberB',
      { body: 'This message should not alert the member who blocked me.' },
    );
    expect(blockedMessage.statusCode).toBe(201);
    expect((await notifications('memberA')).length).toBe(beforeBlockedMessage);

    const unread = await request(
      'GET',
      '/api/v1/me/notifications?unreadOnly=true&pageSize=2',
      'owner',
    );
    expect(unread.statusCode).toBe(200);
    expect(unread.json().data).toHaveLength(2);
    expect(unread.json().pagination.total).toBeGreaterThan(2);
    const allRead = await request(
      'POST',
      '/api/v1/me/notifications/read-all',
      'owner',
    );
    expect(allRead.statusCode).toBe(200);
    expect(allRead.json().data.updated).toBeGreaterThan(2);
    expect(
      (
        await request('GET', '/api/v1/me/notifications/unread-count', 'owner')
      ).json().data.count,
    ).toBe(0);
  });
});
