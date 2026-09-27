import type { Router } from 'express';
import { glob } from 'glob';
import path from 'path';

/** Imports every router file matching the glob patterns (sorted by path) and returns their default exports. */
export default async function loadRouters(patterns: string[]): Promise<Router[]> {
  const files = patterns
    .flatMap((pattern) => glob.sync(pattern.replace(/\\/g, '/')))
    .filter((file) => !file.endsWith('.d.ts'))
    .sort();
  const modules = await Promise.all(files.map((file) => import(path.resolve(file))));
  return modules.map((module) => module.default);
}
