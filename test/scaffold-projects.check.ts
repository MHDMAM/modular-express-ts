import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readManifest, scaffold } from '../scaffold/scaffold.js';
import { copyTemplate, removeTemplateCopies, root } from './support/template-copy.js';

const ids = readManifest(root).features.map((feature) => feature.id);

afterAll(removeTemplateCopies);

// Generated projects must still typecheck and be formatted, with every feature alone, none and all.
// Slow (a compiler run per project), so not part of `npm test`: `npm run test:scaffold`, and CI.
describe.concurrent('generated projects', () => {
  const combinations = [[], ...ids.map((id) => [id]), ids];
  it.each(combinations.map((keep) => [keep.join(', ') || 'none', keep]))(
    'typecheck and are formatted [%s]',
    (_, keep) => {
      const dir = copyTemplate();
      scaffold(dir, { name: 'my-app', features: keep });
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
      for (const args of [
        ['node_modules/typescript/bin/tsc', '--noEmit'],
        ['node_modules/prettier/bin/prettier.cjs', '--check', '.', '--ignore-path', '.gitignore'],
      ]) {
        const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
        expect(result.status, `${args[0]}\n${result.stdout}\n${result.stderr}`).toBe(0);
      }
    },
    120_000,
  );
});
