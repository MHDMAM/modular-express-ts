import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readManifest, scaffold, type Edit } from '../scaffold/scaffold.js';

const root = join(import.meta.dirname, '..');
const manifest = readManifest(root);
const ids = manifest.features.map((feature) => feature.id);
const connectors = ['hazelcast', 'kafka', 'mssql', 'redis'];

/** Every subset of the features. */
const subsets = Array.from({ length: 2 ** ids.length }, (_, mask) => ids.filter((_, i) => mask & (1 << i)));

let template: string;
const dirs: string[] = [];

/** A fresh copy of the template's files (tracked and new, never ignored or excluded ones). */
function copyTemplate(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  dirs.push(dir);
  cpSync(template, dir, { recursive: true });
  return dir;
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path).replaceAll('\\', '/')];
  });
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

/** The text an edit removes, as it appears in the template. */
function editedText(edit: Edit): string {
  return (
    edit.removeLine ??
    edit.removeBullet ??
    (edit.removeSection && `## ${edit.removeSection}`) ??
    edit.removeBlock ??
    edit.removeListItem!.item
  );
}

beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), 'scaffold-template-'));
  const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  for (const file of files.stdout.split('\0').filter((f) => f && existsSync(join(root, f)))) {
    mkdirSync(dirname(join(template, file)), { recursive: true });
    cpSync(join(root, file), join(template, file));
  }
});

afterAll(() => [template, ...dirs].forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('scaffold', () => {
  it.each(subsets.map((keep) => [keep.join(', ') || 'none', keep]))('keeps [%s]', (_, keep) => {
    const dir = copyTemplate();
    scaffold(dir, { name: '@acme/my-app', features: keep });

    const files = listFiles(dir);
    const sources = files.filter((file) => file.endsWith('.ts'));
    const pkg = JSON.parse(read(dir, 'package.json'));

    for (const feature of manifest.features) {
      const kept = keep.includes(feature.id);
      for (const file of feature.files) expect(existsSync(join(dir, file)), file).toBe(kept);
      for (const dep of feature.dependencies ?? []) expect(dep in pkg.dependencies, dep).toBe(kept);
      for (const dep of feature.devDependencies ?? []) expect(dep in pkg.devDependencies, dep).toBe(kept);
      for (const entry of feature.imports ?? []) expect(entry in pkg.imports, entry).toBe(kept);
      for (const edit of feature.edits) {
        if (edit.removeListItem) continue; // checked with the registry below
        expect(read(dir, edit.file).includes(editedText(edit)), `${edit.file}: ${editedText(edit)}`).toBe(kept);
      }
      if (kept) continue;
      // No environment variables or documentation left for a removed feature
      if (connectors.includes(feature.id)) {
        expect(read(dir, '.env.example')).not.toMatch(new RegExp(`^${feature.id.toUpperCase()}_`, 'm'));
      }
      for (const folder of feature.files.map((file) => file.replace(/^src\//, ''))) {
        expect(read(dir, 'README.md'), `README mentions #${folder}`).not.toContain(`#${folder}`);
      }
      // Nothing may still import a removed feature
      for (const folder of feature.files.map((file) => file.replace(/^src\//, ''))) {
        const specifiers = [`'#${folder}`, `'./${folder.split('/').pop()}/`];
        for (const source of sources) {
          for (const specifier of specifiers)
            expect(read(dir, source), `${source} imports ${folder}`).not.toContain(specifier);
        }
      }
    }

    // Independent of the manifest: every dependency left is used, every @types package matches one
    const code = sources.map((source) => read(dir, source)).join('\n');
    for (const dep of Object.keys(pkg.dependencies).filter((dep) => dep !== 'tslib')) {
      expect(code, `${dep} is a dependency but never imported`).toMatch(new RegExp(`['"]${dep}['"/]`));
    }
    for (const types of Object.keys(pkg.devDependencies).filter((dep) => dep.startsWith('@types/'))) {
      const dep = types.slice('@types/'.length);
      expect(dep === 'node' || dep in pkg.dependencies, `${types} without ${dep}`).toBe(true);
    }

    const registered = connectors.filter((id) => keep.includes(id));
    expect(read(dir, 'src/connectors/index.ts')).toContain(`= [${registered.join(', ')}];`);
    expect(existsSync(join(dir, 'src/connectors/cache.ts'))).toBe(keep.includes('hazelcast') || keep.includes('redis'));

    // Only MSSQL has tests against a real server: without it, nothing of them is left
    const integration = keep.includes('mssql');
    for (const file of ['test/integration', 'vitest.integration.config.ts'])
      expect(existsSync(join(dir, file)), file).toBe(integration);
    for (const file of ['package.json', 'README.md', '.github/workflows/ci.yml'])
      expect(read(dir, file).includes('integration'), `${file} mentions integration tests`).toBe(integration);

    const readme = read(dir, 'README.md');
    expect(readme.startsWith('# @acme/my-app\n\nCreated with [modular-express-ts]')).toBe(true);
    expect(readme.includes('## Optional Connectors')).toBe(registered.length > 0);
    expect(readme).not.toMatch(/## (License|Creating a Project)\n/);
    expect(readme).not.toContain('\n\n\n');
    expect(read(dir, '.env.example')).not.toContain('\n\n\n');

    expect(pkg).toMatchObject({ name: '@acme/my-app', version: '0.1.0', private: true, license: 'UNLICENSED' });
    expect(pkg.author).toBeUndefined();
    expect(JSON.parse(read(dir, 'package-lock.json')).name).toBe('@acme/my-app');
    for (const file of ['LICENSE', 'scaffold', 'test/scaffold.test.ts'])
      expect(existsSync(join(dir, file)), file).toBe(false);

    // The template's name survives only in the README credit line (and the lock file's dependency tree)
    for (const file of files.filter((f) => f !== 'README.md' && f !== 'package-lock.json')) {
      expect(read(dir, file), file).not.toContain('modular-express-ts');
    }
    expect(read(dir, '.env.example')).toContain('APP_NAME=my-app\n');
  });

  it('fails on a manifest edit that no longer matches the template', () => {
    const dir = copyTemplate();
    writeFileSync(join(dir, 'README.md'), read(dir, 'README.md').replace('- **Kafka**', '- **Apache Kafka**'));

    expect(() => scaffold(dir, { name: 'app', features: [] })).toThrow(
      /Bullet "- \*\*Kafka\*\*" found 0 times in README.md/,
    );
  });

  it('rejects unknown features', () => {
    expect(() => scaffold(copyTemplate(), { name: 'app', features: ['mongo'] })).toThrow('Unknown feature(s): mongo');
  });
});

// Generated projects must still typecheck and be formatted, with every feature alone, none and all
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
    60_000,
  );
});
