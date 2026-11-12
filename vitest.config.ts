import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests share one Redis; run files sequentially.
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
});
