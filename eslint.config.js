import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.claude/worktrees/**` holds nested git worktrees for other concurrent sessions/branches;
    // this project's ESLint config must never lint another session's in-progress files.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.cache/**',
      'fixtures/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/require-await': 'off',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['scripts/**/*.{ts,mts,mjs}', 'src/cli/**/*.ts', 'test/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Plain JS/MJS files are not part of the TypeScript program, so type-aware rules are disabled
    // for them. The globals must be merged into the same languageOptions block rather than
    // replacing it, or the type-checking disable is lost.
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
