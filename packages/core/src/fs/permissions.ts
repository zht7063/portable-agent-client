import { chmod, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PaException } from '../contract/errors.js';
const run = promisify(execFile);
const fail = (): never => { throw new PaException({ code: 'VALIDATION', message: 'Private file permissions could not be verified' }); };
async function principals(): Promise<string[]> {
  const { stdout } = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
  const sid = stdout.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
  if (!sid) return fail();
  return [sid, 'S-1-5-18', 'S-1-5-32-544'];
}
export async function verifyPrivatePath(path: string, dir = false): Promise<void> {
  const st = await lstat(path);
  if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile())) fail();
  if (process.platform !== 'win32') {
    if ((st.mode & 0o777) !== (dir ? 0o700 : 0o600) || st.uid !== process.getuid?.()) fail();
    return;
  }
  const allowed = await principals();
  // /save emits numeric SIDs and the protected DACL flag, independent of OS language.
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = await mkdtemp(join(tmpdir(), 'swift-acl-'));
  try {
    const out = join(tmp, 'acl');
    await run('icacls', [path, '/save', out, '/q']);
    const sddl = await readFile(out, 'utf16le');
    const dacl = sddl.match(/D:([^\r\n]+)/)?.[1] ?? '';
    if (!dacl.startsWith('P')) fail();
    const aces = [...dacl.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!.split(';'));
    const aliases: Record<string, string> = { SY: 'S-1-5-18', BA: 'S-1-5-32-544' };
    if (aces.length !== 3 || aces.some((a) => a[0] !== 'A' || a[1]?.includes('ID') || a[2] !== 'FA' || !allowed.includes(aliases[a[5]!] ?? a[5]!))) fail();
    if (new Set(aces.map((a) => aliases[a[5]!] ?? a[5]!)).size !== 3) fail();
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
export async function protectPath(path: string, dir = false): Promise<void> {
  if (process.platform === 'win32') {
    const ids = await principals();
    // Reset first to remove explicit foreign grants, then remove inheritance.
    await run('icacls', [path, '/reset', '/q']);
    await run('icacls', [path, '/inheritance:r', '/grant:r', ...ids.map((sid) => `*${sid}:${dir ? '(OI)(CI)' : ''}F`), '/q']);
  } else await chmod(path, dir ? 0o700 : 0o600);
  await verifyPrivatePath(path, dir);
}
