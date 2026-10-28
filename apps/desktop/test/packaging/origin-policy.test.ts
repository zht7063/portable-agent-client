import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const req = createRequire(import.meta.url);
const { originProblem } = req(join(__dirname, '../../scripts/check-placeholders.cjs')) as { originProblem: (o: string, opts?: { official?: boolean }) => string | null };

describe('shared server-origin policy (Aegis R41 P2/P3; D-17 https-only)', () => {
  it.each(['https://flowpier.top', 'https://api.example-prod.com', 'https://flowpier.top:8443', 'https://203.0.113.5'])('accepts bare origin %s', (o) => {
    expect(originProblem(o)).toBeNull();
    expect(originProblem(o, { official: true })).toBeNull();
  });
  it.each(['http://flowpier.top', 'http://flowpier.top:3000', 'http://185.115.207.247:3000', 'http://203.0.113.5'])('rejects plain-HTTP %s (D-17 exception ended)', (o) => {
    expect(originProblem(o)).toMatch(/https/);
    expect(originProblem(o, { official: true })).toMatch(/https/);
  });
  it.each([
    'https://api.swift-client.invalid', 'https://foo.invalid.', 'https://invalid', 'https://FOO.INVALID',
    'https://flowpier.top/', 'https://flowpier.top/v1', 'https://u:p@flowpier.top', 'https://u@flowpier.top', 'https://flowpier.top:443', 'https://flowpier.top.', 'https://flowpier.top.:8443',
    'https://flowpier.top?x=1', 'https://flowpier.top#f', 'wss://flowpier.top', 'ws://flowpier.top:3000', 'file:///etc', 'not a url',
  ])('rejects %s in every build', (o) => {
    expect(originProblem(o)).not.toBeNull();
    expect(originProblem(o, { official: true })).not.toBeNull();
  });
  it.each([
    'https://127.0.0.1:3000', 'https://localhost:3000', 'https://[::1]:3000', 'https://a.localhost', 'https://0.0.0.0',
    // IPv6 unspecified address (L2): reaches the local host on most stacks; every textual form parses to hostname '[::]'.
    'https://[::]', 'https://[::]:8443', 'https://[::ffff:0:0]:8443', 'https://[::ffff:7f00:1]:3000',
  ])('rejects loopback %s only in official builds', (o) => {
    expect(originProblem(o)).toBeNull();
    expect(originProblem(o, { official: true })).toMatch(/loopback/);
  });
  // Non-canonical spellings never reach the loopback check: url.origin (canonical) !== the configured string.
  it.each(['https://[0:0:0:0:0:0:0:0]:8443', 'https://[::0]:8443', 'https://[::ffff:0.0.0.0]', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:8.8.8.8]:8443', 'https://[::]:443', 'https://[0:0:0:0:0:0:0:1]:3000'])('rejects non-canonical IPv6 spelling %s in every build', (o) => {
    expect(originProblem(o)).toMatch(/bare https origin/);
    expect(originProblem(o, { official: true })).toMatch(/bare https origin/);
  });
  it('parses bracketed unspecified IPv6 forms to the hostnames the guard compares', () => {
    expect(new URL('https://[::]').hostname).toBe('[::]');
    expect(new URL('https://[0:0:0:0:0:0:0:0]').hostname).toBe('[::]');
    expect(new URL('https://[::ffff:0.0.0.0]').hostname).toBe('[::ffff:0:0]');
  });
  it.each(['https://[2001:db8::1]:8443', 'https://[::2]:8443', 'https://[::ffff:808:808]:8443', 'https://flowpier.top', 'https://flowpier.top:8443'])('still accepts non-loopback %s in official builds', (o) => {
    expect(originProblem(o, { official: true })).toBeNull();
  });
});
