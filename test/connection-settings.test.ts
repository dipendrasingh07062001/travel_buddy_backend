import { describe, expect, it } from 'vitest';

import {
  postgresConnectionString,
  postgresSettings,
} from '../src/database/connection-settings.js';

describe('database connection settings', () => {
  it('uses a plain URL as it is, with a five second connect timeout', () => {
    expect(
      postgresSettings('postgresql://user:pass@db.example:5432/travel_buddy'),
    ).toEqual({
      connectionString: 'postgresql://user:pass@db.example:5432/travel_buddy',
      connectionTimeoutMillis: 5000,
    });
  });

  it('translates Prisma URL parameters into pool and adapter options', () => {
    expect(
      postgresSettings(
        'postgresql://user:pass@db.example/app?sslmode=require&connection_limit=3&connect_timeout=10&schema=travel&pool_timeout=20&pgbouncer=true',
      ),
    ).toEqual({
      connectionString: 'postgresql://user:pass@db.example/app?sslmode=require',
      connectionTimeoutMillis: 10_000,
      max: 3,
      schema: 'travel',
    });
  });

  it('ignores invalid limits and timeouts instead of guessing', () => {
    expect(
      postgresSettings(
        'postgresql://db.example/app?connection_limit=0&connect_timeout=soon',
      ),
    ).toEqual({
      connectionString: 'postgresql://db.example/app',
      connectionTimeoutMillis: 5000,
    });
  });

  it('removes only Prisma parameters from the connection string', () => {
    expect(
      postgresConnectionString(
        'postgresql://db.example/app?statement_cache_size=0&application_name=x&socket_timeout=5',
      ),
    ).toBe('postgresql://db.example/app?application_name=x');
  });
});
