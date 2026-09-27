import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Mirrors the `paths` in tsconfig.json
    alias: [
      { find: /^@\/(.*)$/, replacement: src('$1') },
      { find: /^@middleware\/(.*)$/, replacement: src('global/middleware/$1') },
      { find: /^@utils\/(.*)$/, replacement: src('global/utils/$1') },
      { find: /^@lTypes\/(.*)$/, replacement: src('global/types/$1') },
      { find: /^@libs\/(.*)$/, replacement: src('global/libs/$1') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    env: { NODE_ENV: 'test' },
  },
});
