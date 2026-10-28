import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.ts'],
    // App startup in beforeAll can take several seconds on a cold or busy
    // machine; test bodies keep the 5 s default.
    hookTimeout: 30_000,
  },
});
