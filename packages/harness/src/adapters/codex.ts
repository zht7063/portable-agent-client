/** Codex v6 projection: a plaintext bearer provider in user config, selection in swift.config.toml. auth.json is existence-only. */
import { join } from 'node:path';
import type { Detection, HarnessProfile } from '@pac/core/contract';
import { configDir } from '../paths.js';
import { PROFILE_ID_RE } from '@pac/core/fs';
import { detectBasic } from '../detect.js';
import type { JsonEdit } from '../merge/json.js';
import { getPath } from '../merge/json.js';
import { mergeOwnedToml, parseToml } from '../merge/toml.js';
import { serverBase } from './pi.js';
import { bad, JsonHarnessAdapter, PROVIDER_RE, type AdapterOptions, type Desired, type FilePlan } from './base.js';

export type CodexAdapterOptions = AdapterOptions;

export function codexBaseUrl(serverUrl: string): string {
  const b = serverBase(serverUrl);
  return b.endsWith('/v1') ? b : `${b}/v1`;
}

export function codexModel(p: HarnessProfile): string { return p.models.codex ?? p.models.main; }

export function codexProvider(p: HarnessProfile, key: string): Record<string, unknown> {
  if (!key) bad('Select a token again before applying');
  return { name: 'swift-client', base_url: codexBaseUrl(p.serverUrl), wire_api: 'responses', experimental_bearer_token: key };
}

/** Static check of our provider table (mirrors codex ModelProviderInfo::validate for the auth part). */
export function validateCodexProvider(t: Record<string, unknown>): void {
  if (t.wire_api !== 'responses') bad('wire_api must be "responses"');
  if (t.auth || t.env_key || t.requires_openai_auth) bad('Helper and env authentication are not supported');
  if (typeof t.experimental_bearer_token !== 'string' || !t.experimental_bearer_token) bad('Bearer token missing');
}

export class CodexAdapter extends JsonHarnessAdapter {
  readonly id = 'codex' as const;
  constructor(o: CodexAdapterOptions) { super(o); }

  get dir() { return configDir(this.id, this.o.env); }
  get configPath() { return join(this.dir, 'config.toml'); }
  get authPath() { return join(this.dir, 'auth.json'); }
  protected configPaths() { return [this.configPath, join(this.dir, 'swift.config.toml')]; }
  protected parseText(text: string) { return parseToml(text); }
  protected mergeText(text: string, edits: JsonEdit[]): string {
    let out = mergeOwnedToml(text.replace(/^# managed by swift-client provider=.* v=2\r?\n/gm, ''), edits.map((e) => ({ path: e.path.map(String), value: e.value })));
    if (edits.some((e) => e.path.join('.') === 'model_providers.swift' && e.value !== undefined)) {
      const marker = `# managed by swift-client provider=${this.currentProfileId ?? 'swift'} v=2${out.includes('\r\n') ? '\r\n' : '\n'}`;
      out = out.replace(/^(\[model_providers\.swift\])/m, marker + '$1');
    }
    return out;
  }

  protected recoveredOwnership(path: string, text: string, root: Record<string, unknown>) {
    const marker = text.match(/^# managed by swift-client provider=([a-z0-9-]{1,32}) v=2\r?$/m)?.[1];
    if (path.endsWith('swift.config.toml') && root.model_provider === 'swift') return { settings: ['model', 'model_provider'], profileId: 'swift' };
    if (!marker) return undefined;
    return { settings: ['model_providers.swift', ...(root.model_provider === 'swift' ? ['model', 'model_provider'] : [])], profileId: marker };
  }

  private async statAny(p: string) { return (await this.o.fs.ops.stat(p).catch(() => null)) !== null; }

  async detect(): Promise<Detection> {
    const d = await detectBasic(this.id, this.o);
    if (this.o.env.env.CODEX_HOME) d.notes.push('Using CODEX_HOME');
    if (await this.exists(this.authPath)) d.notes.push('auth.json exists (not read); swift profile does not change your login');
    if (this.o.cwd && (await this.statAny(join(this.o.cwd, '.codex', 'config.toml')))) d.notes.push('Project .codex/config.toml found in the current directory; it may override user settings (not modified)');
    return d;
  }

  private pid(_p: HarnessProfile) { return 'swift'; }

  protected async desiredFor(p: HarnessProfile): Promise<Map<string, Desired>> {
    if (!PROFILE_ID_RE.test(p.id)) bad('Invalid profile id');
    const pid = this.pid(p);
    if (!PROVIDER_RE.test(pid)) bad('Invalid provider id');
    if (['openai', 'amazon-bedrock', 'amazon-bedrock-runtime', 'gcp', 'ollama', 'ollama-chat', 'lmstudio', 'oss'].includes(pid)) bad('Provider id clashes with a Codex built-in provider');
    const table = codexProvider(p, await this.o.getKey?.(p) ?? bad('Select a token again before applying'));
    validateCodexProvider(table);
    const d: Desired = new Map();
    if (p.codex?.setDefault === true) { d.set('model', codexModel(p)); d.set('model_provider', pid); }
    d.set(`model_providers.${pid}`, table);
    d.set('model_providers.pa', undefined);
    const selection: Desired = new Map([['model', codexModel(p)], ['model_provider', 'swift']]);
    return new Map([[this.configPath, d], [join(this.dir, 'swift.config.toml'), selection]]);
  }

  protected collisionSettings(_path: string, desired: Desired): string[] {
    return [...desired.keys()].filter((k) => k.startsWith('model_providers.'));
  }

  /** model / model_provider are restored on detach; a foreign provider table may hold a bearer token, never stored. */
  protected rememberOriginal(_path: string, setting: string): boolean { return setting === 'model' || setting === 'model_provider'; }

  protected async planWarnings(p: HarnessProfile, files: FilePlan[]): Promise<string[]> {
    const w: string[] = [];
    const root = files[0]?.root ?? {};
    if (await this.exists(this.authPath)) w.push('Codex auth.json exists (not read); your ChatGPT/API login stays as is, only model_provider changes');
    const prof = getPath(root, ['profile']);
    if (typeof prof === 'string') w.push(`config.toml selects profile "${prof}"; its model / model_provider may override ours`);

    if (p.codex?.setDefault !== true) w.push(`Default not changed; run codex --profile swift`);
    if (this.o.cwd && (await this.statAny(join(this.o.cwd, '.codex', 'config.toml')))) w.push('Project .codex/config.toml may override these user settings');
    w.push('Requires the server Responses channel (configured on the server, not by this app); check the channel status before use');
    return w;
  }
}
