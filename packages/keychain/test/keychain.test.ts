import { describe, expect, it } from 'vitest';
import { accountFor, createKeyring, keyringStatus, MemoryKeyring, NapiKeyring, NoKeyring, SecretToolKeyring, type ExecLite } from '../src/index.js';

const SECRET = 'sk-' + 'K'.repeat(48);

describe('keyring backends', () => {
  it('secret-tool: secret only via stdin, never argv; lookup/clear; probe detects availability', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const store = new Map<string, string>();
    const exec: ExecLite = async (_cmd, args, o) => {
      calls.push({ args, input: o.input });
      const acct = args[args.indexOf('account') + 1]!;
      if (args[0] === 'store') { store.set(acct, o.input ?? ''); return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'lookup') return store.has(acct) ? { code: 0, stdout: store.get(acct)!, stderr: '' } : { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'clear') { store.delete(acct); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 2, stdout: '', stderr: 'bad' };
    };
    const k = new SecretToolKeyring(exec, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' });
    expect(await k.available()).toEqual({ ok: true });
    await k.set('default/codex', SECRET);
    expect(await k.get('default/codex')).toBe(SECRET);
    expect(await k.delete('default/codex')).toBe(true);
    expect(await k.get('default/codex')).toBeNull();
    for (const c of calls) expect(c.args.join(' ')).not.toContain(SECRET);
    expect(calls.find((c) => c.args[0] === 'store')!.input).toBe(SECRET);
    expect(calls.find((c) => c.args[0] === 'store')!.args).toEqual(['store', '--label=Portable Agent (default/codex)', 'service', 'portable-agent', 'account', 'default/codex']);
  });
  it('secret-tool unavailable: no D-Bus, not installed, or service error', async () => {
    const never: ExecLite = async () => { throw new Error('must not run'); };
    expect(await new SecretToolKeyring(never, {}).available()).toMatchObject({ ok: false, reason: expect.stringMatching(/D-Bus/) });
    const missing: ExecLite = async () => ({ code: null, stdout: '', stderr: 'spawn failed' });
    expect(await new SecretToolKeyring(missing, { DBUS_SESSION_BUS_ADDRESS: 'x' }).available()).toMatchObject({ ok: false, reason: expect.stringMatching(/not installed/) });
    const broken: ExecLite = async () => ({ code: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11' });
    const k = new SecretToolKeyring(broken, { DBUS_SESSION_BUS_ADDRESS: 'x' });
    expect((await k.available()).ok).toBe(false);
    await expect(k.get('default/pi')).rejects.toThrow('keychain lookup failed');
  });
  it('napi backend (macOS/Windows) uses service "portable-agent" and account "<profile>/<harness>"', async () => {
    const seen: string[] = [];
    const store = new Map<string, string>();
    const napi = () => ({ Entry: class { constructor(private s: string, private u: string) { seen.push(`${s}|${u}`); }
      getPassword() { return store.get(this.u) ?? null; } setPassword(p: string) { store.set(this.u, p); } deletePassword() { return store.delete(this.u); } } });
    const k = createKeyring({ platform: 'darwin', napi });
    expect(k).toBeInstanceOf(NapiKeyring);
    expect(k.backend).toBe('macos-keychain');
    await k.set(accountFor('p1', 'pi'), SECRET);
    expect(await k.get('p1/pi')).toBe(SECRET);
    expect(seen[0]).toBe('portable-agent|p1/pi');
    expect(createKeyring({ platform: 'win32', napi }).backend).toBe('windows-credential-manager');
    expect(createKeyring({ platform: 'linux', env: {} }).backend).toBe('secret-service');
    expect(createKeyring({ platform: 'aix' }).backend).toBe('none');
    const bad = new NapiKeyring('macos-keychain', () => { throw new Error('dlopen'); });
    expect(await bad.available()).toEqual({ ok: false, reason: 'keychain library failed to load' });
  });
  it('status reports presence only; unavailable -> fallback env, never plaintext', async () => {
    const k = new MemoryKeyring();
    await k.set('default/claude', SECRET);
    const s = await keyringStatus(k, ['default']);
    expect(s).toEqual({ available: true, backend: 'memory', entries: [
      { profileId: 'default', harness: 'pi', present: false }, { profileId: 'default', harness: 'claude', present: true }, { profileId: 'default', harness: 'codex', present: false },
    ] });
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(await keyringStatus(new NoKeyring('no dbus'), ['default'])).toEqual({ available: false, backend: 'none', fallback: 'env', reason: 'no dbus', entries: [] });
  });
  it('accountFor validates input', () => {
    expect(() => accountFor('a/b', 'pi')).toThrow();
    expect(() => accountFor('ok', 'x' as never)).toThrow();
  });
});
