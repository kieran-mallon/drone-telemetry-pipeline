import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-lambda/**',
      'node_modules/**',
      'infra/node_modules/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript already resolves identifiers, and no-undef does not
      // understand type-only names or ambient globals. Disabling it here is the
      // typescript-eslint project's own recommendation for TS files.
      'no-undef': 'off',

      '@typescript-eslint/consistent-type-imports': 'error',
      // ignoreRestSiblings allows the idiomatic `const { omitted, ...rest } = obj`
      // pattern for dropping a key, which is otherwise flagged as unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Application code logs through the injected Logger port, never straight
      // to stdout, so that output stays structured and testable.
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Scripts are operator tooling run by a human at a terminal. Printing to
    // stdout is the entire point of them.
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
);
