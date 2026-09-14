import { describe, expect, it } from 'vitest';
import { RayError } from '../src';
import { parseRetryAfter } from '../src/errors';
import { client, json, mockFetch } from './helpers';

async function failWith(response: Response): Promise<RayError> {
  const { fetch } = mockFetch(response);
  try {
    await client(fetch, { maxRetries: 0 }).templates.get('t');
  } catch (err) {
    return err as RayError;
  }
  throw new Error('expected the call to fail');
}

describe('RayError parsing', () => {
  it('parses the { error, message } envelope and x-request-id', async () => {
    const err = await failWith(
      json({ error: 'not_found', message: 'template not found' }, 404, {
        'x-request-id': 'req_123',
      }),
    );
    expect(err).toBeInstanceOf(RayError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RayError');
    expect(err).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'template not found',
      requestId: 'req_123',
      retryAfter: undefined,
    });
    expect(err.body).toEqual({ error: 'not_found', message: 'template not found' });
    expect(err.headers?.get('x-request-id')).toBe('req_123');
  });

  it('parses 429 retry information', async () => {
    const err = await failWith(
      json(
        { error: 'rate_limit_exceeded', message: 'rate limit exceeded', retry_after_seconds: 7 },
        429,
        { 'Retry-After': '7', 'RateLimit-Limit': '10', 'RateLimit-Remaining': '0' },
      ),
    );
    expect(err).toMatchObject({ status: 429, code: 'rate_limit_exceeded', retryAfter: 7 });
  });

  it('uses retry_after_seconds when Retry-After is missing', async () => {
    const err = await failWith(
      json({ error: 'rate_limit_exceeded', message: 'x', retry_after_seconds: 2 }, 429),
    );
    expect(err.retryAfter).toBe(2);
  });

  it('keeps 402 quota fields on body', async () => {
    const body = {
      error: 'quota_exceeded',
      message: 'monthly notification quota exceeded',
      limit: 25000,
      used: 24500,
    };
    const err = await failWith(
      json(body, 402, { 'RayQuota-Limit': '25000', 'RayQuota-Used': '24500' }),
    );
    expect(err).toMatchObject({ status: 402, code: 'quota_exceeded' });
    expect(err.body).toEqual(body);
    expect(err.headers?.get('RayQuota-Used')).toBe('24500');
  });

  it('handles a 500 with no message', async () => {
    const err = await failWith(json({ error: 'internal_server_error' }, 500));
    expect(err.code).toBe('internal_server_error');
    expect(err.message).toBe('Ray API request failed with status 500 (internal_server_error)');
  });

  it('handles plain-text bodies (unknown paths return "404 Not Found")', async () => {
    const err = await failWith(new Response('404 Not Found', { status: 404 }));
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: '404 Not Found' });
    expect(err.body).toBe('404 Not Found');
  });

  it('handles an empty body and unknown statuses', async () => {
    const err = await failWith(new Response(null, { status: 418 }));
    expect(err).toMatchObject({ status: 418, code: 'http_error', body: undefined });
    const gateway = await failWith(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(gateway.code).toBe('internal_server_error');
  });

  it('reports an unparseable success body as invalid_response', async () => {
    const err = await failWith(new Response('not json', { status: 200 }));
    expect(err).toMatchObject({ status: 200, code: 'invalid_response' });
  });

  it('resolves undefined for an empty success body', async () => {
    const { fetch } = mockFetch(new Response(null, { status: 204 }));
    await expect(client(fetch).templates.get('t')).resolves.toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('3')).toBe(3);
    expect(parseRetryAfter('-1')).toBe(0);
    expect(parseRetryAfter('soon')).toBeUndefined();
    const now = Date.parse('2026-09-14T09:00:00Z');
    expect(parseRetryAfter('Mon, 14 Sep 2026 09:00:05 GMT', now)).toBe(5);
  });
});
