import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // textlint-tester registers its cases with the ambient describe/it globals, the way textlint's
    // own rule suite does. Enabling globals lets the ecosystem harness run unmodified; the project's
    // own tests still import from vitest explicitly.
    globals: true,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/cli/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
