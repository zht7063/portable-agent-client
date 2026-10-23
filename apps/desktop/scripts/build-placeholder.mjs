// M1: copies the placeholder renderer to dist/renderer (M2 replaces this with the patched upstream web build).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(app, 'dist', 'renderer'), { recursive: true });
cpSync(join(app, 'src', 'placeholder', 'index.html'), join(app, 'dist', 'renderer', 'index.html'));
