import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.ts'],
    testTimeout: 15_000,
    // Setup hooks start the app and seed data, which slows down on a busy
    // machine; this limit is there to catch a hang.
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
