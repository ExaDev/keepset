import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Stands until the first suite lands with the path grammar (issue #3): a repository with no test files yet is the scaffold state, not a broken test run.
    passWithNoTests: true,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
