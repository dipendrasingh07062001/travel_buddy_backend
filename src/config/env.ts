import 'dotenv/config';

import { z } from 'zod';

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required when NODE_ENV=production');
  process.exit(1);
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CORS_ORIGINS: z
    .string()
    .min(1)
    .default('http://localhost:3000,http://localhost:8080'),
  DATABASE_URL: z
    .url()
    .default(
      'postgresql://travel_buddy:travel_buddy@localhost:5432/travel_buddy',
    ),
  FIREBASE_PROJECT_ID: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error(
    'Invalid environment configuration',
    z.treeifyError(result.error),
  );
  process.exit(1);
}

if (result.data.NODE_ENV === 'production' && !result.data.FIREBASE_PROJECT_ID) {
  console.error('FIREBASE_PROJECT_ID is required when NODE_ENV=production');
  process.exit(1);
}

export const env = result.data;
