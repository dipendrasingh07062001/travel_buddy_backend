import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';

const app = buildApp({ logger: false });
const ownerId = randomUUID();
const communityId = randomUUID();
const publishedTripId = randomUUID();
const fullTripId = randomUUID();
const draftTripId = randomUUID();

beforeAll(async () => {
  await database.user.create({
    data: { id: ownerId, displayName: 'Public Trip Owner' },
  });
  await database.community.create({
    data: {
      id: communityId,
      slug: `integration-manali-${communityId}`,
      name: 'Integration Manali',
      region: 'Himachal Pradesh',
    },
  });
  await database.trip.createMany({
    data: [
      {
        id: publishedTripId,
        ownerId,
        communityId,
        originCity: 'Delhi',
        startDate: new Date('2027-01-10T00:00:00.000Z'),
        endDate: new Date('2027-01-15T00:00:00.000Z'),
        durationDays: 6,
        budgetMin: 10000,
        budgetMax: 18000,
        desiredGroupSize: 5,
        transport: 'BUS',
        description: 'Published integration trip',
        status: 'PUBLISHED',
        publishedAt: new Date('2026-09-16T09:00:00.000Z'),
      },
      {
        id: fullTripId,
        ownerId,
        communityId,
        originCity: 'Mumbai',
        startDate: new Date('2027-02-01T00:00:00.000Z'),
        endDate: new Date('2027-02-05T00:00:00.000Z'),
        durationDays: 5,
        budgetMin: 20000,
        budgetMax: 30000,
        currentGroupSize: 4,
        desiredGroupSize: 4,
        transport: 'TRAIN',
        description: 'Full integration trip',
        status: 'FULL',
        publishedAt: new Date('2026-09-15T09:00:00.000Z'),
      },
      {
        id: draftTripId,
        ownerId,
        communityId,
        originCity: 'Delhi',
        startDate: new Date('2027-03-01T00:00:00.000Z'),
        endDate: new Date('2027-03-05T00:00:00.000Z'),
        durationDays: 5,
        desiredGroupSize: 3,
        description: 'Private draft integration trip',
        status: 'DRAFT',
      },
    ],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({ where: { ownerId } });
  await database.community.delete({ where: { id: communityId } });
  await database.user.delete({ where: { id: ownerId } });
  await database.$disconnect();
});

describe('public trips API', () => {
  it('returns only public trips with pagination and safe owner fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/trips?destination=integration-manali-${communityId}&pageSize=1`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({
      page: 1,
      pageSize: 1,
      totalItems: 2,
      totalPages: 2,
    });
    expect(body.data[0].owner).toEqual({
      id: ownerId,
      displayName: 'Public Trip Owner',
    });
    expect(body.data[0].owner.email).toBeUndefined();
  });

  it('filters trips using overlapping dates, budget, origin, and transport', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/trips?destination=integration-manali-${communityId}&origin=del&departureFrom=2027-01-12&departureTo=2027-01-20&minBudget=15000&maxBudget=19000&transport=BUS`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: publishedTripId,
      startDate: '2027-01-10',
      endDate: '2027-01-15',
      budget: { minimum: '10000.00', maximum: '18000.00' },
      group: { currentSize: 1, desiredSize: 5, availableSpaces: 4 },
    });
  });

  it('returns a public trip by id but hides drafts as not found', async () => {
    const publicResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${publishedTripId}`,
    });
    const draftResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${draftTripId}`,
    });

    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.json().data.id).toBe(publishedTripId);
    expect(draftResponse.statusCode).toBe(404);
    expect(draftResponse.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects invalid identifiers and inverted ranges', async () => {
    const invalidId = await app.inject({
      method: 'GET',
      url: '/api/v1/trips/not-a-uuid',
    });
    const invalidDates = await app.inject({
      method: 'GET',
      url: '/api/v1/trips?departureFrom=2027-02-01&departureTo=2027-01-01',
    });
    const invalidBudget = await app.inject({
      method: 'GET',
      url: '/api/v1/trips?minBudget=200&maxBudget=100',
    });

    expect(invalidId.statusCode).toBe(400);
    expect(invalidDates.statusCode).toBe(400);
    expect(invalidBudget.statusCode).toBe(400);
  });
});
