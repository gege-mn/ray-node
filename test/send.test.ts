import { describe, expect, it } from 'vitest';
import type { SendBody } from '../src';
import { client, json, mockFetch } from './helpers';

const CHANNEL = '9f1c2a7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const TEMPLATE = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a';
const SEND_ID = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('ray.send()', () => {
  it('POSTs the body to /send and returns { sendId }', async () => {
    const { fetch, calls } = mockFetch(json({ sendId: SEND_ID }, 202));
    const body: SendBody = {
      channelConfigId: CHANNEL,
      templateId: TEMPLATE,
      params: { name: 'Ada', code: '482913' },
      recipient: { email: 'ada@example.com', name: 'Ada Lovelace' },
      externalUserId: 'user_123',
      showInFeed: true,
    };
    await expect(client(fetch).send(body)).resolves.toEqual({ sendId: SEND_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://ray-api.gege.mn/send',
      body,
    });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers.authorization).toBe('Bearer ck_live_test_key');
  });

  it('generates a UUID Idempotency-Key when none is given', async () => {
    const { fetch, calls } = mockFetch(json({ sendId: SEND_ID }, 202));
    const ray = client(fetch);
    const body: SendBody = { externalUserId: 'u', feed: { title: 'Export ready' } };
    await ray.send(body);
    await ray.send(body);
    const [a, b] = calls.map((c) => c.headers['idempotency-key']);
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });

  it('uses the caller idempotencyKey', async () => {
    const { fetch, calls } = mockFetch(json({ sendId: SEND_ID }, 202));
    await client(fetch).send(
      { externalUserId: 'u', feed: { title: 't' } },
      { idempotencyKey: '  order-1042  ' },
    );
    expect(calls[0]?.headers['idempotency-key']).toBe('order-1042');
  });

  it('accepts the key as an Idempotency-Key header too, without duplicating it', async () => {
    const { fetch, calls } = mockFetch(json({ sendId: SEND_ID }, 202));
    await client(fetch).send(
      { externalUserId: 'u', feed: { title: 't' } },
      { headers: { 'Idempotency-Key': 'from-header', 'X-Other': '1' } },
    );
    const headers = calls[0]?.headers ?? {};
    expect(headers['idempotency-key']).toBe('from-header');
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'idempotency-key')).toHaveLength(
      1,
    );
    expect(headers['x-other']).toBe('1');
  });

  it('keeps the same Idempotency-Key across retries', async () => {
    const { fetch, calls } = mockFetch(
      json({ error: 'internal_server_error' }, 500),
      json({ sendId: SEND_ID }, 202),
    );
    await client(fetch, { maxRetries: 1 }).send(
      { externalUserId: 'u', feed: { title: 't' } },
      { timeoutMs: 1000 },
    );
    // First retry backoff is at most 500ms; real timers are fine here.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers['idempotency-key']).toBe(calls[1]?.headers['idempotency-key']);
  });

  describe('request modes type-check and serialize as-is', () => {
    const cases: Array<[string, SendBody]> = [
      [
        'fan-out',
        {
          channelConfigId: CHANNEL,
          templateId: TEMPLATE,
          params: { releaseName: 'September update' },
          targets: [
            { recipient: { email: 'ada@example.com' }, externalUserId: 'user_1' },
            { recipient: { email: 'alan@example.com' } },
          ],
          showInFeed: true,
          priority: 'low',
        },
      ],
      [
        'multi-channel',
        {
          externalUserId: 'user_42',
          params: { feature: 'dark mode' },
          feed: { title: 'New feature is live' },
          deliveries: [
            {
              channelConfigId: CHANNEL,
              content: { title: 'New: {{feature}}', body: 'Open settings to try it.' },
              recipient: { deviceToken: 'fcm-token' },
            },
            { channelConfigId: CHANNEL, templateId: TEMPLATE, recipient: { email: 'a@b.co' } },
            {
              channelConfigId: CHANNEL,
              content: { text: 'Shipped *{{feature}}*' },
              params: { feature: 'dark mode (beta)' },
              recipient: {},
            },
          ],
        },
      ],
      ['feed-only', { externalUserId: 'user_42', feed: { title: 'Your export is ready' } }],
      [
        'sms fan-out (twilio_sms / sendsms_mn)',
        {
          channelConfigId: CHANNEL,
          content: { text: 'Your code is {{code}}' },
          logTitle: 'Login code',
          params: { code: '482913' },
          targets: [
            { recipient: { phoneNumber: '+97699112233' } },
            { recipient: { phoneNumber: '99112233' } },
          ],
        },
      ],
      [
        'inline content, scheduled, with attachments',
        {
          channelConfigId: CHANNEL,
          content: { subject: 'Invoice {{n}}', bodyHtml: '<p>Attached</p>', bodyText: 'Attached' },
          logTitle: 'Invoice sent',
          params: { n: 42 },
          recipient: {
            email: 'ada@example.com',
            cc: [{ email: 'billing@example.com' }],
            attachments: [
              { filename: 'invoice.pdf', content: 'JVBERi0xLjQK', contentType: 'application/pdf' },
            ],
          },
          notBefore: '2026-09-15T09:00:00+08:00',
          trackClicks: true,
          campaignId: 'invoices',
        },
      ],
      [
        'telegram and fcm topic',
        {
          channelConfigId: CHANNEL,
          content: { text: 'Hello', disableLinkPreview: true },
          recipient: { chatId: '12345' },
        },
      ],
    ];

    it.each(cases)('%s', async (_name, body) => {
      const { fetch, calls } = mockFetch(json({ sendId: SEND_ID }, 202));
      await client(fetch).send(body);
      expect(calls[0]?.body).toEqual(body);
    });
  });

  it('rejects invalid mode combinations at compile time', () => {
    const bad: SendBody[] = [
      // @ts-expect-error templateId and content are mutually exclusive
      { channelConfigId: CHANNEL, templateId: TEMPLATE, content: { text: 'x' }, recipient: {} },
      // @ts-expect-error recipient and targets are mutually exclusive
      { channelConfigId: CHANNEL, templateId: TEMPLATE, recipient: {}, targets: [] },
      // @ts-expect-error deliveries can't be combined with channelConfigId
      { channelConfigId: CHANNEL, deliveries: [] },
      // @ts-expect-error feed-only sends need feed.title
      { externalUserId: 'u', feed: {} },
      {
        channelConfigId: CHANNEL,
        templateId: TEMPLATE,
        // @ts-expect-error fcm recipient takes exactly one of deviceToken / topic
        recipient: { deviceToken: 'a', topic: 'b' },
      },
      // @ts-expect-error logTitle is only valid with inline content
      { channelConfigId: CHANNEL, templateId: TEMPLATE, logTitle: 'x', recipient: {} },
    ];
    expect(bad).toHaveLength(6);
  });
});
