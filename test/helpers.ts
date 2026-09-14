import { vi } from 'vitest';
import { Ray, type RayOptions } from '../src';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

type Reply = Response | Error | ((call: RecordedCall) => Response | Promise<Response>);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch mock that replays `replies` in order (the last one repeats) and records every call. */
export function mockFetch(...replies: Reply[]) {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply === undefined) throw new Error('mockFetch: no reply configured');
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(call);
    return reply.clone();
  });
  return { fetch, calls };
}

export const API_KEY = 'ck_live_test_key';

export function client(fetch: RayOptions['fetch'], options: RayOptions = {}) {
  return new Ray(API_KEY, { fetch, ...options });
}
