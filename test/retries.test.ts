import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RayError } from '../src';
import { backoffDelay } from '../src/core';
import { client, json, mockFetch } from './helpers';

const FEED_ONLY = { externalUserId: 'u', feed: { title: 't' } };
const TEMPLATE_BODY = {
  name: 'n',
  channelKind: 'slack_text' as const,
  content: { text: 'hi' },
  logTitle: 't',
  logDescription: 'd',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Runs `promise` to completion while advancing fake timers. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const result = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return result;
}

const serverError = () => json({ error: 'internal_server_error' }, 500);
const rateLimited = (seconds = 1) =>
  json(
    { error: 'rate_limit_exceeded', message: 'rate limit exceeded', retry_after_seconds: seconds },
    429,
    {
      'Retry-After': String(seconds),
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': String(seconds),
    },
  );

describe('backoffDelay', () => {
  it('doubles from 500ms, caps at 8s, and jitters down by at most 25%', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((n) => backoffDelay(n, () => 0))).toEqual([
      500, 1000, 2000, 4000, 8000, 8000, 8000,
    ]);
    expect(backoffDelay(0, () => 1)).toBe(375);
    expect(backoffDelay(2, () => 0.5)).toBe(1750);
  });
});

describe('retries', () => {
  it('retries GET on 5xx with exponential backoff, then succeeds', async () => {
    const { fetch, calls } = mockFetch(serverError(), serverError(), json({ channels: [] }));
    const ray = client(fetch);
    const started = Date.now();
    const promise = ray.channels.list();

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(3);

    await expect(promise).resolves.toEqual({ channels: [] });
    expect(Date.now() - started).toBe(1500);
  });

  it('gives up after maxRetries (default 2) and throws the last error', async () => {
    const { fetch, calls } = mockFetch(serverError());
    const { error } = await settle(client(fetch).channels.list());
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(RayError);
    expect(error).toMatchObject({ status: 500, code: 'internal_server_error' });
  });

  it('honors client and per-request maxRetries', async () => {
    const a = mockFetch(serverError());
    await settle(client(a.fetch, { maxRetries: 0 }).channels.list());
    expect(a.calls).toHaveLength(1);

    const b = mockFetch(serverError());
    await settle(client(b.fetch).channels.list({ maxRetries: 4 }));
    expect(b.calls).toHaveLength(5);
  });

  it('waits Retry-After seconds on 429', async () => {
    const { fetch, calls } = mockFetch(rateLimited(3), json({ channels: [] }));
    const promise = client(fetch).channels.list();
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await expect(promise).resolves.toEqual({ channels: [] });
  });

  it('falls back to retry_after_seconds, then RateLimit-Reset', async () => {
    const a = mockFetch(
      json({ error: 'rate_limit_exceeded', message: 'x', retry_after_seconds: 2 }, 429),
      json({}),
    );
    const pa = client(a.fetch).me();
    await vi.advanceTimersByTimeAsync(1999);
    expect(a.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.calls).toHaveLength(2);
    await pa;

    const b = mockFetch(
      new Response('slow down', {
        status: 429,
        headers: { 'RateLimit-Remaining': '0', 'RateLimit-Reset': '4' },
      }),
      json({}),
    );
    const pb = client(b.fetch).me();
    await vi.advanceTimersByTimeAsync(3999);
    expect(b.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.calls).toHaveLength(2);
    await pb;
  });

  it('does not retry when the server asks to wait more than 60s', async () => {
    const { fetch, calls } = mockFetch(rateLimited(120));
    const { error } = await settle(client(fetch).me());
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ status: 429, retryAfter: 120 });
  });

  it('retries network errors on reads', async () => {
    const { fetch, calls } = mockFetch(new TypeError('fetch failed'), json({ ok: 1 }));
    const { value } = await settle(client(fetch).me());
    expect(value).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it('wraps exhausted network errors in RayError(connection_error)', async () => {
    const cause = new TypeError('fetch failed');
    const { fetch } = mockFetch(cause);
    const { error } = await settle(client(fetch, { maxRetries: 1 }).me());
    expect(error).toBeInstanceOf(RayError);
    expect(error).toMatchObject({ status: 0, code: 'connection_error' });
    expect((error as RayError).cause).toBe(cause);
  });

  it('times out slow attempts and retries them on reads', async () => {
    const { fetch, calls } = mockFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const { error } = await settle(client(fetch, { timeoutMs: 1000, maxRetries: 1 }).me());
    expect(calls).toHaveLength(2);
    expect(error).toMatchObject({ status: 0, code: 'timeout' });
    expect((error as RayError).message).toMatch(/timed out after 1000ms/);
  });

  describe('send (always has an Idempotency-Key)', () => {
    it('retries 5xx, 429, network errors and timeouts', async () => {
      const { fetch, calls } = mockFetch(
        serverError(),
        rateLimited(1),
        new TypeError('socket hang up'),
        json({ sendId: 's' }, 202),
      );
      const { value } = await settle(client(fetch, { maxRetries: 3 }).send(FEED_ONLY));
      expect(value).toEqual({ sendId: 's' });
      expect(calls).toHaveLength(4);
      expect(new Set(calls.map((c) => c.headers['idempotency-key'])).size).toBe(1);
    });

    it('retries 409 "already in progress" but not "different request body"', async () => {
      const inProgress = mockFetch(
        json(
          {
            error: 'conflict',
            message: 'a request with this Idempotency-Key is already in progress',
          },
          409,
        ),
        json({ error: 'conflict', message: 'Idempotency-Key is in use; retry shortly' }, 409),
        json({ sendId: 's' }, 202),
      );
      const ok = await settle(client(inProgress.fetch).send(FEED_ONLY));
      expect(ok.value).toEqual({ sendId: 's' });
      expect(inProgress.calls).toHaveLength(3);

      const mismatch = mockFetch(
        json(
          { error: 'conflict', message: 'Idempotency-Key reused with a different request body' },
          409,
        ),
      );
      const failed = await settle(client(mismatch.fetch).send(FEED_ONLY));
      expect(mismatch.calls).toHaveLength(1);
      expect(failed.error).toMatchObject({ status: 409, code: 'conflict' });
    });

    it('never retries 4xx validation errors', async () => {
      const { fetch, calls } = mockFetch(
        json({ error: 'validation_error', message: 'recipient: invalid email' }, 400),
      );
      const { error } = await settle(client(fetch).send(FEED_ONLY));
      expect(calls).toHaveLength(1);
      expect(error).toMatchObject({ status: 400, code: 'validation_error' });
    });
  });

  describe('other writes (no idempotency)', () => {
    it('retry 429 only', async () => {
      const limited = mockFetch(rateLimited(1), json({ id: 'x', requiredParams: [] }, 201));
      const ok = await settle(client(limited.fetch).templates.create(TEMPLATE_BODY));
      expect(ok.value).toEqual({ id: 'x', requiredParams: [] });
      expect(limited.calls).toHaveLength(2);
    });

    const writes: Record<string, (ray: ReturnType<typeof client>) => Promise<unknown>> = {
      'templates.create': (ray: ReturnType<typeof client>) => ray.templates.create(TEMPLATE_BODY),
      'templates.update': (ray: ReturnType<typeof client>) =>
        ray.templates.update('t', TEMPLATE_BODY),
      'templates.publish': (ray: ReturnType<typeof client>) => ray.templates.publish('t'),
      'templates.archive': (ray: ReturnType<typeof client>) => ray.templates.archive('t'),
      'templates.unarchive': (ray: ReturnType<typeof client>) => ray.templates.unarchive('t'),
      'templates.testSend': (ray: ReturnType<typeof client>) =>
        ray.templates.testSend('t', { channelConfigId: 'c', recipient: {} }),
      'webhooks.create': (ray: ReturnType<typeof client>) =>
        ray.webhooks.create({ name: 'n', url: 'https://example.com', events: ['send.completed'] }),
      'webhooks.update': (ray: ReturnType<typeof client>) =>
        ray.webhooks.update('w', { rotateSecret: true }),
      'webhooks.delete': (ray: ReturnType<typeof client>) => ray.webhooks.delete('w'),
    };
    const failures = [
      ['5xx', serverError],
      ['a network error', () => new TypeError('fetch failed')],
    ] as const;

    for (const [name, call] of Object.entries(writes)) {
      it.each(failures)(`${name} does not retry %s`, async (_label, reply) => {
        const { fetch, calls } = mockFetch(reply());
        const { error } = await settle(call(client(fetch, { maxRetries: 5 })));
        expect(error).toBeInstanceOf(RayError);
        expect(calls).toHaveLength(1);
      });
    }

    it('do not retry a timeout', async () => {
      const { fetch, calls } = mockFetch(
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const { error } = await settle(
        client(fetch, { timeoutMs: 500 }).webhooks.create({
          name: 'n',
          url: 'https://example.com',
          events: ['send.completed'],
        }),
      );
      expect(calls).toHaveLength(1);
      expect(error).toMatchObject({ code: 'timeout' });
    });
  });

  describe('abort signals', () => {
    it('rejects immediately with the abort reason when already aborted', async () => {
      const { fetch, calls } = mockFetch(json({}));
      const controller = new AbortController();
      controller.abort(new Error('stop'));
      await expect(client(fetch).me({ signal: controller.signal })).rejects.toThrow('stop');
      expect(calls).toHaveLength(0);
    });

    it('cancels a pending retry sleep', async () => {
      const { fetch, calls } = mockFetch(serverError());
      const controller = new AbortController();
      const promise = client(fetch).me({ signal: controller.signal });
      const outcome = promise.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(100);
      controller.abort(new Error('user cancelled'));
      await expect(outcome).resolves.toMatchObject({ message: 'user cancelled' });
      expect(calls).toHaveLength(1);
    });

    it('aborts an in-flight request without retrying', async () => {
      const { fetch, calls } = mockFetch(
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.signal?.addEventListener('abort', () => reject(new Error('aborted by fetch')));
          }),
      );
      const controller = new AbortController();
      const outcome = client(fetch)
        .me({ signal: controller.signal })
        .catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(10);
      controller.abort(new Error('user cancelled'));
      await expect(outcome).resolves.toMatchObject({ message: 'user cancelled' });
      expect(calls).toHaveLength(1);
    });
  });
});
