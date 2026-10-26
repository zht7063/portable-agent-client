import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HttpClient, PaException, type HarnessProfile, type HarnessTestReq, type HarnessTestResult } from '@pac/core';
import type { ControlledFs } from '@pac/core/fs';
import { verifyPrivatePath } from '@pac/core/fs';
import { KeyFile, keyFingerprint } from './keyfile.js';
import type { HarnessEnv } from './paths.js';
import { configDir } from './paths.js';
import { parseToml } from './merge/toml.js';
import type { ExecFn } from './exec.js';
import bundled from './pricing.json' with { type: 'json' };

const PROMPT = 'Reply with OK';
const INPUT_CAP = PROMPT.length + 50;
const OUTPUT_CAP = 16;
const finite = (v: unknown, max = 1_000_000): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
export function connectivityError(e: unknown): string {
  if (!(e instanceof PaException)) return 'protocol-error';
  if ((e.error.status ?? 0) >= 300 && (e.error.status ?? 0) < 400) return 'redirect-refused';
  return ({ UNAUTHORIZED: 'invalid-key', RATE_LIMITED: 'rate-limited', TIMEOUT: 'timeout', NETWORK: 'unreachable' } as Record<string, string>)[e.error.code] ?? (e.error.status === 404 ? 'model-unavailable' : 'protocol-error');
}
interface Options { origin: string; keys: KeyFile; fs: ControlledFs; env: HarnessEnv; exec: ExecFn; fetch?: typeof fetch; now?: () => number }
interface Quote { id: string; count: number; tokenCap: number; cost: number | null; model: string; at: number; binding: string; date?: string }
/** All server shapes here are assumed new-api shapes: TODO verify after rain recovers (§4.5). */
export function createConnectivity(o: Options) {
  const http = new HttpClient({ baseUrl: o.origin, ...(o.fetch ? { fetch: o.fetch } : {}), timeoutMs: 20_000 });
  const now = o.now ?? Date.now;
  const requests = new Map<string, number[]>();
  const quotes = new Map<string, Quote>();
  const modelCache = new Map<string, { at: number; fingerprint: string; models: string[] }>();
  const pin = (p: HarnessProfile) => { if (p.serverUrl !== o.origin || http.baseUrl !== o.origin) throw new PaException({ code: 'VALIDATION', message: 'Server changed; select token again' }); };
  const limit = (id: string, count: number, paid: boolean) => {
    const slot = `${id}:${paid}`; const window = paid ? 600_000 : 60_000; const cap = paid ? 6 : 10;
    const hits = (requests.get(slot) ?? []).filter((t) => t > now() - window);
    if (hits.length + count > cap) throw new PaException({ code: 'RATE_LIMITED', message: 'Test rate limit reached; retry manually later' });
    requests.set(slot, [...hits, ...Array<number>(count).fill(now())]);
  };
  const models = async (p: HarnessProfile, suppliedKey?: string): Promise<string[]> => {
    pin(p);
    const key = suppliedKey ?? await o.keys.get(p.id);
    const fingerprint = createHash('sha256').update(key).digest('hex');
    const cached = modelCache.get(p.id);
    if (!suppliedKey && cached?.fingerprint === fingerprint && now() - cached.at < 600_000) return [...cached.models];
    limit(p.id, 1, false);
    const body = await http.json<{ data?: { id?: unknown }[] }>('GET', '/v1/models', { auth: { sk: key } });
    if (!Array.isArray(body.data) || body.data.length > 10_000 || body.data.some((m) => typeof m.id !== 'string' || m.id.length > 200)) throw new Error('Invalid models');
    const ids = body.data.map((m) => m.id as string);
    modelCache.set(p.id, { at: now(), fingerprint, models: ids });
    return [...ids];
  };
  const binding = (p: HarnessProfile, r: HarnessTestReq, model: string) => JSON.stringify([p.id, p.keyId, p.models, r.id, r.level, model]);
  async function prepare(p: HarnessProfile, r: HarnessTestReq): Promise<Quote> {
    pin(p); limit(p.id, 1, false);
    const model = r.id === 'codex' ? p.models.codex ?? p.models.main : p.models.main;
    const count = r.level === 'L2' ? 2 : 1;
    let cost: number | null = null;
    let date: string | undefined;
    // Pricing uses the same redirect-refusing core client, never a renderer supplied URL.
    let data: { success?: boolean; data?: { model_name: string; quota_type: number; model_ratio: number; completion_ratio: number; model_price: number; enable_groups?: string[] }[]; group_ratio?: Record<string, unknown> } = {};
    try { data = await http.json('GET', '/api/pricing', { auth: 'none' }); }
    catch (e) { if (connectivityError(e) === 'redirect-refused') throw e; }
    const price = data.success === true && Array.isArray(data.data) ? data.data.find((x) => x.model_name === model) : undefined;
    if (price) {
      const groups = price.enable_groups?.map((g) => data.group_ratio?.[g]) ?? Object.values(data.group_ratio ?? {});
      const ratio = groups.length && groups.every((g) => finite(g, 1000)) ? Math.max(...groups as number[]) : null;
      if (ratio !== null && price.quota_type === 0 && finite(price.model_ratio) && finite(price.completion_ratio, 1000)) cost = count * ratio * price.model_ratio * 2 * (INPUT_CAP + OUTPUT_CAP * price.completion_ratio) / 1_000_000;
      if (ratio !== null && price.quota_type === 1 && finite(price.model_price)) cost = count * ratio * price.model_price;
    }
    if (cost === null) {
      const b = (bundled.models as Record<string, { input: number; output: number }>)[model];
      if (b && finite(b.input) && finite(b.output)) { cost = count * (INPUT_CAP * b.input + OUTPUT_CAP * b.output) / 1_000_000; date = bundled.priceTableDate; }
    }
    const q: Quote = { id: randomUUID(), count, model, cost, tokenCap: count * (INPUT_CAP + OUTPUT_CAP), at: now(), binding: binding(p, r, model), ...(date ? { date } : {}) };
    for (const [id, old] of quotes) if (now() - old.at > 300_000) quotes.delete(id);
    quotes.set(q.id, q);
    return q;
  }
  async function recordUsage(providerId: string, count: number, estimatedCost: number | null): Promise<void> {
    const path = join(o.fs.dataDir, 'harness/test-usage.json');
    const prior = await o.fs.readText(path);
    const usage = prior ? JSON.parse(prior.text) as Record<string, { requests: number; estimatedCost: number; unknownCostRequests: number }> : {};
    const entry = usage[providerId] ?? { requests: 0, estimatedCost: 0, unknownCostRequests: 0 };
    entry.requests += count;
    if (estimatedCost === null) entry.unknownCostRequests += count; else entry.estimatedCost += estimatedCost;
    usage[providerId] = entry;
    await o.fs.atomicWrite(path, JSON.stringify(usage));
  }
  async function test(p: HarnessProfile, r: HarnessTestReq): Promise<HarnessTestResult> {
    let attempted = 0;
    try {
      pin(p);
      if (r.id !== 'codex' && r.id !== 'claude') return { state: 'unsupported', requestCount: 0 };
      if (r.level === 'L0') {
        const key = await o.keys.get(p.id);
        const path = join(configDir(r.id, o.env), r.id === 'codex' ? 'config.toml' : 'settings.json');
        await verifyPrivatePath(configDir(r.id, o.env), true);
        await verifyPrivatePath(path);
        const text = (await o.fs.readText(path))?.text ?? '';
        const root = r.id === 'codex' ? parseToml(text) : JSON.parse(text) as Record<string, unknown>;
        const token = r.id === 'codex' ? ((root.model_providers as Record<string, Record<string, unknown>>)?.swift?.experimental_bearer_token) : (root.env as Record<string, unknown>)?.ANTHROPIC_AUTH_TOKEN;
        return { state: typeof token === 'string' && keyFingerprint(token) === keyFingerprint(key) ? 'ok' : 'fingerprint-mismatch', requestCount: 0 };
      }
      if (r.level === 'L1') return { state: 'ok', models: await models(p), requestCount: 1 };
      const model = r.id === 'codex' ? p.models.codex ?? p.models.main : p.models.main;
      if (r.id === 'claude' && Object.values(p.models).some((m) => m?.includes('placeholder'))) return { state: 'models-pending', requestCount: 0 };
      // CLI executables do not provide a verified hard token/request cap. Refuse until one is verified.
      if (r.level === 'L3') return { state: 'harness-token-cap-unverified', requestCount: 0 };
      if (r.confirm !== true) {
        const q = await prepare(p, r);
        return { state: 'confirmation-required', quoteId: q.id, requestCount: q.count, model, tokenCap: q.tokenCap, estimatedCost: q.cost, ...(q.date ? { priceTableDate: q.date } : {}) };
      }
      const q = quotes.get(r.quoteId ?? '');
      if (!q || q.binding !== binding(p, r, model) || now() - q.at > 300_000 || (q.cost === null && r.confirmUnknownCost !== true)) return { state: 'confirmation-required', requestCount: 0 };
      quotes.delete(q.id); // single use, including failures; no auto retry
      limit(p.id, q.count, true);
      const key = await o.keys.get(p.id);
      let usage = 0;
      {
        for (const stream of [false, true]) {
          const body = r.id === 'codex' ? { model, input: PROMPT, max_output_tokens: OUTPUT_CAP, stream, store: false } : { model, max_tokens: OUTPUT_CAP, messages: [{ role: 'user', content: PROMPT }], stream };
          attempted++;
          await recordUsage(p.id, 1, q.cost === null ? null : q.cost / q.count);
          const response = await http.send('POST', r.id === 'codex' ? '/v1/responses' : '/v1/messages', { auth: { sk: key }, body, headers: r.id === 'claude' ? { 'anthropic-version': '2023-06-01' } : {} });
          const text = await response.text();
          if (text.length > 1_000_000) throw new Error('Oversize protocol response');
          const readUsage = (u: unknown) => {
            const v = u as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
            if (!finite(v?.input_tokens) || !finite(v?.output_tokens)) throw new Error('Missing usage');
            usage += v.input_tokens + v.output_tokens;
          };
          if (stream) {
            const wanted = r.id === 'codex' ? ['response.created', 'response.output_text.delta', 'response.completed'] : ['message_start', 'content_block_delta', 'message_stop'];
            const events = text.split(/\r?\n\r?\n/).filter((chunk) => chunk.startsWith('event:') || chunk.startsWith('data:')).map((chunk) => {
              const data = chunk.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
              return JSON.parse(data) as { type?: string; usage?: unknown; response?: { usage?: unknown }; message?: { usage?: unknown } };
            });
            if (events.some((e) => e.type === 'error' || e.type === 'response.failed')) throw new Error('Stream failed');
            let position = -1;
            for (const type of wanted) { const next = events.findIndex((e, i) => i > position && e.type === type); if (next < 0) throw new Error('Invalid stream sequence'); position = next; }
            const end = events.find((e) => e.type === (r.id === 'codex' ? 'response.completed' : 'message_delta'));
            if (r.id === 'codex') readUsage(end?.response?.usage);
            else {
              const start = events.find((e) => e.type === 'message_start')?.message?.usage as { input_tokens?: number } | undefined;
              const finish = end?.usage as { output_tokens?: number } | undefined;
              readUsage({ input_tokens: start?.input_tokens, output_tokens: finish?.output_tokens });
            }
          } else {
            const j = JSON.parse(text) as { object?: string; type?: string; status?: string; output?: unknown; content?: unknown; usage?: unknown };
            if (r.id === 'codex' ? j.object !== 'response' || j.status !== 'completed' || !Array.isArray(j.output) : j.type !== 'message' || !Array.isArray(j.content)) throw new Error('Invalid protocol response');
            readUsage(j.usage);
          }
        }
      }
      return { state: 'ok', requestCount: attempted, model, tokenCap: q.tokenCap, estimatedCost: q.cost, usageTokens: usage || q.tokenCap };
    } catch (e) { return { state: connectivityError(e), requestCount: attempted }; }
  }
  return { models, test };
}
