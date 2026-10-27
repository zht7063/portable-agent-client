import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const req = createRequire(import.meta.url);
const { originProblem } = req(join(__dirname, '../../scripts/check-placeholders.cjs')) as { originProblem: (o: string, opts?: { official?: boolean }) => string | null };

describe('shared server-origin policy (Aegis R41 P2/P3)', () => {
  it.each(['http://flowpier.top:3000', 'https://api.example-prod.com', 'http://203.0.113.5'])('accepts bare origin %s', (o) => {
    expect(originProblem(o, { official: true })).toBeNull();
  });
  it.each([
    'https://api.swift-client.invalid', 'https://foo.invalid.', 'https://invalid', 'http://FOO.INVALID',
    'http://flowpier.top:3000/', 'http://flowpier.top:3000/v1', 'http://u:p@flowpier.top:3000', 'http://u@flowpier.top:3000',
    'http://flowpier.top:3000?x=1', 'http://flowpier.top:3000#f', 'ws://flowpier.top:3000', 'file:///etc', 'not a url',
  ])('rejects %s in every build', (o) => {
    expect(originProblem(o)).not.toBeNull();
    expect(originProblem(o, { official: true })).not.toBeNull();
  });
  it.each(['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000', 'http://a.localhost', 'http://0.0.0.0'])('rejects loopback %s only in official builds', (o) => {
    expect(originProblem(o)).toBeNull();
    expect(originProblem(o, { official: true })).toMatch(/loopback/);
  });
});
