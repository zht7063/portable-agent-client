import { describe, expect, it } from 'vitest';
import { HttpClient } from '@pac/core';
import { createModels } from '../src/index.js';
import { json, mockFetch } from './mock-http.js';

const models = (routes: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch(routes);
  return { models: createModels(new HttpClient({ baseUrl: 'http://srv', fetch: m.fetch })), calls: m.calls };
};

describe('models (harness relay list only)', () => {
  it('relay list with sk', async () => {
    const { models: mo, calls } = models({ 'GET /v1/models': () => json({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }], success: true }) });
    expect(await mo.listWithKey('sk-abc')).toEqual([{ id: 'deepseek-flash' }]);
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer sk-abc');
  });
  it('relay 401 error is redacted', async () => {
    const { models: mo } = models({ 'GET /v1/models': () => json({ error: { message: 'Invalid token sk-abcdefghijklmnop', type: 'new_api_error' } }, { status: 401 }) });
    await expect(mo.listWithKey('sk-abcdefghijklmnop')).rejects.toMatchObject({ error: { code: 'UNAUTHORIZED', message: 'Invalid token sk-***' } });
  });
});
