import { lstat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
/** Same-user processes can forge the uninstall nonce. This gate prevents accidental cleanup, not same-user DoS. */
export async function consumeUninstallNonce(packaged: boolean, argv: string[], dataDir: string): Promise<boolean> {
  if (!packaged || !argv.includes('--harness-detach-all')) return false;
  const path = join(dataDir, 'harness', 'uninstall.nonce');
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile() || st.isSymbolicLink() || Date.now() - st.mtimeMs > 60_000 || st.size > 128) return false;
  const nonce = await readFile(path, 'utf8');
  if (!/^swift-uninstall:[0-9]+$/.test(nonce)) return false;
  await unlink(path);
  return true;
}
