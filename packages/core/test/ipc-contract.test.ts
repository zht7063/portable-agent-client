import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CREDENTIAL_EXCEPTION_CHANNELS,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  findCredentialLeaks,
  type ForbiddenField,
  type IpcEventMap,
  type IpcInvokeMap,
  type InvokeChannel,
  type PaError,
  type SessionView,
} from '../src/contract/index.js';

/** All property names reachable in T (deep). */
type DeepKeys<T> = T extends readonly (infer U)[]
  ? DeepKeys<U>
  : T extends object
    ? { [K in keyof T & string]: K | DeepKeys<T[K]> }[keyof T & string]
    : never;

type Exempt = (typeof CREDENTIAL_EXCEPTION_CHANNELS)[number];
type UiBoundInvoke = { [C in Exclude<InvokeChannel, Exempt>]: IpcInvokeMap[C]['res'] };
type UiBoundEvents = IpcEventMap;

describe('IPC contract: no credential fields reach the renderer', () => {
  it('type-level: invoke responses (except reviewed exceptions) have no forbidden keys', () => {
    expectTypeOf<Extract<DeepKeys<UiBoundInvoke[keyof UiBoundInvoke]>, ForbiddenField>>().toEqualTypeOf<never>();
  });
  it('type-level: events have no forbidden keys', () => {
    expectTypeOf<Extract<DeepKeys<UiBoundEvents[keyof UiBoundEvents]>, ForbiddenField>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<DeepKeys<PaError>, ForbiddenField>>().toEqualTypeOf<never>();
  });
  it('type-level: SessionView exposes no credentials', () => {
    expectTypeOf<Extract<DeepKeys<SessionView>, ForbiddenField | 'refreshCookie' | 'sid'>>().toEqualTypeOf<never>();
  });
  it('no channel is exempt from the credential guard (keys:reveal was dropped)', () => {
    expect([...CREDENTIAL_EXCEPTION_CHANNELS]).toEqual([]);
    expect(INVOKE_CHANNELS.some((c) => /^(auth|billing|chat|models):/.test(c) || (c as string) === 'keys:reveal')).toBe(false);
  });
  it('channel lists are unique and complete', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
    type Missing = Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>;
    expectTypeOf<Missing>().toEqualTypeOf<never>();
    expect([...EVENT_CHANNELS].sort()).toEqual(['session:changed', 'shop:host']);
  });
});

describe('runtime guard findCredentialLeaks', () => {
  it('passes sample UI payloads', () => {
    const view: SessionView = { status: 'authenticated', userId: 3, username: 'u', accessExpiresAt: 1, storage: 'memory', serverUrl: 'http://x' };
    const cfg: IpcInvokeMap['config:get']['res'] = { serverUrl: 'http://x', insecureTransport: true, clipboardClearSeconds: 30 };
    expect(findCredentialLeaks({ view, cfg })).toEqual([]);
  });
  it('flags forbidden field names and secret-looking values', () => {
    expect(findCredentialLeaks({ access_token: 'x' })).toEqual(['$.access_token']);
    expect(findCredentialLeaks({ nested: [{ refreshCookie: 'x' }] })).toEqual(['$.nested[0].refreshCookie']);
    expect(findCredentialLeaks({ note: 'sk-' + 'a'.repeat(48) })).toEqual(['$.note']);
    expect(findCredentialLeaks({ note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.sig' })).toEqual(['$.note']);
  });
});
