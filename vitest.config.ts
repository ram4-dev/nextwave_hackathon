import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Opt-in Postgres mandate integration — run via `npm run test:mandates:postgres`.
      'tests/**/*.postgres.test.ts',
    ],
    testTimeout: 30_000,
  },
});
