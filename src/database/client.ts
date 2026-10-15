import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { postgresSettings } from './connection-settings.js';

const { schema, ...pool } = postgresSettings(env.DATABASE_URL);
export const databaseSchema = schema ?? 'public';

export const database = new PrismaClient({
  adapter: new PrismaPg(
    { ...pool, application_name: 'travel-buddy-api' },
    schema ? { schema } : undefined,
  ),
});

export async function checkDatabase(): Promise<void> {
  await database.$queryRaw`SELECT 1`;
}
