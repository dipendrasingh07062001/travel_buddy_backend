import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const run = randomUUID();
const roles = ['owner', 'rejoiner', 'racer', 'declined'] as const;
type Role = (typeof roles)[number];
const userIds = {} as Record<Role, string>;
const communityId = randomUUID();
let tripId = '';

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: `rejoin-${token}-${run}`,
      displayName: `Rejoin ${token}`,
      emailVerified: false,
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });

function api(
  method: 'GET' | 'POST',
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

const askToJoin = (role: Role) =>
  api('POST', `/trips/${tripId}/connection-requests`, role, {
    message: 'I would like to travel with your group on these dates.',
  });

async function join(role: Role) {
  const requested = await askToJoin(role);
  expect(requested.statusCode).toBe(201);
  const requestId = requested.json().data.id as string;
  const accepted = await api(
    'POST',
    `/connection-requests/${requestId}/accept`,
    'owner',
  );
  expect(accepted.statusCode).toBe(200);
  return requestId;
}

const membership = (role: Role) =>
  database.tripMembership.findMany({
    where: { tripId, userId: userIds[role] },
  });

beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: `rejoin-${communityId}`,
      name: 'Rejoin Integration Community',
      region: 'Himachal Pradesh',
    },
  });
  await app.ready();
  for (const role of roles) {
    const response = await api('POST', '/auth/bootstrap', role);
    userIds[role] = response.json().data.id as string;
    await database.user.update({
      where: { id: userIds[role] },
      data: {
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Integration profile for re-joining trips.',
            languages: ['english'],
          },
        },
      },
    });
  }

  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const created = await api('POST', '/trips', 'owner', {
    communityId,
    originCity: 'Delhi',
    startDate: day(30),
    endDate: day(35),
    currentGroupSize: 1,
    desiredGroupSize: 5,
    transport: 'BUS',
    description: 'Published trip for the re-join integration workflow.',
  });
  expect(created.statusCode).toBe(201);
  tripId = created.json().data.id as string;
  const published = await api('POST', `/trips/${tripId}/publish`, 'owner', {
    expectedVersion: 1,
    confirmsPersonalPlan: true,
  });
  expect(published.statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({ where: { id: tripId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({
    where: { id: { in: Object.values(userIds) } },
  });
  await database.$disconnect();
});

describe('asking to join a trip again', () => {
  it('lets a member who left ask again and restores their membership when accepted', async () => {
    const firstRequestId = await join('rejoiner');

    const whileMember = await askToJoin('rejoiner');
    expect(whileMember.statusCode).toBe(409);
    expect(whileMember.json().error.code).toBe('ALREADY_TRIP_MEMBER');

    const left = await api('POST', `/trips/${tripId}/leave`, 'rejoiner');
    expect(left.statusCode).toBe(204);

    const again = await askToJoin('rejoiner');
    expect(again.statusCode).toBe(201);
    const secondRequestId = again.json().data.id as string;
    expect(secondRequestId).not.toBe(firstRequestId);

    const duplicate = await askToJoin('rejoiner');
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('CONNECTION_REQUEST_EXISTS');

    const accepted = await api(
      'POST',
      `/connection-requests/${secondRequestId}/accept`,
      'owner',
    );
    expect(accepted.statusCode).toBe(200);

    const rows = await membership('rejoiner');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'ACTIVE',
      leftAt: null,
      connectionRequestId: secondRequestId,
    });
    const members = await api('GET', `/trips/${tripId}/members`, 'rejoiner');
    expect(members.statusCode).toBe(200);
    expect(
      await database.trip.findUniqueOrThrow({
        where: { id: tripId },
        select: { currentGroupSize: true },
      }),
    ).toEqual({ currentGroupSize: 2 });
    expect(
      await database.connectionRequest.findUniqueOrThrow({
        where: { id: firstRequestId },
        select: { status: true },
      }),
    ).toEqual({ status: 'ACCEPTED' });
  });

  it('does not let a removed member ask again', async () => {
    const removed = await api(
      'POST',
      `/trips/${tripId}/members/${userIds.rejoiner}/remove`,
      'owner',
    );
    expect(removed.statusCode).toBe(204);

    const again = await askToJoin('rejoiner');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('REMOVED_FROM_TRIP');
  });

  it('does not let someone the owner declined ask again', async () => {
    const requested = await askToJoin('declined');
    const declined = await api(
      'POST',
      `/connection-requests/${requested.json().data.id}/decline`,
      'owner',
    );
    expect(declined.statusCode).toBe(200);

    const again = await askToJoin('declined');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CONNECTION_REQUEST_EXISTS');
  });

  it('keeps only one waiting request when the same person asks twice at once', async () => {
    await join('racer');
    await api('POST', `/trips/${tripId}/leave`, 'racer');

    const responses = await Promise.all([
      askToJoin('racer'),
      askToJoin('racer'),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(
      await database.connectionRequest.count({
        where: { tripId, requesterId: userIds.racer, status: 'PENDING' },
      }),
    ).toBe(1);
  });
});
