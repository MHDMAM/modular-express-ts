import type { Router } from 'express';
import { globSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Imports every router file matching the glob patterns (sorted by path) and returns their default exports. */
export default async function loadRouters(patterns: string[]): Promise<Router[]> {
  const files = patterns
    .flatMap((pattern) => globSync(pattern))
    .filter((file) => !file.endsWith('.d.ts'))
    .sort();
  const modules = await Promise.all(files.map((file) => import(pathToFileURL(path.resolve(file)).href)));
  return modules.map((module) => module.default);
}
