import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/__tests__/setup.ts'],
    exclude: ['**/node_modules/**', '**/build/**', 'src/__tests__/setup.ts'],
    coverage: {
      exclude: ['src/generated/**', 'build/**', 'vitest.config.ts'],
    },
  },
});
