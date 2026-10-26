import { acquireFileLock } from './lock.js';
import { protectPath } from './permissions.js';
import { chmod, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import type { FsOps } from './ops.js';

export const nodeFsOps: FsOps = {
  acquireLock: acquireFileLock,
  readFile: async (p) => new Uint8Array(await readFile(p)),
  async writeFile(p, data, mode) {
    const fh = await open(p, 'wx', mode);
    try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
    await chmod(p, mode);
    await protectPath(p);
  },
  async rename(a, b) {
    for (const delay of [0, 50, 200, 800]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try { await rename(a, b); return; } catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '') || delay === 800) throw e; }
    }
  },
  async fsyncDir(p) {
    if (process.platform === 'win32') return;
    try { const fh = await open(p, 'r'); try { await fh.sync(); } finally { await fh.close(); } } catch { /* best effort */ }
  },
  async stat(p) {
    try { const s = await stat(p); return { mtimeMs: s.mtimeMs, size: s.size, mode: s.mode & 0o7777, isFile: s.isFile(), isDirectory: s.isDirectory() }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  },
  chmod: async (p, m) => { await chmod(p, m); await protectPath(p, (await stat(p)).isDirectory()); },
  mkdir: async (p, m) => { await mkdir(p, { recursive: true, mode: m }); await protectPath(p, true); },
  rm: (p) => rm(p, { force: true, recursive: true }),
  readdir: async (p) => { try { return await readdir(p); } catch { return []; } },
  realpath: async (p) => { try { return await realpath(p); } catch { return null; } },
};
