// ESLint flat config: recommended JS rules + type-aware TypeScript rules.
// Formatting is left to Prettier (eslint-config-prettier turns off clashing rules).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'infra/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Template literals with numbers are fine for log / SQL text.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Allow intentionally-unused args when prefixed with "_".
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Repository methods are `async` to honour an async interface even when
      // the backend (better-sqlite3) is synchronous. That is intentional.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Plain JS config files are not part of the TS project.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
