import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  ResolvedListTripsQuery,
  TripRepository,
} from '../src/modules/trips/trip.types.js';

const queries: ResolvedListTripsQuery[] = [];
const repository: TripRepository = {
  async listPublic(query) {
    queries.push(query);
    return { trips: [], totalItems: 0 };
  },
  async findPublicById() {
    return null;
  },
};
const app = buildApp({ logger: false, trips: { repository } });

beforeAll(() => app.ready());
beforeEach(() => {
  queries.length = 0;
});
afterAll(() => app.close());

describe('trip discovery query contract', () => {
  it('parses filters and passes a complete date window to the repository', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/trips?minDuration=3&maxDuration=5&availableOnly=true&sort=date_overlap&departureFrom=2027-04-10&departureTo=2027-04-15&page=2&pageSize=10',
    });
    expect(response.statusCode).toBe(200);
    expect(queries).toEqual([
      {
        minDuration: 3,
        maxDuration: 5,
        availableOnly: true,
        sort: 'date_overlap',
        departureFrom: '2027-04-10',
        departureTo: '2027-04-15',
        page: 2,
        pageSize: 10,
      },
    ]);
    expect(response.json().pagination).toEqual({
      page: 2,
      pageSize: 10,
      totalItems: 0,
      totalPages: 0,
    });
  });

  it('preserves the default ordering and accepts explicit false availability', async () => {
    for (const url of ['/api/v1/trips', '/api/v1/trips?availableOnly=false']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
    expect(queries).toEqual([
      { sort: 'newest', availableOnly: false, page: 1, pageSize: 20 },
      { sort: 'newest', availableOnly: false, page: 1, pageSize: 20 },
    ]);
  });

  it('accepts a valid leap day and inclusive duration limits', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/trips?departureFrom=2028-02-29&departureTo=2028-03-01&sort=date_overlap&minDuration=1&maxDuration=365',
    });
    expect(response.statusCode).toBe(200);
    expect(queries[0]).toMatchObject({
      departureFrom: '2028-02-29',
      minDuration: 1,
      maxDuration: 365,
    });
  });

  it.each([
    'minDuration=0',
    'maxDuration=-1',
    'minDuration=2.5',
    'maxDuration=366',
    'minDuration=7&maxDuration=3',
    'availableOnly=yes',
    'sort=unknown',
    'sort=date_overlap',
    'sort=date_overlap&departureFrom=2027-04-10',
    'sort=date_overlap&departureTo=2027-04-15',
    'departureFrom=2027-04-20&departureTo=2027-04-10',
    'departureFrom=2027-02-30',
    'departureFrom=0000-01-01',
    'minBudget=100&maxBudget=10',
    'page=9007199254740991&pageSize=100',
    'page=9007199254740992',
  ])('rejects %s before querying the database', async (query) => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/trips?${query}`,
    });
    expect(response.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
  });
});
