// @ts-check
import js from '@eslint/js';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const webFiles = ['apps/web/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.plans/**',
      'worktrees/**',
      '**/next-env.d.ts',
      'packages/data/raw/**',
      'packages/data/build/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Make slow tests faster or split them; never raise their time limit (AGENTS.md "Verifying
  // changes"). The CI file budget (scripts/test-budget.ts) catches the rest.
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name=/^(it|test)$/][arguments.length=3]',
          message: 'Do not raise a test time limit; split the test or make it cheaper.',
        },
        {
          selector:
            "CallExpression[callee.name=/^(it|test|describe)$/] > ObjectExpression > Property[key.name='timeout']",
          message: 'Do not raise a test time limit; split the test or make it cheaper.',
        },
      ],
    },
  },

  // Next.js rules, scoped to the web app. Its parser/plugin entries for TypeScript are
  // dropped so the type-aware typescript-eslint setup above stays in charge.
  ...nextCoreWebVitals
    .filter((config) => config.name !== 'next/typescript' && config.name !== undefined)
    .map(({ languageOptions, ...config }) => {
      const { parser: _parser, ...restLanguageOptions } = languageOptions ?? {};
      return { ...config, files: webFiles, languageOptions: restLanguageOptions };
    }),
  {
    files: webFiles,
    languageOptions: { globals: { ...globals.browser } },
    settings: { next: { rootDir: 'apps/web' } },
  },

  // The renderer is framework-agnostic: no React or Next (see AGENTS.md).
  {
    files: ['packages/renderer/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*', 'next', 'next/*'],
              message: 'packages/renderer must not depend on React or Next.',
            },
          ],
        },
      ],
    },
  },
);
