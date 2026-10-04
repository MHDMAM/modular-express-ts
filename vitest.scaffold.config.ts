import { defineConfig } from 'vitest/config';

// Typecheck and format check of projects generated from this template: `npm run test:scaffold`
export default defineConfig({
  test: {
    include: ['test/scaffold-projects.check.ts'],
  },
});
