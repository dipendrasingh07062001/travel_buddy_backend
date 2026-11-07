import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

// Names carry the run id so the seed and other test files never match them.
const run = randomUUID();
const subjects = {
  owner: `custom-destination-owner-${run}`,
  member: `custom-destination-member-${run}`,
  other: `custom-destination-other-${run}`,
};
type Role = keyof typeof subjects;
const userIds = {} as Record<Role, string>;
const tripIds: string[] = [];
const communities = {
  single: { id: randomUUID(), name: `Kasol ${run}` },
  duplicateA: { id: randomUUID(), name: `Twin ${run}` },
  duplicateB: { id: randomUUID(), name: `twin ${run}` },
  mixedActive: { id: randomUUID(), name: `Mixed ${run}` },
  mixedArchived: { id: randomUUID(), name: `Mixed ${run}`, archived: true },
  archivedOnly: { id: randomUUID(), name: `Gone ${run}`, archived: true },
  other: { id: randomUUID(), name: `Other hub ${run}` },
};
const communityIds = Object.values(communities).map(({ id }) => id);
const origin = `Origin ${run}`;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: subjects[token as Role],
      displayName: `Destination ${token}`,
      emailVerified: false,
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });

function api(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  role?: Role,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    ...(role && { headers: { authorization: `Bearer ${role}` } }),
    ...(payload && { payload }),
  });
}

const day = 86_400_000;
const dateIn = (days: number) =>
  new Date(Date.now() + days * day).toISOString().slice(0, 10);

async function createTrip(destination: object, extra: object = {}) {
  const response = await api('POST', '/trips', 'owner', {
    ...destination,
    originCity: origin,
    startDate: dateIn(30),
    endDate: dateIn(34),
    desiredGroupSize: 4,
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(201);
  const id = response.json().data.id as string;
  tripIds.push(id);
  return id;
}

async function stored(id: string) {
  return database.trip.findUniqueOrThrow({
    where: { id },
    select: { communityId: true, destinationName: true, version: true },
  });
}

async function editTrip(id: string, payload: object, role: Role = 'owner') {
  const { version } = await stored(id);
  return api('PATCH', `/trips/${id}`, role, {
    expectedVersion: version,
    ...payload,
  });
}

async function publish(id: string) {
  const { version } = await stored(id);
  const response = await api('POST', `/trips/${id}/publish`, 'owner', {
    expectedVersion: version,
    confirmsPersonalPlan: true,
  });
  expect(response.statusCode, response.body).toBe(200);
}

beforeAll(async () => {
  for (const community of Object.values(communities)) {
    await database.community.create({
      data: {
        id: community.id,
        slug: `custom-destination-${community.id}`,
        name: community.name,
        region: `Region ${run}`,
        status: 'archived' in community ? 'ARCHIVED' : 'ACTIVE',
      },
    });
  }
  await app.ready();
  for (const role of Object.keys(subjects) as Role[]) {
    const response = await api('POST', '/auth/bootstrap', role);
    userIds[role] = response.json().data.id;
    await database.user.update({
      where: { id: userIds[role] },
      data: {
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Jaipur',
            biography: 'Integration profile for custom destination testing.',
            languages: ['english'],
          },
        },
      },
    });
  }
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({ where: { id: { in: tripIds } } });
  await database.community.deleteMany({ where: { id: { in: communityIds } } });
  await database.user.deleteMany({
    where: { id: { in: Object.values(userIds) } },
  });
  await database.$disconnect();
});

describe('the destination constraint', () => {
  async function insert(communityId: string | null, name: string | null) {
    const id = randomUUID();
    tripIds.push(id);
    return database.$executeRaw`
      INSERT INTO trips (id, owner_id, community_id, destination_name,
        origin_city, start_date, end_date, duration_days, desired_group_size,
        updated_at)
      VALUES (${id}::uuid, ${userIds.owner}::uuid, ${communityId}::uuid,
        ${name}, ${origin}, CURRENT_DATE + 30, CURRENT_DATE + 31, 2, 4, now())
    `;
  }

  it('accepts exactly one destination', async () => {
    await expect(insert(communities.single.id, null)).resolves.toBe(1);
    await expect(insert(null, 'Kasol')).resolves.toBe(1);
  });

  it.each([
    ['no destination', null, null],
    ['both', 'community', 'Kasol'],
    ['an empty name', null, ''],
    ['a name of spaces', null, '   '],
    ['a community with an empty name', 'community', ''],
    ['a community with a name of spaces', 'community', '  '],
  ])('rejects %s', async (_case, community, name) => {
    await expect(
      insert(community && communities.single.id, name),
    ).rejects.toThrow(/trips_destination_check/);
  });
});

describe('trips with a typed destination', () => {
  it('creates, reads, edits, publishes and lists a typed destination', async () => {
    const name = `Malana ${run}`;
    const id = await createTrip({ destinationName: name });
    const custom = {
      id: null,
      slug: null,
      name,
      region: null,
      countryCode: null,
    };
    expect(await stored(id)).toMatchObject({
      communityId: null,
      destinationName: name,
    });

    const edited = await editTrip(id, { desiredGroupSize: 5 });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data).toMatchObject({
      destination: custom,
      description: null,
    });

    await publish(id);
    const detail = await api('GET', `/trips/${id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).toMatchObject({
      destination: custom,
      description: null,
    });

    const search = await api(
      'GET',
      `/trips?origin=${encodeURIComponent(origin)}&pageSize=100`,
    );
    expect(
      search.json().data.find((trip: { id: string }) => trip.id === id),
    ).toMatchObject({ destination: custom });

    const owned = await api('GET', '/me/trips?pageSize=100', 'owner');
    expect(
      owned.json().data.find((trip: { id: string }) => trip.id === id),
    ).toMatchObject({ destination: custom });

    const memberships = await api('GET', '/me/trip-memberships', 'owner');
    expect(
      memberships
        .json()
        .data.find(
          (item: { trip: { id: string } | null }) => item.trip?.id === id,
        ).trip,
    ).toMatchObject({ destination: custom });
  });

  it('still creates and lists a trip linked by community id', async () => {
    const id = await createTrip({ communityId: communities.single.id });
    await publish(id);
    const detail = await api('GET', `/trips/${id}`);
    expect(detail.json().data.destination).toMatchObject({
      id: communities.single.id,
      slug: `custom-destination-${communities.single.id}`,
      name: communities.single.name,
    });
  });

  it('keeps typed destinations out of community pages and slug filters', async () => {
    const linked = await createTrip({ communityId: communities.other.id });
    const custom = await createTrip({
      destinationName: communities.other.name.replace('hub', 'place'),
    });
    await publish(linked);
    await publish(custom);
    const slug = `custom-destination-${communities.other.id}`;

    for (const url of [
      `/communities/${slug}/trips?pageSize=100`,
      `/trips?destination=${slug}&pageSize=100`,
    ]) {
      const listed = (await api('GET', url))
        .json()
        .data.map((trip: { id: string }) => trip.id);
      expect(listed).toContain(linked);
      expect(listed).not.toContain(custom);
    }
  });

  it('masks a stored unsafe name publicly and blocks republishing', async () => {
    const id = await createTrip({ destinationName: `Tosh ${run}` });
    await publish(id);
    const unsafe = 'Call 9876543210';
    await database.trip.update({
      where: { id },
      data: { destinationName: unsafe },
    });

    const detail = await api('GET', `/trips/${id}`);
    expect(detail.json().data.destination.name).not.toBe(unsafe);
    const owned = await api('GET', '/me/trips?pageSize=100', 'owner');
    expect(
      owned.json().data.find((trip: { id: string }) => trip.id === id)
        .destination.name,
    ).toBe(unsafe);

    const { version } = await stored(id);
    const paused = await api('POST', `/trips/${id}/pause`, 'owner', {
      expectedVersion: version,
    });
    expect(paused.statusCode).toBe(200);
    const republished = await api('POST', `/trips/${id}/publish`, 'owner', {
      expectedVersion: version + 1,
      confirmsPersonalPlan: true,
    });
    expect(republished.statusCode).toBe(400);
    expect(republished.json().error.code).toBe('PUBLIC_TEXT_PRIVACY_VIOLATION');
  });
});

describe('linking a typed name to a community', () => {
  const cases: Array<[string, string, string | null]> = [
    [
      'one match in another case',
      ` ${communities.single.name.toUpperCase()} `,
      communities.single.id,
    ],
    ['two active matches', `TWIN ${run}`, null],
    [
      'an active and an archived match',
      `mixed ${run}`,
      communities.mixedActive.id,
    ],
    ['only an archived match', `Gone ${run}`, null],
    ['a slug', `custom-destination-${communities.single.id}`, null],
    ['a region', `Region ${run}`, null],
    ['extra text', `${communities.single.name}, HP`, null],
    ['doubled inner spaces', `Kasol  ${run}`, null],
  ];

  it.each(cases)('on create: %s', async (_case, name, linkedId) => {
    const id = await createTrip({ destinationName: name });
    expect(await stored(id)).toMatchObject({
      communityId: linkedId,
      destinationName: linkedId ? null : name.trim(),
    });
  });

  it.each(cases)('on edit: %s', async (_case, name, linkedId) => {
    const id = await createTrip({ communityId: communities.other.id });
    const response = await editTrip(id, { destinationName: name });
    expect(response.statusCode, response.body).toBe(200);
    expect(await stored(id)).toMatchObject({
      communityId: linkedId,
      destinationName: linkedId ? null : name.trim(),
    });
  });
});

describe('changing a destination', () => {
  it('moves between linked and typed destinations', async () => {
    const id = await createTrip({ communityId: communities.single.id });

    expect(
      (await editTrip(id, { destinationName: `Tosh ${run}` })).statusCode,
    ).toBe(200);
    expect(await stored(id)).toMatchObject({
      communityId: null,
      destinationName: `Tosh ${run}`,
    });

    expect((await editTrip(id, { desiredGroupSize: 6 })).statusCode).toBe(200);
    expect(await stored(id)).toMatchObject({
      communityId: null,
      destinationName: `Tosh ${run}`,
    });

    expect(
      (await editTrip(id, { communityId: communities.single.id })).statusCode,
    ).toBe(200);
    expect(await stored(id)).toMatchObject({
      communityId: communities.single.id,
      destinationName: null,
    });
  });

  it.each([
    [
      'both fields',
      { communityId: randomUUID(), destinationName: 'Kasol' },
      'INVALID_DESTINATION',
    ],
    ['an empty name', { destinationName: '' }, 'INVALID_DESTINATION'],
    [
      'an unknown community',
      { communityId: randomUUID() },
      'INVALID_COMMUNITY',
    ],
    [
      'an archived community',
      { communityId: communities.archivedOnly.id },
      'INVALID_COMMUNITY',
    ],
  ])(
    'rejects %s and leaves the trip unchanged',
    async (_case, payload, code) => {
      const id = await createTrip({ destinationName: `Before ${run}` });
      const before = await stored(id);
      const response = await editTrip(id, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(code);
      expect(await stored(id)).toEqual(before);
    },
  );

  it.each([
    ['an unknown community', { communityId: randomUUID() }],
    ['an archived community', { communityId: communities.archivedOnly.id }],
  ])('rejects %s on create', async (_case, payload) => {
    const response = await api('POST', '/trips', 'owner', {
      ...payload,
      originCity: origin,
      startDate: dateIn(30),
      endDate: dateIn(34),
      desiredGroupSize: 4,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_COMMUNITY');
  });

  it('keeps version and owner checks', async () => {
    const id = await createTrip({ destinationName: `Checked ${run}` });
    const stale = await api('PATCH', `/trips/${id}`, 'owner', {
      expectedVersion: 99,
      destinationName: `Stale ${run}`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('TRIP_VERSION_CONFLICT');
    const forbidden = await editTrip(
      id,
      { destinationName: `Taken ${run}` },
      'other',
    );
    expect(forbidden.statusCode).toBe(403);
    expect((await stored(id)).destinationName).toBe(`Checked ${run}`);
  });

  it('tells members about every destination change and records it', async () => {
    const id = await createTrip({ communityId: communities.single.id });
    await database.tripMembership.create({
      data: { tripId: id, userId: userIds.member, role: 'MEMBER' },
    });
    await database.trip.update({
      where: { id },
      data: { currentGroupSize: 2 },
    });

    const steps: object[] = [
      { destinationName: `Tosh ${run}` },
      { destinationName: `Malana ${run}` },
      { communityId: communities.single.id },
    ];
    for (const step of steps) {
      expect((await editTrip(id, step)).statusCode).toBe(200);
    }

    const notices = await database.notification.findMany({
      where: { recipientId: userIds.member, tripId: id, type: 'TRIP_UPDATED' },
    });
    expect(notices).toHaveLength(steps.length);
    const inbox = await api('GET', '/me/notifications', 'member');
    const titles = inbox
      .json()
      .data.filter((notice: { type: string }) => notice.type === 'TRIP_UPDATED')
      .map((notice: { title: string }) => notice.title);
    expect(titles.length).toBeGreaterThanOrEqual(steps.length);
    for (const title of titles) {
      expect(title).toBe('Trip plan updated');
    }

    const history = await database.tripChange.findMany({
      where: { tripId: id, action: 'OWNER_UPDATED' },
      orderBy: { version: 'asc' },
      select: { changes: true },
    });
    expect(history.map(({ changes }) => changes)).toEqual([
      expect.objectContaining({
        communityId: { before: communities.single.id, after: null },
        destinationName: { before: null, after: `Tosh ${run}` },
      }),
      expect.objectContaining({
        destinationName: { before: `Tosh ${run}`, after: `Malana ${run}` },
      }),
      expect.objectContaining({
        communityId: { before: null, after: communities.single.id },
        destinationName: { before: `Malana ${run}`, after: null },
      }),
    ]);
    expect(history[1]!.changes).not.toHaveProperty('communityId');
  });
});
