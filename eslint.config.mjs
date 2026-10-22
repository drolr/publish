import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      '.webpack/**',
      'test-results/**',
      '.tmp/**',
      '.cache/**',
      '.superpowers/sdd/**',
      '.git-initialization-backup/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
);
