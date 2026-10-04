import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const root = join(import.meta.dirname, '../..');

let template: string | undefined;
const dirs: string[] = [];

/** A fresh copy of the template's files (tracked and new, never ignored or excluded ones) in a temporary folder. */
export function copyTemplate(): string {
  if (!template) {
    template = mkdtempSync(join(tmpdir(), 'scaffold-template-'));
    const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
    });
    for (const file of files.stdout.split('\0').filter((f) => f && existsSync(join(root, f)))) {
      mkdirSync(dirname(join(template, file)), { recursive: true });
      cpSync(join(root, file), join(template, file));
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  dirs.push(dir);
  cpSync(template, dir, { recursive: true });
  return dir;
}

/** Removes every copy made by `copyTemplate` (call it in `afterAll`). */
export function removeTemplateCopies(): void {
  for (const dir of [...(template ? [template] : []), ...dirs.splice(0)]) rmSync(dir, { recursive: true, force: true });
  template = undefined;
}
