import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Flat ESLint config for the workspace.
 *
 * The block at the bottom is the mechanical enforcement of Principle III / SC-010: `packages/core`
 * is the reproducibility boundary, so a clock, a random source or any I/O import is a lint error
 * there rather than a review comment. See contracts/scheduler-core.md invariants 1 and 2.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.firebase/**',
      '**/*.vue',
      'fixtures/**',
      'scripts/spikes/**',
      'specs/**',
      '.specify/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // Principle VII: `any` and `!` are permitted only with an inline justification, which in
      // practice means an eslint-disable line that a reviewer has to read.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        // `_name` covers the deliberate discard, including the destructuring-to-omit idiom.
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    files: ['apps/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // T004 — the purity fence around the decision core (Principle III, SC-010).
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message:
            'packages/core is pure: read `inputs.now` instead of the wall clock (Principle III).',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'packages/core is pure: `new Date()` reads the wall clock — use `inputs.now` (Principle III).',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message:
            'packages/core is pure: seed the fairness draw from `inputs.randomSeed` (Principle III).',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/core performs no I/O (Principle III).' },
            {
              group: ['firebase-admin', 'firebase-admin/*'],
              message:
                'packages/core performs no I/O — Firestore access belongs in packages/adapters.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'packages/core performs no I/O (Principle III).' },
        {
          name: 'process',
          message: 'packages/core reads no ambient state — pass it in `CycleInputs`.',
        },
      ],
    },
  },
  {
    files: ['**/tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
