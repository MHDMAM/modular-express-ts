import { join } from 'node:path';

process.env.NODE_CONFIG_DIR = join(import.meta.dirname, '../src/config');
