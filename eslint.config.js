import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'infra/node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // ignoreRestSiblings allows the idiomatic `const { omitted, ...rest } = obj`
      // pattern for dropping a key, which is otherwise flagged as an unused variable.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Scripts are operator tooling, not library code: printing to stdout is the point.
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
