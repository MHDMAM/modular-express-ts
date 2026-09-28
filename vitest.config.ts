import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the `#…` subpath imports in package.json to src/*.ts instead of dist/*.js
  ssr: { resolve: { conditions: ['development'] } },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
});
