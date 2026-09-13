import { defineConfig, globalIgnores } from 'eslint/config';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default defineConfig(globalIgnores(['dist/**', 'out/**']), {
  files: ['src/**/*.ts'],
  extends: [tsPlugin.configs['flat/recommended']],
  rules: {
    complexity: ['error', { max: 10, variant: 'classic' }],
    'prefer-const': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': 'off'
  }
});
