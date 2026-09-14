import { afterEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { DEFAULT_BASE_URL, Ray, RayError, VERSION } from '../src';
import { API_KEY, client, json, mockFetch } from './helpers';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('new Ray()', () => {
  it('uses the explicit API key as a Bearer token', async () => {
    const { fetch, calls } = mockFetch(json({ tenantId: 't', apiKeyId: 'k', scopes: ['read'] }));
    await client(fetch).me();
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.headers.accept).toBe('application/json');
  });

  it('falls back to RAY_API_KEY', async () => {
    vi.stubEnv('RAY_API_KEY', 'ck_live_from_env');
    const { fetch, calls } = mockFetch(json({}));
    await new Ray(undefined, { fetch }).me();
    expect(calls[0]?.headers.authorization).toBe('Bearer ck_live_from_env');
  });

  it('accepts a single options object', async () => {
    const { fetch, calls } = mockFetch(json({}));
    await new Ray({ apiKey: 'ck_live_obj', fetch }).me();
    expect(calls[0]?.headers.authorization).toBe('Bearer ck_live_obj');
  });

  it('throws a clear RayError when no key is available', () => {
    vi.stubEnv('RAY_API_KEY', '');
    expect(() => new Ray()).toThrowError(RayError);
    try {
      new Ray(undefined, { fetch: mockFetch(json({})).fetch });
    } catch (err) {
      expect(err).toBeInstanceOf(RayError);
      expect((err as RayError).code).toBe('missing_api_key');
      expect((err as RayError).message).toMatch(/RAY_API_KEY/);
    }
  });

  it('defaults to the production base URL and strips trailing slashes from a custom one', async () => {
    const a = mockFetch(json({}));
    await client(a.fetch).me();
    expect(a.calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/me`);
    expect(DEFAULT_BASE_URL).toBe('https://ray-api.gege.mn');

    const b = mockFetch(json({}));
    const ray = client(b.fetch, { baseUrl: 'http://localhost:3001///' });
    expect(ray.baseUrl).toBe('http://localhost:3001');
    await ray.me();
    expect(b.calls[0]?.url).toBe('http://localhost:3001/me');
  });

  it('reads RAY_BASE_URL when no baseUrl option is given', async () => {
    vi.stubEnv('RAY_BASE_URL', 'https://staging.example.com/');
    const { fetch, calls } = mockFetch(json({}));
    await client(fetch).me();
    expect(calls[0]?.url).toBe('https://staging.example.com/me');
  });

  it('sends a ray-node User-Agent and prepends a custom one', async () => {
    const a = mockFetch(json({}));
    await client(a.fetch).me();
    expect(a.calls[0]?.headers['user-agent']).toBe(`ray-node/${VERSION}`);

    const b = mockFetch(json({}));
    await client(b.fetch, { userAgent: 'my-app/2.0' }).me();
    expect(b.calls[0]?.headers['user-agent']).toBe(`my-app/2.0 ray-node/${VERSION}`);
  });

  it('uses the global fetch when none is injected', async () => {
    const { fetch, calls } = mockFetch(json({ tenantId: 't' }));
    vi.stubGlobal('fetch', fetch);
    const res = await new Ray(API_KEY).me();
    expect(res).toEqual({ tenantId: 't' });
    expect(calls).toHaveLength(1);
  });

  it('merges per-request headers', async () => {
    const { fetch, calls } = mockFetch(json({}));
    await client(fetch).me({ headers: { 'X-Trace': 'abc' } });
    expect(calls[0]?.headers['x-trace']).toBe('abc');
  });

  it('VERSION matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
