import 'dotenv/config';

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Client generation does not need a live database. Migration commands will
    // fail clearly unless callers provide DATABASE_URL.
    url: process.env.DATABASE_URL ?? '',
  },
});
