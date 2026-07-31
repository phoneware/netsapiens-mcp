import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/__tests__/setup.ts'],
    exclude: ['**/node_modules/**', '**/build/**', 'src/__tests__/setup.ts'],
    // Several suites boot a real Express app and drive it through supertest,
    // which binds and closes an ephemeral server per request. Fanned out across
    // one fork per core (18 here) that intermittently produced ECONNRESET on an
    // arbitrary request, surfacing as a flake in whichever test happened to draw
    // it. Capping the fork count keeps the suite fast and deterministic.
    poolOptions: { forks: { maxForks: 4 } },
    coverage: {
      exclude: ['src/generated/**', 'build/**', 'vitest.config.ts'],
    },
  },
});
