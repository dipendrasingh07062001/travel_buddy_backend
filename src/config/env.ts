import 'dotenv/config';

import { z } from 'zod';

const policyVersion = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/)
    .optional(),
);

const policyUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .url()
    .max(2048)
    .refine((value) => new URL(value).protocol === 'https:', {
      message: 'Policy document links must use HTTPS.',
    })
    .optional(),
);

// Mirrors Fastify's trustProxy option: true, a hop count, or a comma-separated
// list of trusted proxy addresses or CIDR ranges. Unset means no proxy.
const trustProxy = z
  .string()
  .trim()
  .optional()
  .transform(
    (value): boolean | string | ((address: string, hop: number) => boolean) => {
      if (!value || value === 'false') return false;
      if (value === 'true') return true;
      if (/^\d+$/.test(value)) {
        const hops = Number(value);
        return (_address, hop) => hop < hops;
      }
      return value;
    },
  );

const optionalSetting = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    schema.optional(),
  );

// Cloudflare R2 bucket names: 3-63 lowercase letters, digits, and hyphens.
const bucketName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'Invalid R2 bucket name.');

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required when NODE_ENV=production');
  process.exit(1);
}

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    TRUST_PROXY: trustProxy,
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
    PUSH_NOTIFICATIONS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    FIREBASE_PROJECT_ID: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().trim().min(1).optional(),
    ),
    R2_ACCOUNT_ID: optionalSetting(
      z.string().regex(/^[a-f0-9]{32}$/, 'Expected a 32-character account ID.'),
    ),
    R2_ACCESS_KEY_ID: optionalSetting(z.string().trim().min(1).max(128)),
    R2_SECRET_ACCESS_KEY: optionalSetting(z.string().trim().min(1).max(256)),
    R2_PUBLIC_BUCKET: optionalSetting(bucketName),
    R2_PRIVATE_BUCKET: optionalSetting(bucketName),
    R2_PUBLIC_BASE_URL: optionalSetting(
      z.url().refine((value) => new URL(value).protocol === 'https:', {
        message: 'R2_PUBLIC_BASE_URL must use HTTPS.',
      }),
    ),
    POLICY_TERMS_VERSION: policyVersion,
    POLICY_TERMS_URL: policyUrl,
    POLICY_PRIVACY_VERSION: policyVersion,
    POLICY_PRIVACY_URL: policyUrl,
    POLICY_COMMUNITY_STANDARDS_VERSION: policyVersion,
    POLICY_COMMUNITY_STANDARDS_URL: policyUrl,
  })
  .superRefine((configuration, context) => {
    const values = [
      configuration.POLICY_TERMS_VERSION,
      configuration.POLICY_TERMS_URL,
      configuration.POLICY_PRIVACY_VERSION,
      configuration.POLICY_PRIVACY_URL,
      configuration.POLICY_COMMUNITY_STANDARDS_VERSION,
      configuration.POLICY_COMMUNITY_STANDARDS_URL,
    ];
    if (values.some(Boolean) && values.some((value) => !value)) {
      context.addIssue({
        code: 'custom',
        message: 'Configure all three policy versions and HTTPS URLs together.',
        path: ['POLICY_TERMS_VERSION'],
      });
    }

    const storage = [
      configuration.R2_ACCOUNT_ID,
      configuration.R2_ACCESS_KEY_ID,
      configuration.R2_SECRET_ACCESS_KEY,
      configuration.R2_PUBLIC_BUCKET,
      configuration.R2_PRIVATE_BUCKET,
      configuration.R2_PUBLIC_BASE_URL,
    ];
    if (storage.some(Boolean) && storage.some((value) => !value)) {
      context.addIssue({
        code: 'custom',
        message: 'Configure all six R2_* storage settings together.',
        path: ['R2_ACCOUNT_ID'],
      });
    }
    if (
      configuration.R2_PUBLIC_BUCKET &&
      configuration.R2_PUBLIC_BUCKET === configuration.R2_PRIVATE_BUCKET
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'R2_PUBLIC_BUCKET and R2_PRIVATE_BUCKET must be different buckets.',
        path: ['R2_PRIVATE_BUCKET'],
      });
    }
  });

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error(
    `Invalid environment configuration:\n${z.prettifyError(result.error)}`,
  );
  process.exit(1);
}

if (result.data.NODE_ENV === 'production' && !result.data.FIREBASE_PROJECT_ID) {
  console.error('FIREBASE_PROJECT_ID is required when NODE_ENV=production');
  process.exit(1);
}

if (
  result.data.PUSH_NOTIFICATIONS_ENABLED &&
  !result.data.FIREBASE_PROJECT_ID
) {
  console.error(
    'FIREBASE_PROJECT_ID is required when PUSH_NOTIFICATIONS_ENABLED=true',
  );
  process.exit(1);
}

export const env = result.data;
