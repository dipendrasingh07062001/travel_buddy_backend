import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type {
  TripMembershipStatus,
  TripStatus,
} from '../src/generated/prisma/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { utcStartOfToday } from '../src/modules/trips/trip.types.js';

const run = randomUUID();
const subjects = {
  traveller: `memberships-traveller-${run}`,
  host: `memberships-host-${run}`,
  outsider: `memberships-outsider-${run}`,
};
type Actor = keyof typeof subjects;
const userIds = {} as Record<Actor, string>;
const communityId = randomUUID();
const archivedCommunityId = randomUUID();
const tripIds: string[] = [];
const extraUserIds: string[] = [];
const today = utcStartOfToday();
const date = (offset: number) =>
  new Date(today.getTime() + offset * 86_400_000);
const joinedAt = date(-20);
const fixtureMemberships: Array<{
  id: string;
  tripId: string;
  role: 'OWNER' | 'MEMBER';
  status: TripMembershipStatus;
  tripStatus: TripStatus;
}> = [];
const fixtureTrips: Record<string, string> = {};

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: subjects[token as Actor], emailVerified: false };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
function api(
  method: 'GET' | 'POST',
  path: string,
  actor: Actor = 'traveller',
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${actor}` },
    ...(payload && { payload }),
  });
}
interface MembershipItem {
  id: string;
  tripId: string;
  role: 'OWNER' | 'MEMBER';
  status: TripMembershipStatus;
  joinedAt: string;
  leftAt: string | null;
  removedAt: string | null;
  trip: {
    id: string;
    status: TripStatus;
    description: string;
    owner: { id: string; displayName: string | null };
  } | null;
}
async function list(query = '', actor: Actor = 'traveller') {
  const response = await api(
    'GET',
    `/me/trip-memberships${query ? `?${query}` : ''}`,
    actor,
  );
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  return response.json() as {
    data: MembershipItem[];
    pagination: {
      page: number;
      pageSize: number;
      totalItems: number;
      totalPages: number;
    };
  };
}

async function fixture(
  name: string,
  role: 'OWNER' | 'MEMBER' | null,
  status: TripMembershipStatus = 'ACTIVE',
  tripStatus: TripStatus = 'PUBLISHED',
  options: { archived?: boolean; moderated?: boolean; ownerId?: string } = {},
) {
  const ownerId =
    options.ownerId ?? (role === 'OWNER' ? userIds.traveller : userIds.host);
  const tripId = randomUUID();
  const trip = await database.trip.create({
    data: {
      id: tripId,
      ownerId,
      communityId: options.archived ? archivedCommunityId : communityId,
      originCity: 'Delhi',
      startDate: date(tripStatus === 'COMPLETED' ? -10 : 30),
      endDate: date(tripStatus === 'COMPLETED' ? -5 : 35),
      durationDays: 6,
      currentGroupSize: role === 'MEMBER' && status === 'ACTIVE' ? 2 : 1,
      desiredGroupSize: 5,
      status: tripStatus,
      transport: 'BUS',
      description: `Private plan for membership fixture ${name}.`,
      publishedAt: tripStatus === 'DRAFT' ? null : date(-25),
      moderationRemovedAt: options.moderated ? today : null,
      memberships: {
        create: [
          { userId: ownerId, role: 'OWNER', joinedAt },
          ...(role === 'MEMBER'
            ? [
                {
                  userId: userIds.traveller,
                  role: 'MEMBER' as const,
                  status,
                  joinedAt,
                  leftAt: status === 'LEFT' ? date(-10) : null,
                  removedAt: status === 'REMOVED' ? date(-10) : null,
                },
              ]
            : []),
        ],
      },
      conversation: {
        create: {
          participants: {
            create: [
              { userId: ownerId },
              ...(role === 'MEMBER' && status === 'ACTIVE'
                ? [{ userId: userIds.traveller }]
                : []),
            ],
          },
        },
      },
    },
    include: { memberships: { where: { userId: userIds.traveller } } },
  });
  tripIds.push(tripId);
  fixtureTrips[name] = tripId;
  const membership = trip.memberships[0];
  if (membership)
    fixtureMemberships.push({
      id: membership.id,
      tripId,
      role: membership.role,
      status: membership.status,
      tripStatus,
    });
  return tripId;
}

beforeAll(async () => {
  await app.ready();
  for (const actor of Object.keys(subjects) as Actor[]) {
    const response = await api('POST', '/auth/bootstrap', actor);
    expect(response.statusCode).toBe(201);
    userIds[actor] = response.json().data.id as string;
    await database.user.update({
      where: { id: userIds[actor] },
      data: {
        displayName: `Membership ${actor}`,
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Membership integration traveller profile.',
            languages: ['english'],
          },
        },
      },
    });
  }
  for (const id of [communityId, archivedCommunityId]) {
    await database.community.create({
      data: { id, slug: `memberships-${id}`, name: 'Membership destination' },
    });
  }
  await fixture('ownDraft', 'OWNER', 'ACTIVE', 'DRAFT');
  await fixture('ownPublished', 'OWNER');
  for (const status of [
    'PUBLISHED',
    'PAUSED',
    'FULL',
    'COMPLETED',
    'CANCELLED',
  ] as const) {
    await fixture(`joined${status}`, 'MEMBER', 'ACTIVE', status);
  }
  await fixture('archived', 'MEMBER', 'ACTIVE', 'PUBLISHED', {
    archived: true,
  });
  await fixture('moderated', 'MEMBER', 'ACTIVE', 'PUBLISHED', {
    moderated: true,
  });
  const disabledOwner = await database.user.create({
    data: { displayName: null, status: 'SUSPENDED' },
  });
  extraUserIds.push(disabledOwner.id);
  await fixture('disabledOwner', 'MEMBER', 'ACTIVE', 'PUBLISHED', {
    ownerId: disabledOwner.id,
  });
  await fixture('left', 'MEMBER', 'LEFT');
  await fixture('removed', 'MEMBER', 'REMOVED');
  await fixture('foreignDraft', null, 'ACTIVE', 'DRAFT');
  const requestOnlyTrip = await fixture('requestsOnly', null);
  for (const status of [
    'PENDING',
    'DECLINED',
    'WITHDRAWN',
    'BLOCKED',
  ] as const) {
    await database.connectionRequest.create({
      data: {
        tripId: requestOnlyTrip,
        requesterId: userIds.traveller,
        recipientId: userIds.host,
        status,
        message: 'A request alone must never grant membership discovery.',
      },
    });
  }
  await database.community.update({
    where: { id: archivedCommunityId },
    data: { status: 'ARCHIVED' },
  });
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({ where: { id: { in: tripIds } } });
  await database.community.deleteMany({
    where: { id: { in: [communityId, archivedCommunityId] } },
  });
  await database.user.deleteMany({
    where: { id: { in: [...Object.values(userIds), ...extraUserIds] } },
  });
  await database.$disconnect();
});

describe('private trip membership discovery', () => {
  it("returns only the caller's active created/joined trips with stable tie ordering", async () => {
    const body = await list();
    const expected = fixtureMemberships
      .filter((item) => item.status === 'ACTIVE')
      .map((item) => item.id)
      .sort();
    expect(body.data.map((item) => item.id)).toEqual(expected);
    expect(body.pagination.totalItems).toBe(expected.length);
    expect(body.data.every((item) => item.trip?.id === item.tripId)).toBe(true);
    expect(
      body.data.find((item) => item.tripId === fixtureTrips.ownDraft)?.trip
        ?.status,
    ).toBe('DRAFT');
    const other = await list('', 'outsider');
    expect(other.data).toEqual([]);
    expect(other.pagination.totalItems).toBe(0);
  });

  it('filters created and joined memberships without duplicate owner rows', async () => {
    for (const role of ['OWNER', 'MEMBER'] as const) {
      const body = await list(`role=${role}`);
      expect(body.data.map((item) => item.id)).toEqual(
        fixtureMemberships
          .filter((item) => item.status === 'ACTIVE' && item.role === role)
          .map((item) => item.id)
          .sort(),
      );
      expect(new Set(body.data.map((item) => item.tripId)).size).toBe(
        body.data.length,
      );
    }
  });

  it('orders newer joins before UUID ties and applies that order before pagination', async () => {
    const chosen = fixtureMemberships.find(
      (item) => item.tripId === fixtureTrips.joinedPUBLISHED,
    )!;
    await database.tripMembership.update({
      where: { id: chosen.id },
      data: { joinedAt: date(-1) },
    });
    try {
      const first = await list('pageSize=1');
      expect(first.data.map((item) => item.id)).toEqual([chosen.id]);
      expect(first.pagination.totalItems).toBe(
        fixtureMemberships.filter((item) => item.status === 'ACTIVE').length,
      );
      const second = await list('pageSize=1&page=2');
      const remaining = fixtureMemberships
        .filter((item) => item.status === 'ACTIVE' && item.id !== chosen.id)
        .map((item) => item.id)
        .sort();
      expect(second.data.map((item) => item.id)).toEqual(remaining.slice(0, 1));
    } finally {
      await database.tripMembership.update({
        where: { id: chosen.id },
        data: { joinedAt },
      });
    }
  });

  it.each([
    'DRAFT',
    'PUBLISHED',
    'PAUSED',
    'FULL',
    'COMPLETED',
    'CANCELLED',
  ] as const)(
    'filters active memberships by %s trip status',
    async (status) => {
      const body = await list(`tripStatus=${status}`);
      const expected = fixtureMemberships
        .filter(
          (item) => item.status === 'ACTIVE' && item.tripStatus === status,
        )
        .map((item) => item.id)
        .sort();
      expect(body.data.map((item) => item.id)).toEqual(expected);
      expect(body.pagination.totalItems).toBe(expected.length);
    },
  );

  it('keeps private access independent of public discovery visibility', async () => {
    const body = await list('role=MEMBER');
    for (const name of [
      'joinedPAUSED',
      'joinedCOMPLETED',
      'joinedCANCELLED',
      'archived',
      'moderated',
      'disabledOwner',
    ]) {
      expect(
        body.data.find((item) => item.tripId === fixtureTrips[name])?.trip,
      ).toMatchObject({ id: fixtureTrips[name] });
    }
    expect(
      body.data.find((item) => item.tripId === fixtureTrips.disabledOwner)?.trip
        ?.owner.displayName,
    ).toBeNull();
    expect(
      (await api('GET', `/trips/${fixtureTrips.moderated}`)).statusCode,
    ).toBe(404);
    expect(
      (await api('GET', `/trips/${fixtureTrips.foreignDraft}`)).statusCode,
    ).toBe(404);
  });

  it('returns former-membership facts without any fresh trip data or room access', async () => {
    await database.trip.update({
      where: { id: fixtureTrips.left! },
      data: {
        description: 'A fresh private plan written after the traveller left.',
        status: 'PAUSED',
      },
    });
    const history = await list('view=history');
    expect(history.data.map((item) => item.id)).toEqual(
      fixtureMemberships
        .filter((item) => item.status !== 'ACTIVE')
        .map((item) => item.id)
        .sort(),
    );
    expect(history.data.map((item) => item.status).sort()).toEqual([
      'LEFT',
      'REMOVED',
    ]);
    for (const item of history.data) {
      expect(item.trip).toBeNull();
      expect(Object.keys(item).sort()).toEqual(
        [
          'id',
          'tripId',
          'role',
          'status',
          'joinedAt',
          'leftAt',
          'removedAt',
          'trip',
        ].sort(),
      );
      expect((await api('GET', `/trips/${item.tripId}/room`)).statusCode).toBe(
        404,
      );
      const memberList = await api('GET', `/trips/${item.tripId}/members`);
      expect(memberList.statusCode).toBe(403);
      expect(memberList.json().error.code).toBe('TRIP_MEMBERSHIP_REQUIRED');
      expect(
        (await api('GET', `/trips/${item.tripId}/messages`)).statusCode,
      ).toBe(404);
      expect(
        (await api('GET', `/trips/${item.tripId}/expenses`)).statusCode,
      ).toBe(404);
    }
    expect((await list('view=history&role=OWNER')).data).toEqual([]);
  });

  it('does not leak former-trip state through status filters or totals', async () => {
    for (const view of ['history', 'all']) {
      expect(
        (
          await api(
            'GET',
            `/me/trip-memberships?view=${view}&tripStatus=PAUSED`,
          )
        ).statusCode,
      ).toBe(400);
    }
    const body = await list('view=all');
    expect(body.pagination.totalItems).toBe(fixtureMemberships.length);
    expect(body.data.filter((item) => item.trip === null)).toHaveLength(2);
  });

  it('paginates consistently and preserves totals on empty pages', async () => {
    const expected = fixtureMemberships.map((item) => item.id).sort();
    const ids: string[] = [];
    const pages = Math.ceil(expected.length / 3);
    for (let page = 1; page <= pages; page++) {
      const body = await list(`view=all&page=${page}&pageSize=3`);
      ids.push(...body.data.map((item) => item.id));
      expect(body.pagination).toEqual({
        page,
        pageSize: 3,
        totalItems: expected.length,
        totalPages: pages,
      });
    }
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(expected.length);
    const empty = await list('view=all&page=999&pageSize=3');
    expect(empty.data).toEqual([]);
    expect(empty.pagination.totalItems).toBe(expected.length);
    const farPage = await list('view=all&page=9007199254740991&pageSize=1');
    expect(farPage.data).toEqual([]);
    expect(farPage.pagination.totalItems).toBe(expected.length);
  });

  it('does not grant discovery access through requests or an injected userId', async () => {
    const body = await list(`view=all&userId=${userIds.host}`);
    expect(body.data.map((item) => item.tripId)).not.toContain(
      fixtureTrips.requestsOnly,
    );
    expect(body.data.map((item) => item.tripId)).not.toContain(
      fixtureTrips.foreignDraft,
    );
    expect(
      (await list(`userId=${userIds.traveller}`, 'outsider')).data,
    ).toEqual([]);
  });

  it('preserves the existing created-trips response contract', async () => {
    const response = await api('GET', '/me/trips');
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .data.map((item: { id: string }) => item.id)
        .sort(),
    ).toEqual([fixtureTrips.ownDraft, fixtureTrips.ownPublished].sort());
    for (const item of response.json().data) {
      expect(item).toHaveProperty('version');
      expect(item).not.toHaveProperty('membership');
    }
  });

  it('tracks real acceptance, leave, re-join and removal without granting historical access', async () => {
    const trip = await api('POST', '/trips', 'host', {
      communityId,
      originCity: 'Delhi',
      startDate: date(40).toISOString().slice(0, 10),
      endDate: date(45).toISOString().slice(0, 10),
      desiredGroupSize: 5,
      description: 'Lifecycle integration trip for membership discovery.',
    });
    expect(trip.statusCode).toBe(201);
    const id = trip.json().data.id as string;
    tripIds.push(id);
    expect(
      (
        await api('POST', `/trips/${id}/publish`, 'host', {
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    const join = async () => {
      const request = await api(
        'POST',
        `/trips/${id}/connection-requests`,
        'traveller',
        { message: 'I would like to join this trip and discuss the plan.' },
      );
      expect(request.statusCode).toBe(201);
      expect(
        (
          await api(
            'POST',
            `/connection-requests/${request.json().data.id}/accept`,
            'host',
          )
        ).statusCode,
      ).toBe(200);
    };
    await join();
    const original = (await list()).data.find((item) => item.tripId === id)!;
    expect(original.trip?.id).toBe(id);
    expect((await api('POST', `/trips/${id}/leave`)).statusCode).toBe(204);
    expect((await list()).data.some((item) => item.tripId === id)).toBe(false);
    expect(
      (await list('view=history')).data.find((item) => item.tripId === id),
    ).toMatchObject({ id: original.id, status: 'LEFT', trip: null });
    await join();
    expect(
      (await list()).data.find((item) => item.tripId === id),
    ).toMatchObject({
      id: original.id,
      status: 'ACTIVE',
      leftAt: null,
      trip: { id },
    });
    expect(
      (await list('view=all')).data.filter((item) => item.tripId === id),
    ).toHaveLength(1);
    expect(
      (
        await api(
          'POST',
          `/trips/${id}/members/${userIds.traveller}/remove`,
          'host',
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await list('view=history')).data.find((item) => item.tripId === id),
    ).toMatchObject({ id: original.id, status: 'REMOVED', trip: null });
    expect((await api('GET', `/trips/${id}/room`)).statusCode).toBe(404);
  });
});
