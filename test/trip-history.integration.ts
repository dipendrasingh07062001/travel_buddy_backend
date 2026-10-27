import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { createAccountDataExport } from '../src/modules/data-export/data-export.repository.js';
import type { TripHistoryPage } from '../src/modules/trips/trip-history.repository.js';

const run = randomUUID();
const roles = ['owner', 'member', 'other', 'staff'] as const;
type Role = (typeof roles)[number];
const users = {} as Record<Role, string>;
const tripIds: string[] = [];
const communityId = randomUUID();
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: `trip-history-${run}-${token}`,
      displayName: `History ${token}`,
      emailVerified: false,
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
function api(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  role: Role = 'owner',
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${role}` },
    ...(payload && { payload }),
  });
}
const read = (id: string, role: Role = 'owner', query = '') =>
  api('GET', `/trips/${id}/history${query}`, role);
const stored = (tripId: string) =>
  database.tripChange.findMany({
    where: { tripId },
    orderBy: { version: 'asc' },
  });
async function patch(id: string, fields: object) {
  const trip = await database.trip.findUniqueOrThrow({ where: { id } });
  return api('PATCH', `/trips/${id}`, 'owner', {
    expectedVersion: trip.version,
    ...fields,
  });
}
async function create(published = false, desiredGroupSize = 4) {
  const response = await api('POST', '/trips', 'owner', {
    communityId,
    originCity: 'Delhi',
    startDate: day(40),
    endDate: day(44),
    budgetMin: 1000,
    budgetMax: 2000,
    desiredGroupSize,
    description: 'PRIVATE original narrative for the history regression.',
    transport: 'BUS',
  });
  expect(response.statusCode).toBe(201);
  const id = response.json().data.id as string;
  tripIds.push(id);
  if (published) {
    expect(
      (
        await api('POST', `/trips/${id}/publish`, 'owner', {
          expectedVersion: 1,
          confirmsPersonalPlan: true,
        })
      ).statusCode,
    ).toBe(200);
  }
  return id;
}
async function join(id: string, role: Role = 'member') {
  const request = await api('POST', `/trips/${id}/connection-requests`, role, {
    message: 'Please accept me into this travel group.',
  });
  expect(request.statusCode).toBe(201);
  const response = await api(
    'POST',
    `/connection-requests/${request.json().data.id}/accept`,
  );
  expect(response.statusCode).toBe(200);
}
beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: `history-${run}`,
      name: 'History Test Destination',
    },
  });
  await app.ready();
  for (const role of roles) {
    const response = await api('POST', '/auth/bootstrap', role);
    expect(response.statusCode).toBe(201);
    users[role] = response.json().data.id as string;
    await database.user.update({
      where: { id: users[role] },
      data: {
        staffRole: role === 'staff' ? 'ADMIN' : 'USER',
        birthDate: new Date('1995-01-01T00:00:00Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'A complete profile for history testing.',
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
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({
    where: { id: { in: Object.values(users) } },
  });
  await database.$disconnect();
});

describe('transactional, private trip history', () => {
  it('records creation and real plan edits without retaining description text', async () => {
    const id = await create();
    // Model pre-guard data without bypassing the new public API validation.
    // History must still avoid copying legacy contact details on correction.
    await database.trip.update({
      where: { id },
      data: { description: 'PRIVATE legacy email owner@example.invalid' },
    });
    expect((await read(id)).json().data[0]).toMatchObject({
      version: 1,
      action: 'CREATED',
      actor: { id: users.owner },
    });
    expect(
      (
        await patch(id, {
          startDate: day(41),
          flexibilityDays: 2,
          budgetMin: 1200.55,
          description: 'PRIVATE replacement telephone',
        })
      ).statusCode,
    ).toBe(200);
    const response = await read(id);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().data[0]).toMatchObject({
      version: 2,
      action: 'OWNER_UPDATED',
      changes: {
        startDate: { before: day(40), after: day(41) },
        durationDays: { before: 5, after: 4 },
        flexibilityDays: { before: 0, after: 2 },
        budgetMin: { before: '1000.00', after: '1200.55' },
        description: { changed: true },
      },
    });
    expect(response.body).not.toContain('PRIVATE');
    expect(JSON.stringify(await stored(id))).not.toContain('PRIVATE');
    expect(JSON.stringify(await stored(id))).not.toContain(
      'owner@example.invalid',
    );
  });

  it('does not expose drafts or published history to guests, outsiders, pending applicants or staff', async () => {
    const id = await create();
    for (const role of ['member', 'staff'] as const)
      expect((await read(id, role)).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/trips/${id}/history` }))
        .statusCode,
    ).toBe(401);
    await api('POST', `/trips/${id}/publish`, 'owner', {
      expectedVersion: 1,
      confirmsPersonalPlan: true,
    });
    await api('POST', `/trips/${id}/connection-requests`, 'member', {
      message: 'Waiting for the owner to accept my request.',
    });
    expect((await read(id, 'member')).statusCode).toBe(404);
    expect((await read(id, 'staff')).statusCode).toBe(404);
    expect((await read(randomUUID(), 'other')).statusCode).toBe(404);
  });

  it('starts member history at acceptance, revokes on leave and resets on rejoin', async () => {
    const id = await create(true);
    await patch(id, { originCity: 'Jaipur' });
    await join(id);
    const membership = await database.tripMembership.findUniqueOrThrow({
      where: { tripId_userId: { tripId: id, userId: users.member } },
    });
    expect(membership.historyFromVersion).toBe(4);
    expect(
      (await read(id, 'member'))
        .json()
        .data.map((row: { version: number }) => row.version),
    ).toEqual([4]);
    await patch(id, { originCity: 'Agra' });
    expect(
      (await read(id, 'member'))
        .json()
        .data.map((row: { version: number }) => row.version),
    ).toEqual([5, 4]);
    expect((await api('POST', `/trips/${id}/leave`, 'member')).statusCode).toBe(
      204,
    );
    expect((await read(id, 'member')).statusCode).toBe(404);
    const ownerHistory = (await read(id)).json<TripHistoryPage>();
    expect(ownerHistory.data[0]).toMatchObject({
      version: 6,
      action: 'MEMBER_LEFT',
      actor: null,
    });
    await patch(id, { originCity: 'Chandigarh' });
    await join(id);
    expect(
      (await read(id, 'member'))
        .json()
        .data.map((row: { version: number }) => row.version),
    ).toEqual([8]);
  });

  it('records becoming full and reopening after removal, without identifying the removed member', async () => {
    const id = await create(true, 2);
    await join(id);
    expect((await stored(id)).at(-1)).toMatchObject({
      action: 'MEMBER_JOINED',
      changes: {
        currentGroupSize: { before: 1, after: 2 },
        status: { before: 'PUBLISHED', after: 'FULL' },
      },
    });
    expect(
      (await api('POST', `/trips/${id}/members/${users.member}/remove`))
        .statusCode,
    ).toBe(204);
    expect((await read(id, 'member')).statusCode).toBe(404);
    const latest = (await stored(id)).at(-1)!;
    expect(latest).toMatchObject({
      action: 'MEMBER_REMOVED',
      changes: {
        currentGroupSize: { before: 2, after: 1 },
        status: { before: 'FULL', after: 'PUBLISHED' },
      },
    });
    expect(JSON.stringify(latest.changes)).not.toContain(users.member);
  });

  it('redacts blocked actors and denies a blocked owner/member relationship in either direction', async () => {
    const id = await create(true);
    await join(id);
    await join(id, 'other');
    const trip = await database.trip.findUniqueOrThrow({ where: { id } });
    await database.tripChange.create({
      data: {
        tripId: id,
        version: trip.version + 1,
        actorId: users.other,
        action: 'OWNER_UPDATED',
        changes: { flexibilityDays: { before: 0, after: 1 } },
      },
    });
    await database.trip.update({
      where: { id },
      data: { version: { increment: 1 } },
    });
    await database.userBlock.create({
      data: { blockerId: users.member, blockedId: users.other },
    });
    try {
      expect((await read(id, 'member')).json().data[0].actor).toBeNull();
      expect((await read(id)).json().data[0].actor.id).toBe(users.other);
      await database.userBlock.create({
        data: { blockerId: users.owner, blockedId: users.member },
      });
      expect((await read(id, 'member')).statusCode).toBe(404);
      await database.userBlock.deleteMany({
        where: { blockerId: users.owner, blockedId: users.member },
      });
      await database.userBlock.create({
        data: { blockerId: users.member, blockedId: users.owner },
      });
      expect((await read(id, 'member')).statusCode).toBe(404);
    } finally {
      await database.userBlock.deleteMany({
        where: { blockerId: { in: Object.values(users) } },
      });
    }
  });

  it('paginates by stable version while newer changes arrive', async () => {
    const id = await create(true);
    await patch(id, { originCity: 'Jaipur' });
    const first = (
      await read(id, 'owner', '?pageSize=2')
    ).json<TripHistoryPage>();
    expect(first.data.map((row) => row.version)).toEqual([3, 2]);
    expect(first.pagination.nextBeforeVersion).toBe(2);
    await patch(id, { originCity: 'Agra' });
    const second = (
      await read(id, 'owner', '?pageSize=2&beforeVersion=2')
    ).json<TripHistoryPage>();
    expect(second.data.map((row) => row.version)).toEqual([1]);
    expect(second.pagination.nextBeforeVersion).toBeNull();
    expect((await read(id, 'owner', '?beforeVersion=1')).json().data).toEqual(
      [],
    );
  });

  it('does not record stale, invalid or no-op edits', async () => {
    const id = await create(true);
    const stale = await api('PATCH', `/trips/${id}`, 'owner', {
      expectedVersion: 1,
      originCity: 'Jaipur',
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (await patch(id, { originCity: 'Delhi', budgetMin: 1000 })).statusCode,
    ).toBe(200);
    expect((await stored(id)).map((row) => row.version)).toEqual([1, 2]);
    await join(id);
    const before = await database.trip.findUniqueOrThrow({ where: { id } });
    const count = (await stored(id)).length;
    expect((await patch(id, { currentGroupSize: 1 })).statusCode).toBe(409);
    expect(
      (await database.trip.findUniqueOrThrow({ where: { id } })).version,
    ).toBe(before.version);
    expect((await stored(id)).length).toBe(count);
  });

  it('allows only one concurrent edit at a version and keeps its correct before/after', async () => {
    const id = await create(true);
    const responses = await Promise.all(
      ['Jaipur', 'Agra'].map((originCity) =>
        api('PATCH', `/trips/${id}`, 'owner', {
          expectedVersion: 2,
          originCity,
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const trip = await database.trip.findUniqueOrThrow({ where: { id } });
    const changes = await stored(id);
    expect(changes).toHaveLength(3);
    expect(changes[2]).toMatchObject({
      version: 3,
      changes: { originCity: { before: 'Delhi', after: trip.originCity } },
    });
  });

  it('uses safe legacy membership boundaries and returns no fabricated pre-feature history', async () => {
    const id = await create(true);
    await database.tripChange.deleteMany({ where: { tripId: id } });
    expect((await read(id)).json().data).toEqual([]);
    await database.tripMembership.create({
      data: {
        tripId: id,
        userId: users.member,
        role: 'MEMBER',
        joinedAt: new Date(),
      },
    });
    await patch(id, { originCity: 'Jaipur' });
    expect(
      (await read(id, 'member'))
        .json()
        .data.map((row: { version: number }) => row.version),
    ).toEqual([3]);
    await database.tripMembership.update({
      where: { tripId_userId: { tripId: id, userId: users.member } },
      data: { joinedAt: new Date(Date.now() + 86_400_000) },
    });
    expect((await read(id, 'member')).json().data).toEqual([]);
  });

  it('rolls back the trip and notifications if the history insert fails', async () => {
    const id = await create(true);
    await join(id);
    const before = await database.trip.findUniqueOrThrow({ where: { id } });
    const notifications = await database.notification.count({
      where: { tripId: id },
    });
    // A deliberate test-only unique-key collision makes the audit insert fail.
    const collision = await database.tripChange.create({
      data: {
        tripId: id,
        version: before.version + 1,
        action: 'OWNER_UPDATED',
        changes: {},
      },
    });
    try {
      const response = await patch(id, { originCity: 'Jaipur' });
      expect(response.statusCode).toBe(500);
      const after = await database.trip.findUniqueOrThrow({ where: { id } });
      expect(after.version).toBe(before.version);
      expect(after.originCity).toBe(before.originCity);
      expect(await database.notification.count({ where: { tripId: id } })).toBe(
        notifications,
      );
    } finally {
      await database.tripChange.delete({ where: { id: collision.id } });
    }
  });

  it('keeps cancellation history readable to current members and hides disabled actors', async () => {
    const id = await create(true);
    await join(id);
    const trip = await database.trip.findUniqueOrThrow({ where: { id } });
    expect(
      (
        await api('POST', `/trips/${id}/cancel`, 'owner', {
          expectedVersion: trip.version,
        })
      ).statusCode,
    ).toBe(200);
    expect((await read(id, 'member')).json().data[0]).toMatchObject({
      action: 'STATUS_CHANGED',
      changes: { status: { before: 'PUBLISHED', after: 'CANCELLED' } },
    });
    try {
      for (const status of [
        'SUSPENDED',
        'PENDING_DELETION',
        'DELETED',
      ] as const) {
        await database.user.update({
          where: { id: users.owner },
          data: {
            status,
            statusBeforeDeletion:
              status === 'PENDING_DELETION' ? 'ACTIVE' : null,
          },
        });
        expect(
          (await read(id, 'member'))
            .json()
            .data.every((row: { actor: unknown }) => row.actor === null),
        ).toBe(true);
      }
    } finally {
      await database.user.update({
        where: { id: users.owner },
        data: { status: 'ACTIVE', statusBeforeDeletion: null },
      });
    }
  });

  it('exports only the account-authored changes, without descriptions or joined actors', async () => {
    const id = await create(true);
    await join(id);
    await api('POST', `/trips/${id}/leave`, 'member');
    const ownerExport = await createAccountDataExport(users.owner);
    expect(
      ownerExport.activity.tripChanges
        .filter((row) => row.tripId === id)
        .map((row) => row.action),
    ).toEqual(['CREATED', 'STATUS_CHANGED', 'MEMBER_JOINED']);
    const memberExport = await createAccountDataExport(users.member);
    expect(
      memberExport.activity.tripChanges
        .filter((row) => row.tripId === id)
        .map((row) => row.action),
    ).toEqual(['MEMBER_LEFT']);
    expect(JSON.stringify(ownerExport.activity.tripChanges)).not.toContain(
      'PRIVATE',
    );
    expect(Object.keys(ownerExport.activity.tripChanges[0]!)).not.toContain(
      'actor',
    );
  });
});
