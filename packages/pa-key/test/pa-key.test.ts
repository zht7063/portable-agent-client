import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { accountFor, MemoryKeyring, NoKeyring } from '@pac/keychain';
import { installWrapper, renderWrapper, runPaKey } from '../src/index.js';

const SECRET = 'sk-' + 'K'.repeat(48);
const io = () => { const o = { out: '', err: '' }; return { o, io: { stdout: (s: string) => { o.out += s; }, stderr: (s: string) => { o.err += s; } } }; };

describe('pa-key', () => {
  it('prints exactly the key, nothing else', async () => {
    const k = new MemoryKeyring();
    await k.set(accountFor('default', 'claude'), SECRET);
    const { o, io: i } = io();
    expect(await runPaKey(['default', 'claude'], k, i)).toBe(0);
    expect(o.out).toBe(SECRET);
    expect(o.err).toBe('');
  });
  it('missing entry -> exit 3; unavailable -> exit 4 (env mode hint); bad args -> exit 2; stderr never has secrets', async () => {
    const k = new MemoryKeyring();
    await k.set(accountFor('default', 'pi'), SECRET);
    for (const [args, keyring, code] of [
      [['default', 'codex'], k, 3],
      [['default', 'pi'], new MemoryKeyring(false), 4],
      [['default', 'pi'], new NoKeyring('no dbus'), 4],
      [['default'], k, 2],
      [['../x', 'pi'], k, 2],
      [['default', 'gemini'], k, 2],
      [['default', 'pi', 'extra'], k, 2],
    ] as const) {
      const { o, io: i } = io();
      expect(await runPaKey([...args], keyring, i)).toBe(code);
      expect(o.out).toBe('');
      expect(o.err).not.toContain(SECRET);
      expect(o.err).not.toMatch(/sk-/);
    }
  });
});

describe('pa-key wrapper (D4: inside the client directory, absolute path)', () => {
  it('renders sh / cmd wrappers with ELECTRON_RUN_AS_NODE and safe quoting', () => {
    expect(renderWrapper({ dir: '/d', execPath: "/Apps/Portable Agent's.app/x", scriptPath: '/r/pa-key.cjs', platform: 'darwin' }))
      .toContain(`ELECTRON_RUN_AS_NODE=1 exec '/Apps/Portable Agent'\\''s.app/x' '/r/pa-key.cjs' "$@"`);
    expect(renderWrapper({ dir: 'C:\\d', execPath: 'C:\\Program Files\\PA\\pa.exe', scriptPath: 'C:\\PA\\pa-key.cjs', platform: 'win32' }))
      .toBe('@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\PA\\pa.exe" "C:\\PA\\pa-key.cjs" %*\r\n');
    expect(() => renderWrapper({ dir: '/d', execPath: 'rel', scriptPath: '/x', platform: 'linux' })).toThrow();
    expect(() => renderWrapper({ dir: 'C:\\d', execPath: 'C:\\a%b', scriptPath: 'C:\\x', platform: 'win32' })).toThrow();
  });
  it.runIf(process.platform !== 'win32')('installed wrapper is 0700 and runs the script with the bundled runtime, passing args', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-wrap-'));
    const script = join(dir, 'probe.cjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), ran: process.env.ELECTRON_RUN_AS_NODE }))');
    const path = await installWrapper({ dir: join(dir, 'bin'), execPath: process.execPath, scriptPath: script });
    expect(path).toBe(join(dir, 'bin', 'pa-key'));
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    const { stdout } = await promisify(execFile)(path, ['default', 'codex'], { env: { PATH: '/usr/bin:/bin', HOME: dir } });
    expect(JSON.parse(stdout)).toEqual({ args: ['default', 'codex'], ran: '1' });
    expect(await readFile(path, 'utf8')).not.toMatch(/sk-/);
  });
});
