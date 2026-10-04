import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { readManifest, scaffold, type Edit } from '../scaffold/scaffold.js';
import { copyTemplate, removeTemplateCopies, root } from './support/template-copy.js';

const manifest = readManifest(root);
const ids = manifest.features.map((feature) => feature.id);
const connectors = ['hazelcast', 'kafka', 'mssql', 'redis'];
const deployment = ['docker', 'pm2'];

/**
 * The feature selections to try. Features sharing a `whenNoneKept` rule form a group; every subset of each group is
 * tried, once with all the other features kept and once with all of them removed. Trying every subset of all features
 * would double the run with each new feature, and features of different groups only meet in the files they both edit.
 */
function selections(): string[][] {
  let groups = ids.map((id) => [id]);
  for (const rule of manifest.whenNoneKept) {
    const joined = groups.filter((group) => group.some((id) => rule.features.includes(id)));
    groups = [...groups.filter((group) => !joined.includes(group)), joined.flat()];
  }
  const found = new Map<string, string[]>();
  for (const group of groups) {
    const others = ids.filter((id) => !group.includes(id));
    for (let mask = 0; mask < 2 ** group.length; mask++) {
      const subset = group.filter((_, i) => mask & (1 << i));
      for (const rest of [[], others]) {
        const keep = ids.filter((id) => subset.includes(id) || rest.includes(id));
        found.set(keep.join(), keep);
      }
    }
  }
  return [...found.values()];
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path).replaceAll('\\', '/')];
  });
}

const texts = new Map<string, string>();

/** A file's text, read from disk once per test: the checks look at the same files many times. */
function read(dir: string, file: string): string {
  const path = join(dir, file);
  if (!texts.has(path)) texts.set(path, readFileSync(path, 'utf8'));
  return texts.get(path)!;
}

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

afterEach(() => texts.clear());
afterAll(removeTemplateCopies);

describe('scaffold', () => {
  it.each(selections().map((keep) => [keep.join(', ') || 'none', keep]))('keeps [%s]', (_, keep) => {
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

    // Without a connector that has tests against a real server, nothing of them is left
    const tested = ['mssql', 'kafka', 'hazelcast', 'redis'];
    const integration = tested.some((id) => keep.includes(id));
    for (const id of tested)
      expect(existsSync(join(dir, `test/integration/${id}.integration.ts`)), id).toBe(keep.includes(id));
    for (const dep of Object.keys(pkg.devDependencies).filter((dep) => dep.includes('testcontainers')))
      expect(code, `${dep} is a devDependency but never imported`).toContain(`'${dep}'`);
    for (const file of ['test/integration', 'vitest.integration.config.ts'])
      expect(existsSync(join(dir, file)), file).toBe(integration);
    for (const file of ['package.json', 'README.md', '.github/workflows/ci.yml'])
      expect(read(dir, file).includes('integration'), `${file} mentions integration tests`).toBe(integration);

    // Without the config file feature, nothing mentions it
    if (!keep.includes('config-file')) {
      for (const file of files.filter((f) => f !== 'package-lock.json')) {
        expect(read(dir, file), file).not.toMatch(/\bconfig\.json|config-file|CONFIG_FILE/);
      }
    }
    // The entry point starts with the config file import, or with its first real import
    expect(read(dir, 'src/server.ts').startsWith('import logger')).toBe(!keep.includes('config-file'));

    const readme = read(dir, 'README.md');
    expect(readme.startsWith('# @acme/my-app\n\nCreated with [modular-express-ts]')).toBe(true);
    expect(readme.includes('## Optional Connectors')).toBe(registered.length > 0);
    expect(readme.includes('## Deployment')).toBe(deployment.some((id) => keep.includes(id)));
    expect(readme).not.toMatch(/## (License|Creating a Project)\n/);
    expect(readme).not.toContain('\n\n\n');
    expect(read(dir, '.env.example')).not.toContain('\n\n\n');

    expect(pkg).toMatchObject({ name: '@acme/my-app', version: '0.1.0', private: true, license: 'UNLICENSED' });
    expect(pkg.author).toBeUndefined();
    expect(JSON.parse(read(dir, 'package-lock.json')).name).toBe('@acme/my-app');
    // Nothing of the template's own scaffolding is left
    for (const file of manifest.project.removeFiles) expect(existsSync(join(dir, file)), file).toBe(false);
    for (const file of files.filter((f) => f !== 'package-lock.json')) {
      expect(read(dir, file), file).not.toMatch(/scaffold/i);
    }

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
