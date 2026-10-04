import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Optional `config.json` for hosts where a file is easier than environment variables (e.g. pm2 on a server): a flat
 * JSON object named like the variables in `.env.example`. Its values are copied into the environment before anything
 * validates it (see `config-file-load.ts`), so the rest of the app only knows environment variables.
 */

export class ConfigFileError extends Error {
  override name = 'ConfigFileError';
}

type Env = Record<string, string | undefined>;

export const DEFAULT_CONFIG_FILE = 'config.json';

/** The variables of a config file's `text`, as strings. Empty values are left out: they mean "use the default". */
export function parseConfigFile(text: string, file: string): Record<string, string> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigFileError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ConfigFileError(`${file} must hold a JSON object of variable names and values`);
  }

  const entries = Object.entries(json);
  const invalid = entries.filter(([, value]) => !['string', 'number', 'boolean'].includes(typeof value));
  if (invalid.length) {
    const names = invalid.map(([name]) => name).join(', ');
    throw new ConfigFileError(`${file}: values must be strings, numbers or booleans (lists comma-separated): ${names}`);
  }
  return Object.fromEntries(entries.map(([name, value]) => [name, String(value)]).filter(([, value]) => value !== ''));
}

/**
 * Copies the config file's variables into `env`. The file is `CONFIG_FILE`, or `config.json` in the working directory
 * when it exists. A variable set in both with different values is an error: neither silently wins.
 */
export function applyConfigFile(env: Env = process.env, cwd = process.cwd()): void {
  const path = resolve(cwd, env.CONFIG_FILE || DEFAULT_CONFIG_FILE);
  if (!existsSync(path)) {
    if (env.CONFIG_FILE) throw new ConfigFileError(`CONFIG_FILE not found: ${path}`);
    return;
  }

  const values = parseConfigFile(readFileSync(path, 'utf8'), path);
  // Values are not shown: they may be secrets
  const conflicts = Object.keys(values).filter((name) => env[name] && env[name] !== values[name]);
  if (conflicts.length) {
    throw new ConfigFileError(
      `Set in both ${path} and the environment (or .env) with different values: ${conflicts.join(', ')}. ` +
        'Keep each variable in one place.',
    );
  }
  Object.assign(env, values);
}
