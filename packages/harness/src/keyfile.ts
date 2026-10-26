import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ControlledFs, nodeFsOps } from '@pac/core/fs';
import { PaException } from '@pac/core/contract';
import { protectPath, verifyPrivatePath } from '@pac/core/fs';

export const PROVIDER_ID = /^[a-z0-9-]{1,32}$/;
export const keyFingerprint = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 8);
export interface KeyEntry { key: string; source: string; fp: string }
const fail = (): never => { throw new PaException({ code: 'VALIDATION', message: 'Key file invalid or permissions unsafe; repair permissions or select token again' }); };

/** Main-only plaintext credential store. Values must never cross IPC. */
export class KeyFile {
  readonly path: string;
  readonly dir: string;
  private fs: ControlledFs;
  private mutations: Promise<void> = Promise.resolve();
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(fn);
    this.mutations = result.then(() => {}, () => {});
    return result;
  }
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'harness');
    this.path = join(this.dir, 'keys.json');
    this.fs = new ControlledFs({ ops: nodeFsOps, roots: [dataDir], dataDir });
  }
  private id(id: string) { if (!PROVIDER_ID.test(id)) fail(); }
  async load(): Promise<Record<string, KeyEntry>> {
    if (!(await nodeFsOps.stat(this.path))) return {};
    await verifyPrivatePath(this.dir, true);
    await verifyPrivatePath(this.path);
    const raw: unknown = JSON.parse((await this.fs.readText(this.path))!.text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
    for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
      this.id(id);
      const v = e as KeyEntry;
      if (!v || typeof v.key !== 'string' || !v.key || typeof v.source !== 'string' || v.fp !== keyFingerprint(v.key)) fail();
    }
    return raw as Record<string, KeyEntry>;
  }
  async get(id: string): Promise<string> { this.id(id); return (await this.load())[id]?.key ?? fail(); }
  set(id: string, key: string, source: string): Promise<{ maskedKey: string; fingerprint: string }> {
    return this.serialize(() => this.writeEntry(id, key, source));
  }
  private async writeEntry(id: string, key: string, source: string): Promise<{ maskedKey: string; fingerprint: string }> {
    this.id(id);
    if (!key || key.length > 4096 || /[\r\n\0]/.test(key)) fail();
    const entries = await this.load();
    entries[id] = { key, source, fp: keyFingerprint(key) };
    await nodeFsOps.mkdir(this.dir, 0o700);
    await protectPath(this.dir, true);
    await this.fs.atomicWrite(this.path, JSON.stringify(entries));
    await protectPath(this.path);
    return { maskedKey: '***', fingerprint: entries[id].fp };
  }
  delete(id: string): Promise<void> { return this.serialize(() => this.deleteEntry(id)); }
  private async deleteEntry(id: string): Promise<void> {
    this.id(id);
    const entries = await this.load();
    delete entries[id];
    if (Object.keys(entries).length) await this.fs.atomicWrite(this.path, JSON.stringify(entries));
    else await this.fs.remove(this.path);
  }
}
