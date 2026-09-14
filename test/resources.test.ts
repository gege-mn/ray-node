import { describe, expect, it } from 'vitest';
import { client, json, mockFetch } from './helpers';

const ID = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
const BASE = 'https://ray-api.gege.mn';

function setup(reply: Response = json({})) {
  const mock = mockFetch(reply);
  return { ray: client(mock.fetch), calls: mock.calls };
}

describe('identity and usage', () => {
  it('me() → GET /me', async () => {
    const body = { tenantId: 't1', apiKeyId: 'k1', scopes: ['read', 'write'] };
    const { ray, calls } = setup(json(body));
    await expect(ray.me()).resolves.toEqual(body);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/me`, body: undefined });
    expect(calls[0]?.headers['content-type']).toBeUndefined();
  });

  it('usage() → GET /billing/subscription', async () => {
    const body = {
      plan: 'starter',
      subscription: null,
      usage: { monthlyQuota: 250000, used: 1, remaining: 249999 },
    };
    const { ray, calls } = setup(json(body));
    await expect(ray.usage()).resolves.toEqual(body);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/billing/subscription` });
  });
});

describe('channels', () => {
  it('list() → GET /channels', async () => {
    const { ray, calls } = setup(json({ channels: [] }));
    await expect(ray.channels.list()).resolves.toEqual({ channels: [] });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/channels` });
  });
});

describe('sends', () => {
  it('get() → GET /sends/{id} with cursor and limit', async () => {
    const { ray, calls } = setup(json({ sendId: ID, rows: [], nextCursor: null }));
    await ray.sends.get(ID, { cursor: 'abc', limit: 10 });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${BASE}/sends/${ID}?cursor=abc&limit=10`,
    });
  });

  it('get() without a query has no query string', async () => {
    const { ray, calls } = setup(json({ sendId: ID, rows: [], nextCursor: null }));
    await ray.sends.get(ID);
    expect(calls[0]?.url).toBe(`${BASE}/sends/${ID}`);
  });

  it('encodes path segments', async () => {
    const { ray, calls } = setup(json({}));
    await ray.sends.get('a/b?c');
    expect(calls[0]?.url).toBe(`${BASE}/sends/a%2Fb%3Fc`);
  });

  it('rejects an empty id', () => {
    const { ray } = setup();
    expect(() => ray.sends.get('')).toThrow(TypeError);
  });

  it('listAllRows() follows nextCursor', async () => {
    const pages = [
      { sendId: ID, aggregate: { total: 3 }, rows: [{ id: 'r1' }, { id: 'r2' }], nextCursor: 'c1' },
      { sendId: ID, aggregate: { total: 3 }, rows: [{ id: 'r3' }], nextCursor: null },
    ];
    const { fetch, calls } = mockFetch(
      () => json(pages[0]),
      () => json(pages[1]),
    );
    const ray = client(fetch);
    const ids: string[] = [];
    for await (const row of ray.sends.listAllRows(ID)) ids.push(row.id);
    expect(ids).toEqual(['r1', 'r2', 'r3']);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/sends/${ID}?limit=200`,
      `${BASE}/sends/${ID}?cursor=c1&limit=200`,
    ]);
  });
});

describe('templates', () => {
  const body = {
    name: 'welcome',
    channelKind: 'email_html' as const,
    content: { subject: 'Hi {{name}}', bodyHtml: '<p>Hi {{name}}</p>', bodyText: 'Hi {{name}}' },
    logTitle: 'Welcome sent',
    logDescription: 'Welcomed {{name}}',
    publish: true,
  };

  it('list() → GET /templates with filters', async () => {
    const { ray, calls } = setup(json({ templates: [] }));
    await ray.templates.list({ folder: 'onboarding', includeArchived: true });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${BASE}/templates?folder=onboarding&includeArchived=true`,
    });
  });

  it('get() → GET /templates/{id}', async () => {
    const { ray, calls } = setup(json({ id: ID }));
    await ray.templates.get(ID);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/templates/${ID}` });
  });

  it('create() → POST /templates with a JSON body', async () => {
    const { ray, calls } = setup(json({ id: ID, requiredParams: ['name'] }, 201));
    await expect(ray.templates.create(body)).resolves.toEqual({ id: ID, requiredParams: ['name'] });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/templates`, body });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers['idempotency-key']).toBeUndefined();
  });

  it('update() → PATCH /templates/{id}', async () => {
    const { ray, calls } = setup(json({ id: ID, draftVersionId: 'v', requiredParams: [] }));
    await ray.templates.update(ID, body);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${BASE}/templates/${ID}`, body });
  });

  it.each([
    ['publish', 'publish'],
    ['archive', 'archive'],
    ['unarchive', 'unarchive'],
  ] as const)('%s() → POST /templates/{id}/%s without a body', async (method, segment) => {
    const { ray, calls } = setup(json({ id: ID }));
    await ray.templates[method](ID);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/templates/${ID}/${segment}`,
      body: undefined,
    });
  });

  it('testSend() → POST /templates/{id}/test-send', async () => {
    const { ray, calls } = setup(json({ sendId: ID }, 202));
    const payload = {
      channelConfigId: ID,
      recipient: { email: 'ada@example.com' },
      params: { name: 'Ada' },
    };
    await expect(ray.templates.testSend(ID, payload)).resolves.toEqual({ sendId: ID });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/templates/${ID}/test-send`,
      body: payload,
    });
  });
});

describe('notifications', () => {
  it('list() → GET /notifications with every filter', async () => {
    const { ray, calls } = setup(json({ notifications: [], nextCursor: null }));
    await ray.notifications.list({
      externalUserId: 'user 1',
      limit: 20,
      cursor: 'cur',
      templateId: ID,
      channelConfigId: ID,
      after: '2026-09-01T00:00:00Z',
      before: '2026-09-30T00:00:00Z',
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/notifications');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      externalUserId: 'user 1',
      limit: '20',
      cursor: 'cur',
      templateId: ID,
      channelConfigId: ID,
      after: '2026-09-01T00:00:00Z',
      before: '2026-09-30T00:00:00Z',
    });
  });

  it('listAll() pages until nextCursor is null', async () => {
    const { fetch, calls } = mockFetch(
      () => json({ notifications: [{ id: 'n1' }], nextCursor: 'c1' }),
      () => json({ notifications: [{ id: 'n2' }], nextCursor: 'c2' }),
      () => json({ notifications: [], nextCursor: null }),
    );
    const ray = client(fetch);
    const ids: string[] = [];
    for await (const n of ray.notifications.listAll({ externalUserId: 'u', limit: 1 })) {
      ids.push(n.id);
    }
    expect(ids).toEqual(['n1', 'n2']);
    expect(calls.map((c) => new URL(c.url).searchParams.get('cursor'))).toEqual([null, 'c1', 'c2']);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('limit')).toBe('1');
  });

  it('listAll() can stop early without fetching more pages', async () => {
    const { fetch, calls } = mockFetch(
      json({ notifications: [{ id: 'n1' }, { id: 'n2' }], nextCursor: 'c1' }),
    );
    const ray = client(fetch);
    for await (const _ of ray.notifications.listAll({ externalUserId: 'u' })) break;
    expect(calls).toHaveLength(1);
  });
});

describe('clicks', () => {
  it('get() → GET /clicks', async () => {
    const { ray, calls } = setup(json({ totalClicks: 0, byUrl: [] }));
    await ray.clicks.get({ sendId: ID, campaignId: 'sept' });
    expect(calls[0]?.url).toBe(`${BASE}/clicks?sendId=${ID}&campaignId=sept`);
  });
});

describe('webhooks', () => {
  it('list() → GET /tenant-webhooks', async () => {
    const { ray, calls } = setup(json({ webhooks: [] }));
    await ray.webhooks.list();
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/tenant-webhooks` });
    await ray.webhooks.list({ includeArchived: true });
    expect(calls[1]?.url).toBe(`${BASE}/tenant-webhooks?includeArchived=true`);
  });

  it('get() → GET /tenant-webhooks/{id}', async () => {
    const { ray, calls } = setup(json({ id: ID }));
    await ray.webhooks.get(ID);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/tenant-webhooks/${ID}` });
  });

  it('create() → POST /tenant-webhooks', async () => {
    const { ray, calls } = setup(json({ id: ID, secret: 's' }, 201));
    const body = {
      name: 'production',
      url: 'https://api.example.com/webhooks/ray',
      events: ['send.completed' as const],
    };
    await expect(ray.webhooks.create(body)).resolves.toMatchObject({ secret: 's' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/tenant-webhooks`, body });
  });

  it('update() → PATCH /tenant-webhooks/{id}', async () => {
    const { ray, calls } = setup(json({ id: ID, secret: 'new' }));
    await ray.webhooks.update(ID, { rotateSecret: true });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `${BASE}/tenant-webhooks/${ID}`,
      body: { rotateSecret: true },
    });
  });

  it('delete() → DELETE /tenant-webhooks/{id}', async () => {
    const { ray, calls } = setup(json({ id: ID, archived: true }));
    await expect(ray.webhooks.delete(ID)).resolves.toEqual({ id: ID, archived: true });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/tenant-webhooks/${ID}` });
  });
});
