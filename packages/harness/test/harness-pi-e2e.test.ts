/**
 * Opt-in offline E2E: PA_HARNESS_E2E=1 PI_BIN=/path/to/pi. Real pi binary, temp HOME, fake OpenAI server on
 * 127.0.0.1 (never a real server), dummy environment key. Verifies pi accepts our config.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlledFs, createHarness, nodeExec, nodeFsOps, PiAdapter, StateStore } from '@pac/harness';

const run = process.env.PA_HARNESS_E2E === '1' && !!process.env.PI_BIN && process.platform !== 'win32';

describe.skipIf(!run)('pi e2e (offline)', () => {
  it('pi uses provider pa, default model from settings.json, and an environment key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pa-pi-e2e-'));
    const home = join(root, 'home'); const data = join(root, 'data');
    await mkdir(join(data, 'bin'), { recursive: true });
    const seen: { url?: string; auth?: boolean; model?: string } = {};
    const srv = createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        Object.assign(seen, { url: req.url, auth: req.headers.authorization === 'Bearer dummy-local-value', model: (JSON.parse(b) as { model: string }).model });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ch = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
        ch({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }] });
        ch({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as AddressInfo).port;
      const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data], dataDir: data });
      const state = new StateStore(fs);
      const env = { home, env: {}, platform: process.platform };
      const h = createHarness({ fs, state, env, exec: nodeExec, adapters: { pi: new PiAdapter({ fs, state, env, exec: nodeExec, helperPath: '' }) } });
      await h.upsertProfile({ id: 'default', serverUrl: `http://127.0.0.1:${port}`, keyId: 1, keyMode: 'env', models: { main: 'deepseek-flash' } });
      await h.apply('pi', await h.plan('pi', 'default'));
      // Async spawn: the fake server lives in this process, so the event loop must keep running.
      const r = await new Promise<{ stdout: string }>((resolve, reject) => {
        const p = spawn(process.env.PI_BIN!, ['-p', 'ping'], { cwd: root, env: { PATH: process.env.PATH, HOME: home, PA_API_KEY: 'dummy-local-value' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; p.stdout.on('data', (c) => (stdout += c));
        const t = setTimeout(() => { p.kill(); reject(new Error('pi timed out')); }, 60_000);
        p.on('close', () => { clearTimeout(t); resolve({ stdout }); });
      });
      expect(r.stdout).toContain('pong');
      expect(seen).toEqual({ url: '/v1/chat/completions', auth: true, model: 'deepseek-flash' });
    } finally { srv.close(); }
  }, 90_000);
});
