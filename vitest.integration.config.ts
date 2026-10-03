import { defineConfig } from 'vitest/config';

// Tests against real servers started in Docker (Testcontainers): `npm run test:integration`
export default defineConfig({
  ssr: { resolve: { conditions: ['development'] } },
  test: {
    include: ['test/integration/**/*.integration.ts'],
    env: { NODE_ENV: 'test' },
    // Starting a container takes a while, longer when its image is pulled first
    hookTimeout: 600_000,
    testTimeout: 60_000,
  },
});
