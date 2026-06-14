import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Pure, in-memory engine — no shared state, so files can run in parallel.
    testTimeout: 10_000,
  },
});
