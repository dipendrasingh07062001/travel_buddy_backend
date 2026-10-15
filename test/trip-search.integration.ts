import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { utcStartOfToday } from '../src/modules/trips/trip.types.js';

const app = buildApp({ logger: false });
const today = utcStartOfToday();
const day = 86_400_000;
const date = (offset: number) => new Date(today.getTime() + offset * day);
const iso = (offset: number) => date(offset).toISOString().slice(0, 10);
const userIds: string[] = [];
const tripIds: string[] = [];
const communityIds = {
  ranking: randomUUID(),
  filters: randomUUID(),
  visibility: randomUUID(),
  archived: randomUUID(),
};
const slug = (area: keyof typeof communityIds) =>
  `search-${communityIds[area]}`;
let ownerId: string;
const rank: Record<string, string> = {};
const filter: Record<string, string> = {};
const visible: Record<string, string> = {};
let expectedRanking: string[];

type Overrides = Partial<
  Omit<
    Prisma.TripUncheckedCreateInput,
    'id' | 'communityId' | 'startDate' | 'endDate' | 'durationDays'
  >
>;

async function trip(
  area: keyof typeof communityIds,
  start: number,
  end: number,
  overrides: Overrides = {},
) {
  const created = await database.trip.create({
    data: {
      id: randomUUID(),
      ownerId,
      communityId: communityIds[area],
      originCity: 'Delhi',
      startDate: date(start),
      endDate: date(end),
      durationDays: end - start + 1,
      currentGroupSize: 1,
      desiredGroupSize: 4,
      budgetMin: 1000,
      budgetMax: 2000,
      transport: 'BUS',
      description: 'Public trip search integration fixture.',
      status: 'PUBLISHED',
      publishedAt: date(-1),
      ...overrides,
    },
  });
  tripIds.push(created.id);
  return created.id;
}

async function search(area: keyof typeof communityIds, query = '') {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/trips?destination=${slug(area)}${query ? `&${query}` : ''}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    data: Array<{
      id: string;
      owner: object;
      group: { availableSpaces: number };
    }>;
    pagination: {
      page: number;
      pageSize: number;
      totalItems: number;
      totalPages: number;
    };
  };
}

const window = () => `departureFrom=${iso(30)}&departureTo=${iso(34)}`;

beforeAll(async () => {
  const owner = await database.user.create({
    data: {
      displayName: 'Search Owner',
      birthDate: new Date('1995-05-20T00:00:00.000Z'),
      identities: {
        create: {
          type: 'EMAIL',
          normalizedValue: `search-${randomUUID()}@example.test`,
          verifiedAt: new Date(),
        },
      },
    },
  });
  ownerId = owner.id;
  userIds.push(ownerId);
  for (const area of Object.keys(communityIds) as Array<
    keyof typeof communityIds
  >) {
    await database.community.create({
      data: {
        id: communityIds[area],
        slug: slug(area),
        name: `Search ${area}`,
        status: area === 'archived' ? 'ARCHIVED' : 'ACTIVE',
      },
    });
  }
  rank.exactA = await trip('ranking', 30, 34);
  rank.exactB = await trip('ranking', 30, 34);
  rank.containing = await trip('ranking', 29, 35);
  rank.early = await trip('ranking', 28, 32);
  rank.late = await trip('ranking', 32, 36, { publishedAt: today });
  rank.singleDay = await trip('ranking', 34, 34);
  rank.boundary = await trip('ranking', 26, 30);
  expectedRanking = [rank.exactA, rank.exactB]
    .sort()
    .concat([
      rank.containing,
      rank.early,
      rank.late,
      rank.singleDay,
      rank.boundary,
    ]);
  await trip('ranking', 25, 29);
  await trip('ranking', 35, 39);
  await trip('ranking', 30, 34, {
    status: 'FULL',
    currentGroupSize: 1,
    desiredGroupSize: 4,
  });
  await trip('ranking', 30, 34, { currentGroupSize: 4, desiredGroupSize: 4 });
  for (const status of ['DRAFT', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const) {
    await trip('ranking', 30, 34, { status });
  }
  await trip('ranking', 30, 34, { moderationRemovedAt: new Date() });
  for (const status of ['SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const) {
    const user = await database.user.create({
      data: {
        displayName: 'Hidden Owner',
        status,
        ...(status === 'PENDING_DELETION' && {
          statusBeforeDeletion: 'ACTIVE' as const,
        }),
        ...(status === 'DELETED' && { deletedAt: new Date() }),
      },
    });
    userIds.push(user.id);
    await trip('ranking', 30, 34, { ownerId: user.id });
  }
  const softDeletedOwner = await database.user.create({
    data: {
      displayName: 'Soft-deleted owner',
      status: 'ACTIVE',
      deletedAt: new Date(),
    },
  });
  userIds.push(softDeletedOwner.id);
  await trip('ranking', 30, 34, { ownerId: softDeletedOwner.id });

  filter.short = await trip('filters', 40, 42, {
    budgetMin: 1200.5,
    budgetMax: 1800.75,
  });
  filter.long = await trip('filters', 40, 45);
  filter.full = await trip('filters', 40, 42, {
    status: 'FULL',
    currentGroupSize: 4,
  });
  filter.manualFull = await trip('filters', 40, 42, { status: 'FULL' });
  filter.noCapacity = await trip('filters', 40, 42, { currentGroupSize: 4 });
  filter.train = await trip('filters', 40, 42, { transport: 'TRAIN' });
  filter.unknownBudget = await trip('filters', 40, 42, {
    budgetMin: null,
    budgetMax: null,
  });
  filter.otherOrigin = await trip('filters', 40, 42, { originCity: 'Mumbai' });

  visible.ongoing = await trip('visibility', -1, 1);
  visible.today = await trip('visibility', 0, 0);
  visible.future = await trip('visibility', 10, 12);
  visible.ended = await trip('visibility', -5, -1);
  await trip('archived', 30, 34);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({ where: { id: { in: tripIds } } });
  await database.community.deleteMany({
    where: { id: { in: Object.values(communityIds) } },
  });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
  await database.$disconnect();
});

describe('trip search persistence and ordering', () => {
  it('ranks overlap days, boundary distance, departure, and IDs deterministically', async () => {
    const body = await search(
      'ranking',
      `${window()}&availableOnly=true&sort=date_overlap`,
    );
    expect(body.data.map((item) => item.id)).toEqual(expectedRanking);
    expect(body.pagination.totalItems).toBe(7);
    expect(body.data[0]?.owner).toEqual({
      id: ownerId,
      displayName: 'Search Owner',
    });
  });

  it('sorts before pagination, preserving totals and empty-page metadata', async () => {
    const ids: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const body = await search(
        'ranking',
        `${window()}&availableOnly=true&sort=date_overlap&pageSize=2&page=${page}`,
      );
      ids.push(...body.data.map((item) => item.id));
      expect(body.pagination).toEqual({
        page,
        pageSize: 2,
        totalItems: 7,
        totalPages: 4,
      });
    }
    expect(ids).toEqual(expectedRanking);
    expect(new Set(ids).size).toBe(7);
    const empty = await search(
      'ranking',
      `${window()}&availableOnly=true&sort=date_overlap&pageSize=2&page=5`,
    );
    expect(empty.data).toEqual([]);
    expect(empty.pagination).toEqual({
      page: 5,
      pageSize: 2,
      totalItems: 7,
      totalPages: 4,
    });
  });

  it.each(['newest', 'departure_asc', 'date_overlap'])(
    'combines all filters consistently with %s sorting',
    async (sort) => {
      const body = await search(
        'filters',
        `origin=del&transport=BUS&minDuration=3&maxDuration=3&availableOnly=true&minBudget=1800.75&maxBudget=1800.75&departureFrom=${iso(30)}&departureTo=${iso(50)}&sort=${sort}`,
      );
      expect(body.data.map((item) => item.id)).toEqual([filter.short]);
      expect(body.pagination.totalItems).toBe(1);
    },
  );

  it('accepts one-sided duration bounds and keeps full trips in default discovery', async () => {
    expect(
      (await search('filters', 'minDuration=6')).data.map((item) => item.id),
    ).toEqual([filter.long]);
    const short = await search('filters', 'maxDuration=3');
    expect(short.data).toHaveLength(7);
    expect(short.data.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        filter.full,
        filter.manualFull,
        filter.noCapacity,
      ]),
    );
    expect(
      (await search('filters', 'availableOnly=false')).pagination.totalItems,
    ).toBe(8);
    const available = await search('filters', 'availableOnly=true');
    expect(available.data.map((item) => item.id).sort()).toEqual(
      [
        filter.short,
        filter.long,
        filter.train,
        filter.unknownBudget,
        filter.otherOrigin,
      ].sort(),
    );
  });

  it('preserves newest and earliest-departure sorts', async () => {
    const newest = await search(
      'ranking',
      `${window()}&availableOnly=true&sort=newest`,
    );
    expect(newest.data[0]?.id).toBe(rank.late);
    const departure = await search(
      'ranking',
      `${window()}&availableOnly=true&sort=departure_asc`,
    );
    expect(departure.data.map((item) => item.id)).toEqual([
      rank.boundary,
      rank.early,
      rank.containing,
      ...[rank.exactA!, rank.exactB!].sort(),
      rank.late,
      rank.singleDay,
    ]);
  });

  it('returns identical ranked community results and scoped pagination', async () => {
    const query = `${window()}&availableOnly=true&minDuration=1&maxDuration=7&sort=date_overlap&page=2&pageSize=2`;
    const publicBody = await search('ranking', query);
    const community = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug('ranking').toUpperCase()}/trips?${query}`,
    });
    expect(community.statusCode).toBe(200);
    expect(community.json()).toEqual(publicBody);
    expect(publicBody.data.map((item) => item.id)).toEqual(
      expectedRanking.slice(2, 4),
    );
  });

  it('keeps ongoing/today trips visible and ended or archived trips hidden', async () => {
    const body = await search('visibility');
    expect(body.data.map((item) => item.id).sort()).toEqual(
      [visible.ongoing, visible.today, visible.future].sort(),
    );
    expect((await search('archived')).data).toEqual([]);
    const archived = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug('archived')}/trips?sort=date_overlap&${window()}`,
    });
    expect(archived.statusCode).toBe(404);
  });

  it('treats SQL-looking origin text as a search value', async () => {
    const origin = encodeURIComponent("Delhi%' OR TRUE --");
    const body = await search(
      'ranking',
      `${window()}&sort=date_overlap&origin=${origin}`,
    );
    expect(body.data).toEqual([]);
    expect(body.pagination.totalItems).toBe(0);
  });
});
