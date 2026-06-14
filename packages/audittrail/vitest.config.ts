import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Integration tests share one Postgres `events` table (the chain is global state), so run files
    // sequentially and reset the DB between tests rather than racing them in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
