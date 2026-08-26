import { defineConfig } from 'vite-plus';

const entries = {
  'analysis/analyse': 'src/analysis/analyse.ts',
  'cli/main': 'src/cli/main.ts',
  'core/index': 'src/core/index.ts',
  'deterministic/index': 'src/deterministic/index.ts',
  'evaluation/index': 'src/evaluation/index.ts',
  'fixture-tools/index': 'src/fixture-tools/index.ts',
  'model-client/index': 'src/model-client/index.ts',
  'rule-pack/index': 'src/rule-pack/index.ts',
  'semantic/index': 'src/semantic/index.ts',
  'textlint/index': 'src/textlint/index.ts',
  'textlint/preset': 'src/textlint/preset.ts',
};

export default defineConfig({
  pack: {
    entry: entries,
    root: 'src',
    outDir: 'dist',
    platform: 'node',
    target: 'node22',
    format: 'esm',
    fixedExtension: false,
    unbundle: true,
    dts: true,
    sourcemap: true,
    clean: true,
    deps: { neverBundle: true },
  },
  lint: {
    plugins: ['typescript', 'unicorn', 'oxc', 'import', 'promise', 'vitest'],
    categories: {
      correctness: 'error',
      suspicious: 'error',
    },
    env: {
      builtin: true,
      node: true,
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      'promise/always-return': ['error', { ignoreLastCallback: true }],
      'eslint/no-underscore-dangle': ['error', { allow: ['__dirname', '_multiCache'] }],
    },
  },
  fmt: {
    singleQuote: true,
    printWidth: 100,
    trailingComma: 'all',
    semi: true,
    arrowParens: 'always',
  },
  run: {
    tasks: {
      'fixtures:fetch': {
        command: 'node scripts/fetch-sources.mjs',
        cache: false,
      },
      'fixtures:validate': {
        command: ['vp pack', 'node scripts/validate-fixtures.mjs'],
        cache: false,
      },
      'eval:semantic': {
        command: ['vp pack', 'node scripts/evaluate-semantic.mjs'],
        cache: false,
      },
      verify: {
        command: ['vp check', 'vp test', 'vp run fixtures:validate'],
        cache: false,
      },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/cli/**'],
      reporter: ['text-summary', 'lcov'],
      thresholds: {
        statements: 91,
        branches: 81,
        functions: 91,
        lines: 94,
      },
    },
  },
  staged: {
    // Runs from `.vite-hooks/pre-commit` via `vp staged`. `vp check --fix` type-checks the whole
    // project on every invocation regardless of which paths are passed (see `vp check --help`),
    // so source and prose are split: source files pay that cost, prose/config files only format.
    '*.{ts,mjs}': 'vp check --fix',
    '*.{md,json,yml,yaml}': 'vp fmt --write',
  },
});
