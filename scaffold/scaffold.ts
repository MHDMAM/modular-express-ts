/**
 * Turns a copy of this template into a new project: removes the features that were not selected (as described in
 * `features.json`), renames the project and removes this folder.
 *
 *   node scaffold/scaffold.ts --name my-app --features http,redis   (or --features none)
 *
 * Uses Node built-ins only, so it runs before `npm install`. Every edit must match the template exactly once:
 * a change to the template that breaks the manifest fails here, and in `test/scaffold.test.ts`.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

export interface Edit {
  file: string;
  /** Removes the line equal to this text. */
  removeLine?: string;
  /** Removes the Markdown bullet starting with this text, including its indented continuation lines. */
  removeBullet?: string;
  /** Removes the Markdown `## <heading>` section up to the next `## ` heading. */
  removeSection?: string;
  /** Removes the block starting with this line up to and including the next blank line (e.g. in `.env.example`). */
  removeBlock?: string;
  /** Removes `item` from the single-line `[a, b, c]` list on the line starting with `line`. */
  removeListItem?: { line: string; item: string };
}

export interface Feature {
  id: string;
  label: string;
  hint: string;
  default: boolean;
  /** Files and folders owned by the feature. */
  files: string[];
  dependencies?: string[];
  devDependencies?: string[];
  /** Subpath imports (`imports` in package.json) owned by the feature. */
  imports?: string[];
  edits: Edit[];
}

export interface Manifest {
  version: number;
  template: { name: string; url: string };
  features: Feature[];
  /** Files and edits applied only when none of `features` is kept (e.g. code shared by two connectors). */
  whenNoneKept: { features: string[]; files?: string[]; edits?: Edit[] }[];
  project: { removeFiles: string[]; removeReadmeSections: string[] };
}

export const MANIFEST_VERSION = 1;

export function readManifest(root: string): Manifest {
  const manifest: Manifest = JSON.parse(readFileSync(join(root, 'scaffold/features.json'), 'utf8'));
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`Unsupported manifest version ${manifest.version} (expected ${MANIFEST_VERSION})`);
  }
  return manifest;
}

class ScaffoldError extends Error {
  constructor(message: string) {
    super(`${message}. The template and scaffold/features.json are out of sync.`);
  }
}

function lineIndex(lines: string[], matches: (line: string) => boolean, file: string, what: string): number {
  const found = lines.flatMap((line, i) => (matches(line) ? [i] : []));
  if (found.length !== 1) throw new ScaffoldError(`${what} found ${found.length} times in ${file} (expected once)`);
  return found[0];
}

/** Applies one edit to the lines of a file (in place). */
function applyEdit(lines: string[], edit: Edit): void {
  const { file } = edit;
  if (edit.removeLine !== undefined) {
    const text = edit.removeLine;
    lines.splice(
      lineIndex(lines, (line) => line === text, file, `Line "${text}"`),
      1,
    );
  } else if (edit.removeBullet !== undefined) {
    const prefix = edit.removeBullet;
    const start = lineIndex(lines, (line) => line.startsWith(prefix), file, `Bullet "${prefix}"`);
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith('  ')) end++;
    lines.splice(start, end - start);
  } else if (edit.removeSection !== undefined) {
    const heading = `## ${edit.removeSection}`;
    const start = lineIndex(lines, (line) => line === heading, file, `Section "${heading}"`);
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('## ')) end++;
    lines.splice(start, end - start);
  } else if (edit.removeBlock !== undefined) {
    const text = edit.removeBlock;
    const start = lineIndex(lines, (line) => line === text, file, `Block "${text}"`);
    let end = start + 1;
    while (end < lines.length && lines[end] !== '') end++;
    lines.splice(start, end - start + 1);
  } else if (edit.removeListItem !== undefined) {
    const { line: prefix, item } = edit.removeListItem;
    const index = lineIndex(lines, (line) => line.startsWith(prefix), file, `List "${prefix}"`);
    const match = lines[index].match(/^(.*\[)([^\]]*)(\].*)$/);
    const items = match?.[2].split(',').map((entry) => entry.trim()) ?? [];
    if (!match || !items.includes(item)) throw new ScaffoldError(`"${item}" not found in ${file}: ${lines[index]}`);
    lines[index] = match[1] + items.filter((entry) => entry && entry !== item).join(', ') + match[3];
  } else {
    throw new ScaffoldError(`Unknown edit for ${file}: ${JSON.stringify(edit)}`);
  }
}

/** Applies edits file by file; a file ends with exactly one newline and no double blank lines. */
function applyEdits(root: string, edits: Edit[]): void {
  const byFile = new Map<string, Edit[]>();
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  for (const [file, fileEdits] of byFile) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    for (const edit of fileEdits) applyEdit(lines, edit);
    const text = lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
    writeFileSync(join(root, file), text + '\n');
  }
}

function removeFiles(root: string, files: string[]): void {
  for (const file of files) {
    if (!existsSync(join(root, file))) throw new ScaffoldError(`${file} not found`);
    rmSync(join(root, file), { recursive: true });
  }
}

const readJson = (root: string, file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const writeJson = (root: string, file: string, value: unknown) =>
  writeFileSync(join(root, file), JSON.stringify(value, null, 2) + '\n');

/** Removes every feature not in `keep`, with its files, dependencies, subpath imports and mentions. */
export function removeFeatures(root: string, manifest: Manifest, keep: string[]): void {
  const unknown = keep.filter((id) => !manifest.features.some((feature) => feature.id === id));
  if (unknown.length) throw new Error(`Unknown feature(s): ${unknown.join(', ')}`);

  const removed = manifest.features.filter((feature) => !keep.includes(feature.id));
  const shared = manifest.whenNoneKept.filter((rule) => !rule.features.some((id) => keep.includes(id)));

  removeFiles(root, [...removed.flatMap((f) => f.files), ...shared.flatMap((rule) => rule.files ?? [])]);
  applyEdits(root, [...removed.flatMap((f) => f.edits), ...shared.flatMap((rule) => rule.edits ?? [])]);

  const pkg = readJson(root, 'package.json');
  const drop = (section: string, names: string[]) => {
    for (const name of names) {
      if (!pkg[section] || !(name in pkg[section])) throw new ScaffoldError(`${name} not found in ${section}`);
      delete pkg[section][name];
    }
  };
  drop(
    'dependencies',
    removed.flatMap((f) => f.dependencies ?? []),
  );
  drop(
    'devDependencies',
    removed.flatMap((f) => f.devDependencies ?? []),
  );
  drop(
    'imports',
    removed.flatMap((f) => f.imports ?? []),
  );
  writeJson(root, 'package.json', pkg);
}

/** Every file under `dir`, skipping dependencies and version control. */
function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.git') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** Names the project `name` and drops what belongs to the template itself (license, credits, this folder). */
export function personalize(root: string, manifest: Manifest, name: string): void {
  const { name: templateName, url } = manifest.template;
  // A scoped name ("@acme/app") is not valid everywhere the name is used (e.g. APP_NAME, Kafka client ids)
  const shortName = name.replace(/^@[^/]+\//, '');

  const {
    name: _n,
    version: _v,
    description: _d,
    keywords: _k,
    author: _a,
    license: _l,
    ...rest
  } = readJson(root, 'package.json');
  writeJson(root, 'package.json', {
    name,
    version: '0.1.0',
    private: true,
    description: '',
    license: 'UNLICENSED',
    ...rest,
  });

  if (existsSync(join(root, 'package-lock.json'))) {
    const lock = readJson(root, 'package-lock.json');
    lock.name = name;
    lock.version = '0.1.0';
    if (lock.packages?.[''])
      lock.packages[''] = { ...lock.packages[''], name, version: '0.1.0', license: 'UNLICENSED' };
    writeJson(root, 'package-lock.json', lock);
  }

  removeFiles(root, manifest.project.removeFiles);

  for (const file of listFiles(root)) {
    if (file.endsWith('README.md') || file.endsWith('package-lock.json')) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(templateName)) writeFileSync(file, text.replaceAll(templateName, shortName));
  }

  applyEdits(
    root,
    manifest.project.removeReadmeSections.map((section) => ({ file: 'README.md', removeSection: section })),
  );
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const title = /^# .*\n\n(?:.+\n)+/;
  if (!title.test(readme)) throw new ScaffoldError('README title and introduction not found');
  writeFileSync(
    join(root, 'README.md'),
    readme.replace(title, `# ${name}\n\nCreated with [${templateName}](${url}).\n`),
  );
}

/** Removes the features not in `features` and personalizes the project. */
export function scaffold(root: string, options: { name: string; features: string[] }): void {
  const manifest = readManifest(root);
  removeFeatures(root, manifest, options.features);
  personalize(root, manifest, options.name);
}

function parseFeatures(value: string): string[] {
  if (value.trim() === 'none') return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { name: { type: 'string' }, features: { type: 'string' } } });
  const root = dirname(import.meta.dirname);
  const manifest = readManifest(root);
  const features = values.features
    ? parseFeatures(values.features)
    : manifest.features.filter((feature) => feature.default).map((feature) => feature.id);
  if (!values.name) {
    console.error('Usage: node scaffold/scaffold.ts --name <project-name> [--features <ids>|none]');
    process.exit(1);
  }
  try {
    scaffold(root, { name: values.name, features });
    console.log(`Created ${values.name} with features: ${features.join(', ') || 'none'}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
