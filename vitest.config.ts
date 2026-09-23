import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Живые тесты (tests/live) запускаются только вручную через `npm run test:live`.
    env: { LIVE_TESTS_ENABLED: 'false' },
  },
});
