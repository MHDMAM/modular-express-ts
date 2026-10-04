import { writeSync } from 'node:fs';

/**
 * Stops the process with `message` on stderr. For configuration errors, which are found before the logger exists:
 * the message says what to fix, so it is printed alone instead of as an uncaught error with its stack trace.
 * Written synchronously, so it is not lost when the process exits.
 */
export function failStartup(message: string): never {
  writeSync(2, `${message}\n`);
  process.exit(1);
}
