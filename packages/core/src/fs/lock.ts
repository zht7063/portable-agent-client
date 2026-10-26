import { open, readFile, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { PaException } from '../contract/errors.js';
/** Cooperative process lock; third-party harnesses still require fingerprint checks. */
export async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const claim = async () => {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), host: hostname() }));
    await handle.sync();
    const owned = await handle.stat();
    await handle.close();
    return async () => { const current = await stat(path).catch(() => null); if (current?.ino === owned.ino && current?.mtimeMs === owned.mtimeMs) await unlink(path); };
  };
  try { return await claim(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  let stale = false;
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid: number; at: number; host: string };
    stale = Date.now() - value.at > 30_000;
    if (!stale && value.host === hostname() && Number.isSafeInteger(value.pid) && value.pid > 0) {
      try { process.kill(value.pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
  } catch { /* malformed lock is not authorization to remove another process's lock */ }
  if (!stale) throw new PaException({ code: 'VALIDATION', message: 'Configuration is being written by another process; try again' });
  await unlink(path);
  return claim();
}
