import { applyConfigFile, ConfigFileError } from './config-file.js';
import { failStartup } from './fail-startup.js';

try {
  applyConfigFile();
} catch (error) {
  if (error instanceof ConfigFileError) failStartup(error.message);
  throw error;
}
