import { HARNESS_ENV_VARS, scanEnv } from '../env-scan.js';
/** Claude v6 projection: strict settings JSON, AUTH_TOKEN, model aliases and an ownership marker. No API_KEY or helper is written. */
import { join } from 'node:path';
import type { Detection, HarnessProfile } from '@pac/core/contract';
import { configDir } from '../paths.js';
import { PROFILE_ID_RE } from '@pac/core/fs';
import { detectBasic } from '../detect.js';
import { getPath } from '../merge/json.js';
import { serverBase } from './pi.js';
import { bad, ENV_RE, JsonHarnessAdapter, type AdapterOptions, type Desired, type FilePlan } from './base.js';

export type ClaudeAdapterOptions = AdapterOptions;

/** Managed-settings locations (presence only), per docs "Managed settings". */
export function claudeManagedPaths(platform: NodeJS.Platform): string[] {
  const dir = platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code';
  const sep = platform === 'win32' ? '\\' : '/';
  return [`${dir}${sep}managed-settings.json`, `${dir}${sep}managed-settings.d`];
}

/** Claude Code appends /v1/messages itself, so a trailing /v1 is dropped. */
export function claudeBaseUrl(serverUrl: string): string { return serverBase(serverUrl).replace(/\/v1$/, ''); }

export function claudeEnv(p: HarnessProfile): Record<string, string> {
  const m = p.models;
  const out: Record<string, string> = { ANTHROPIC_BASE_URL: claudeBaseUrl(p.serverUrl), SWIFT_CLIENT_MANAGED: p.id };
  if (m.custom) out.ANTHROPIC_CUSTOM_MODEL_OPTION = m.custom;
  if (p.claude?.setModel !== false) out.ANTHROPIC_MODEL = m.main;
  out.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus ?? m.main;
  out.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet ?? m.main;
  out.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku ?? m.small ?? m.main;
  return out;
}

const CRED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export class ClaudeAdapter extends JsonHarnessAdapter {
  readonly id = 'claude' as const;
  constructor(o: ClaudeAdapterOptions) { super(o); }

  get dir() { return configDir(this.id, this.o.env); }
  get settingsPath() { return join(this.dir, 'settings.json'); }
  protected configPaths() { return [this.settingsPath]; }
  protected parseText(text: string): Record<string, unknown> {
    try { const root: unknown = JSON.parse(text.trim() || '{}'); if (!root || typeof root !== 'object' || Array.isArray(root)) return bad('Settings must be a JSON object'); return root as Record<string, unknown>; }
    catch { return bad('Claude settings must be strict JSON; not modified'); }
  }


  protected recoveredOwnership(_path: string, _text: string, root: Record<string, unknown>) {
    const env = root.env as Record<string, unknown> | undefined;
    const id = env?.[this.o.owner ? 'SWIFT_CLI_MANAGED' : 'SWIFT_CLIENT_MANAGED'];
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id)) return undefined;
    const keys = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_CUSTOM_MODEL_OPTION', this.o.owner ? 'SWIFT_CLI_MANAGED' : 'SWIFT_CLIENT_MANAGED'];
    return { settings: keys.map((key) => `env.${key}`), profileId: id };
  }

  private async statAny(p: string) { return (await this.o.fs.ops.stat(p).catch(() => null)) !== null; }

  async detect(): Promise<Detection> {
    const d = await detectBasic(this.id, this.o);
    if (this.o.env.env.CLAUDE_CONFIG_DIR) d.notes.push('Using CLAUDE_CONFIG_DIR');
    for (const p of claudeManagedPaths(this.o.env.platform)) {
      if (await this.statAny(p)) d.notes.push(`Managed settings found (${p}); they override user settings (not read or modified)`);
    }
    if (this.o.cwd) {
      for (const f of ['settings.json', 'settings.local.json']) {
        if (await this.statAny(join(this.o.cwd, '.claude', f))) d.notes.push(`Project .claude/${f} found in the current directory; it overrides user settings (not modified)`);
      }
    }
    return d;
  }

  protected async desiredFor(p: HarnessProfile): Promise<Map<string, Desired>> {
    if (!PROFILE_ID_RE.test(p.id)) bad('Invalid profile id');
    if (p.envVar !== undefined && !ENV_RE.test(p.envVar)) bad('Invalid env var name');
    const existing = await this.load(this.settingsPath);
    if (getPath(existing.root, ['env', this.o.owner ? 'SWIFT_CLIENT_MANAGED' : 'SWIFT_CLI_MANAGED']) !== undefined) bad('This config is managed by the other client; detach there first');
    const d: Desired = new Map<string, unknown>([['apiKeyHelper', undefined], ['env.ANTHROPIC_AUTH_TOKEN', await this.o.getKey?.(p) ?? bad('Select a token again before applying')]]);
    const desiredEnv = claudeEnv(p);
    if (this.o.owner) { delete desiredEnv.SWIFT_CLIENT_MANAGED; desiredEnv.SWIFT_CLI_MANAGED = p.id; }
    for (const [k, v] of Object.entries(desiredEnv)) d.set(`env.${k}`, v);
    return new Map([[this.settingsPath, d]]);
  }

  protected collisionSettings(): string[] { return ['apiKeyHelper', 'env.ANTHROPIC_BASE_URL']; }

  /** Original token stays in private main-only state so detach can restore it. Helpers are removed. */
  protected rememberOriginal(_path: string, setting: string): boolean { return setting !== 'apiKeyHelper'; }

  protected async planWarnings(p: HarnessProfile, files: FilePlan[]): Promise<string[]> {
    const w: string[] = ['Keys are plaintext; Claude commands, hooks and MCP children inherit the token. Exclude configs from sync and dotfiles; set a server quota limit.'];
    if (Object.values(p.models).some((m) => m?.includes('placeholder'))) w.push('Claude models pending: replace placeholders before apply or paid tests');
    const want = claudeEnv(p);
    const scan = await scanEnv(HARNESS_ENV_VARS.claude.map((v) => want[v.name] ? { ...v, expected: want[v.name] } : v), {
      processEnv: this.o.env.env, platform: this.o.env.platform, home: this.o.env.home, exec: this.o.exec, readText: async () => null,
    }, { loginShell: false, rcFiles: false });
    w.push(...scan.findings.map((f) => f.message));
    const root = files[0]?.root;
    for (const v of CRED_ENV) if (getPath(root, ['env', v]) !== undefined) w.push(v === 'ANTHROPIC_AUTH_TOKEN' ? 'settings.json env.ANTHROPIC_AUTH_TOKEN is set (value not shown); it will be replaced; detach restores the original value' : 'settings.json env.ANTHROPIC_API_KEY is set (value not shown); remove it to avoid credential conflicts');
    for (const mp of claudeManagedPaths(this.o.env.platform)) if (await this.statAny(mp)) w.push(`Managed settings present (${mp}); they take precedence over these user settings`);
    if (this.o.cwd) {
      for (const f of ['settings.json', 'settings.local.json']) {
        if (await this.statAny(join(this.o.cwd, '.claude', f))) w.push(`Project .claude/${f} may override these user settings`);
      }
    }
    return w;
  }
}
