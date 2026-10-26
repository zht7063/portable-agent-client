import { basename, join } from 'node:path';
import { type Core, type HarnessId, type HarnessProfile } from '@pac/core';
import { ClaudeAdapter, CodexAdapter, ControlledFs, createHarness, nodeExec, nodeFsOps, StateStore, KeyFile, Providers, createConnectivity, type Harness } from '@pac/harness';
import type { Keyring } from '@pac/keychain';
import { HarnessMigration } from './harness-migration';
import { SERVER_ORIGIN } from './server-origin';

export interface HarnessHostOptions {
  home: string; dataDir: string; env: Record<string, string | undefined>; platform: NodeJS.Platform;
  keyFile?: KeyFile;
  /** Legacy test injection; never used for harness credentials. */
  keyring?: Keyring; helperPath?: string;
  fs?: ControlledFs; exec?: typeof nodeExec; getCore?: () => Core;
  ensureKey?: (profileId: string, harness: HarnessId, tokenId: number) => Promise<void>;
  fetchKey?: (tokenId: number) => Promise<string>;
  serverOrigin?: string; cwd?: string;
}
/** Main-process owner. No credential-bearing value escapes this module. */
export class HarnessHost {
  readonly harness: Harness;
  readonly state: StateStore;
  readonly migration: HarnessMigration;
  readonly helperPath = '';
  readonly keyFile: KeyFile;
  readonly providers: Providers;
  readonly connectivity: ReturnType<typeof createConnectivity>;
  constructor(o: HarnessHostOptions) {
    const fs = o.fs ?? new ControlledFs({ ops: nodeFsOps, roots: [o.home, o.dataDir], dataDir: o.dataDir });
    this.state = new StateStore(fs);
    this.providers = new Providers(fs, this.state);
    this.keyFile = o.keyFile ?? new KeyFile(o.dataDir);
    const origin = o.serverOrigin ?? SERVER_ORIGIN;
    const env = { home: o.home, env: o.env, platform: o.platform };
    this.migration = new HarnessMigration(fs, this.state, env);
    const exec = o.exec ?? nodeExec;
    const common = {
      fs, state: this.state, env, exec, helperPath: '', ...(o.cwd ? { cwd: o.cwd } : {}),
      getKey: async (p: HarnessProfile) => {
        if (p.serverUrl !== origin) throw new Error('Server changed; select token again');
        return this.keyFile.get(p.id);
      },
      afterDetach: async (ids: string[], harness: HarnessId) => {
        const st = await this.state.load();
        for (const id of ids) {
          const key = (await this.keyFile.load())[id]?.key;
          // Purge only snapshots which contain this credential; remove paired metadata too.
          const purge = async (dir: string): Promise<void> => {
            for (const name of await fs.ops.readdir(dir)) {
              const path = await fs.assertAllowed(join(dir, name));
              const stat = await fs.ops.stat(path);
              if (stat?.isDirectory) await purge(path);
              else if (stat?.isFile && basename(dir) === harness && path.endsWith('.bak')) {
                const text = new TextDecoder().decode(await fs.ops.readFile(path));
                const ownedMarker = text.includes(`# managed by swift-client provider=${id} v=2`) || new RegExp(`"SWIFT_CLIENT_MANAGED"\\s*:\\s*"${id}"`).test(text);
                if ((key && text.includes(key)) || ownedMarker) {
                  await fs.ops.rm(path);
                  await fs.ops.rm(path.slice(0, -4) + '.meta.json');
                }
              }
            }
          };
          await purge(fs.backupDir);
          if (!Object.values(st.files).some((f) => f.profileId === id)) await this.keyFile.delete(id);
        }
      },
    };
    this.harness = createHarness({ fs, state: this.state, exec, env, adapters: { claude: new ClaudeAdapter(common), codex: new CodexAdapter(common) } });
    this.connectivity = createConnectivity({ origin, keys: this.keyFile, fs, env, exec });
  }
  async keyringStatus(_profileId?: string) { return { available: true, backend: 'none' as const, entries: [] }; }
  async provisionKey(core: Core, profileId: string, _harness: HarnessId, keyId: number): Promise<void> {
    await this.keyFile.set(profileId, await core.keys.secret(keyId), `token:${keyId}`);
  }
  async revokeKey(profileId: string, _harness?: HarnessId): Promise<void> { await this.keyFile.delete(profileId); }
}
