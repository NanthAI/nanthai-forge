import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'tests/fixtures/**',
      'private-artifacts/**',
      'convex/_generated/**',
    ],
  },
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['src/**/*.ts', 'web/src/**/*.ts', 'web/src/**/*.tsx', 'convex/**/*.ts', 'netlify/**/*.mts'],
  })),
  {
    files: ['src/**/*.ts', 'web/src/**/*.ts', 'web/src/**/*.tsx', 'convex/**/*.ts', 'netlify/**/*.mts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  prettier,
);
