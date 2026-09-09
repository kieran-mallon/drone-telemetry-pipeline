import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Pure unit tests. No database, no network, no Docker.
        // These are the tests that run in milliseconds and can be trusted in a pre-commit hook.
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Integration tests. These start a real Postgres via Testcontainers,
        // so they need a working Docker daemon and take tens of seconds.
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          pool: 'forks',
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/runtime/**', 'src/**/*.d.ts'],
    },
  },
});
