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
      // Without `thresholds`, coverage is measured but never enforced: a change that quietly drops
      // coverage passes `npm test` the same as one that doesn't, unlike everything else in this
      // project's QA setup (the fixture ground-truth script, the corpus tests) which fails loud on
      // drift instead of just reporting it.
      //
      // These numbers are today's real coverage, from `npm run test:coverage` on this exact commit
      // (statements 91.9%, branches 81.61%, functions 92.04%, lines 94.67%), each given roughly a
      // point of slack below the real figure. That is deliberate margin, not laziness: v8's own
      // coverage counting has small run-to-run jitter, and a hard ratchet set to the exact current
      // number would fail on that jitter alone, not on an actual regression. A change that drops
      // coverage by more than that margin fails the build; a change that holds or improves it does
      // not need this comment touched.
      thresholds: {
        statements: 91,
        branches: 81,
        functions: 91,
        lines: 94,
      },
    },
  },
});
