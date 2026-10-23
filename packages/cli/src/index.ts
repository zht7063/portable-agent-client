#!/usr/bin/env node
/**
 * Dev/test-only CLI (not packaged into the desktop client): server config, session status, key check, harness.
 * Login/billing/chat/token management are served by the upstream new-api frontend, not by this CLI.
 * Secrets are never printed. Env: PAC_SERVER_URL (overrides saved URL), PA_CLI_DIR.
 */
import { join } from 'node:path';
import { createCore, findCredentialLeaks, isInsecureServerUrl, normalizeServerUrl, PaException, redact, toPaError } from '@pac/core';
import { createModels } from '@pac/harness';
import { CliConfig } from './config.js';
import { FileKeyVault, FileTokenStore } from './stores/file.js';
import { HARNESS_HELP, runHarness } from './commands/harness.js';

const HELP = `usage: pac <command>  (dev/test only)
  config get | config set-url <url> | config reset   (PAC_SERVER_URL env overrides saved URL; no built-in default)
  status
  models --key <id> | keys check <id>
  ${HARNESS_HELP}
env: PAC_SERVER_URL, PA_CLI_DIR`;

/** env > saved; null when no server is configured (there is no default server). */
export async function effectiveUrl(c: CliConfig): Promise<string | null> {
  const raw = process.env.PAC_SERVER_URL || (await c.load()).serverUrl;
  return raw ? normalizeServerUrl(raw) : null;
}

/** Print only credential-free data. */
function out(v: unknown) {
  const leaks = findCredentialLeaks(v);
  if (leaks.length) throw new Error(`refusing to print credential fields: ${leaks.join(',')}`);
  console.log(JSON.stringify(v, null, 2));
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cmd = args.shift() ?? 'help';
  const dir = process.env.PA_CLI_DIR;
  const store = new FileTokenStore(dir ? join(dir, 'session.json') : undefined);
  const vault = new FileKeyVault(dir ? join(dir, 'keys.json') : undefined);
  const cliConfig = new CliConfig(dir ? join(dir, 'config.json') : undefined);
  if (cmd === 'harness') return runHarness(args, { out, err: (s) => console.error(s) });
  if (cmd === 'config') {
    const sub = args.shift();
    if (sub === 'set-url') {
      const url = normalizeServerUrl(args[0] ?? '');
      const prev = await cliConfig.load();
      await cliConfig.save({ serverUrl: url });
      // Switching servers invalidates the stored session and cached keys.
      if (prev.serverUrl !== url) { await store.clear(); await vault.clear(); }
    } else if (sub === 'reset') {
      await cliConfig.clear(); await store.clear(); await vault.clear();
    } else if (sub !== 'get') { console.error(HELP); return 1; }
    out({ saved: (await cliConfig.load()).serverUrl ?? null, effective: await effectiveUrl(cliConfig) });
    return 0;
  }
  if (cmd === 'help') { console.log(HELP); return 0; }
  if (!['status', 'models', 'keys'].includes(cmd)) { console.log(HELP); return 1; }
  const url = await effectiveUrl(cliConfig);
  if (!url) throw new PaException({ code: 'VALIDATION', message: 'No server configured: run `pac config set-url <url>` or set PAC_SERVER_URL' });
  // Non-HTTPS servers are allowed with a warning (product decision).
  if (isInsecureServerUrl(url)) console.error('warning: server is not HTTPS; credentials travel in plain text');
  const core = createCore({ serverUrl: url, store, vault });
  await core.session.restore();
  const id = (v: string | undefined) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw new PaException({ code: 'VALIDATION', message: 'Key id required' });
    return n;
  };
  switch (cmd) {
    case 'status': out(core.session.view()); return 0;
    case 'models': {
      const i = args.indexOf('--key');
      out(await createModels(core.http).listWithKey(await core.keys.secret(id(i >= 0 ? args[i + 1] : undefined))));
      return 0;
    }
    default: {
      if (args.shift() !== 'check') { console.error(HELP); return 1; }
      // Verifies key retrieval works without printing the key.
      const k = id(args[0]);
      const sk = await core.keys.secret(k);
      out({ id: k, prefixOk: sk.startsWith('sk-'), length: sk.length });
      return 0;
    }
  }
}

if (process.argv[1] && /(?:^|[\\/])index\.(?:ts|js)$/.test(process.argv[1])) main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => { const p = toPaError(e); console.error(redact(p.code === 'SERVER' && e instanceof Error && !('error' in e) ? e.message : `${p.code}: ${p.message}`)); process.exit(1); },
);
