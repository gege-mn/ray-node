import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseChannelWebhook,
  parseWebhookEvent,
  signWebhookPayload,
  verifyChannelWebhookSignature,
  verifyWebhookSignature,
  type WebhookEvent,
  WebhookVerificationError,
} from '../src';

// ---------------------------------------------------------------------------
// Reference implementations, copied from the Ray monorepo:
//   packages/shared/src/auth/webhook-signature.ts (signWebhook / verifyWebhook)
//   packages/channels/src/generic-webhook/send.ts (generic_webhook channel signing)
// ---------------------------------------------------------------------------

function raySignWebhook(opts: { secret: string; body: string; timestamp?: number }): string {
  const t = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', opts.secret).update(`${t}.${opts.body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

function rayVerifyWebhook(opts: {
  header: string;
  body: string;
  secret: string;
  replayWindowSeconds?: number;
}): boolean {
  const now = Math.floor(Date.now() / 1000);
  const replayWindow = opts.replayWindowSeconds ?? 300;
  const parts = opts.header.split(',').map((p) => p.trim());
  let timestamp: number | null = null;
  let received: string | null = null;
  for (const part of parts) {
    if (part.startsWith('t=')) {
      const n = Number(part.slice(2));
      if (Number.isFinite(n) && n > 0) timestamp = n;
    } else if (part.startsWith('v1=')) {
      received = part.slice(3);
    }
  }
  if (timestamp === null || received === null) return false;
  if (replayWindow > 0 && Math.abs(now - timestamp) > replayWindow) return false;
  const expected = createHmac('sha256', opts.secret).update(`${timestamp}.${opts.body}`).digest();
  const receivedBuf = Buffer.from(received, 'hex');
  if (receivedBuf.length !== expected.length) return false;
  return timingSafeEqual(receivedBuf, expected);
}

function raySignChannelWebhook(secret: string, sentAt: string, payload: string) {
  const signature = createHmac('sha256', secret).update(`${sentAt}.${payload}`).digest('hex');
  return { 'x-ray-signature': `sha256=${signature}`, 'x-ray-timestamp': sentAt };
}

// ---------------------------------------------------------------------------

const SECRET = 'q3Xk9vB2mN7pL4sT8wY1zA6cE0gH5jK2rU9oI3dF7bM';
const NOW = 1_789_378_201; // 2026-09-14T09:30:01Z

const deliveredEvent = {
  event: 'notification.delivered',
  occurred_at: '2026-09-14T09:30:01.502Z',
  send_id: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d',
  notification_log_id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
  channel_config_id: '9f1c2a7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  template_id: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
  external_user_id: 'user_123',
  provider_message_id: '0100019252a1b2c3',
  provider_error: null,
  is_test: false,
};
// Ray's worker signs exactly JSON.stringify(payload).
const BODY = JSON.stringify(deliveredEvent);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('verifyWebhookSignature (delivery webhooks)', () => {
  it('accepts a header produced by Ray’s signWebhook', async () => {
    const header = raySignWebhook({ secret: SECRET, body: BODY, timestamp: NOW });
    const headers = new Headers({ 'X-Ray-Signature': header });
    await expect(verifyWebhookSignature({ payload: BODY, headers, secret: SECRET })).resolves.toBe(
      true,
    );
  });

  it('matches a fixed vector', async () => {
    const header = raySignWebhook({
      secret: 'whsec_test',
      body: '{"event":"send.completed"}',
      timestamp: 1_700_000_000,
    });
    expect(header).toBe(
      't=1700000000,v1=b05160acadc56c4a0d4b1792a5f44b2c83a463df7f0bfcd4e25427d949143cb8',
    );
    await expect(
      signWebhookPayload({
        payload: '{"event":"send.completed"}',
        secret: 'whsec_test',
        timestamp: 1_700_000_000,
      }),
    ).resolves.toBe(header);
  });

  it('signWebhookPayload is byte-for-byte identical to Ray’s signer (unicode, bytes, empty)', async () => {
    const bodies = [BODY, '', '{"title":"Сайн байна уу 👋","x":"\\u2028"}', ' {"spaced": true} \n'];
    for (const body of bodies) {
      const expected = raySignWebhook({ secret: SECRET, body, timestamp: NOW });
      await expect(
        signWebhookPayload({ payload: body, secret: SECRET, timestamp: NOW }),
      ).resolves.toBe(expected);
      await expect(
        signWebhookPayload({ payload: Buffer.from(body, 'utf8'), secret: SECRET, timestamp: NOW }),
      ).resolves.toBe(expected);
    }
  });

  it('accepts string, Buffer, Uint8Array and ArrayBuffer payloads', async () => {
    const header = raySignWebhook({ secret: SECRET, body: BODY, timestamp: NOW });
    const headers = { 'x-ray-signature': header };
    const buffer = Buffer.from(BODY, 'utf8');
    const u8 = new TextEncoder().encode(BODY);
    for (const payload of [BODY, buffer, u8, u8.buffer.slice(0)]) {
      await expect(verifyWebhookSignature({ payload, headers, secret: SECRET })).resolves.toBe(
        true,
      );
    }
    // A Buffer that is a view into a larger pool must only use its own bytes.
    const pooled = Buffer.concat([Buffer.from('xxxx'), buffer]).subarray(4);
    await expect(
      verifyWebhookSignature({ payload: pooled, headers, secret: SECRET }),
    ).resolves.toBe(true);
  });

  it('reads Node IncomingHttpHeaders-style objects case-insensitively', async () => {
    const header = raySignWebhook({ secret: SECRET, body: BODY, timestamp: NOW });
    for (const headers of [
      { 'x-ray-signature': header },
      { 'X-Ray-Signature': header },
      { 'x-ray-signature': [header] },
    ]) {
      await expect(
        verifyWebhookSignature({ payload: BODY, headers, secret: SECRET }),
      ).resolves.toBe(true);
    }
  });

  it('rejects a tampered body, wrong secret, or re-serialized JSON', async () => {
    const header = raySignWebhook({ secret: SECRET, body: BODY, timestamp: NOW });
    const headers = { 'x-ray-signature': header };
    await expect(
      verifyWebhookSignature({
        payload: BODY.replace('delivered', 'hijacked'),
        headers,
        secret: SECRET,
      }),
    ).resolves.toBe(false);
    await expect(verifyWebhookSignature({ payload: BODY, headers, secret: 'other' })).resolves.toBe(
      false,
    );
    await expect(
      verifyWebhookSignature({
        payload: JSON.stringify(JSON.parse(BODY), null, 2),
        headers,
        secret: SECRET,
      }),
    ).resolves.toBe(false);
  });

  it('accepts any of several secrets (rotation)', async () => {
    const header = raySignWebhook({ secret: SECRET, body: BODY, timestamp: NOW });
    await expect(
      verifyWebhookSignature({
        payload: BODY,
        headers: { 'x-ray-signature': header },
        secret: ['old-secret', SECRET],
      }),
    ).resolves.toBe(true);
  });

  it('enforces the 300s default tolerance in both directions, inclusive', async () => {
    const at = (t: number) => ({
      'x-ray-signature': raySignWebhook({ secret: SECRET, body: BODY, timestamp: t }),
    });
    const check = (t: number, toleranceSeconds?: number) =>
      verifyWebhookSignature({ payload: BODY, headers: at(t), secret: SECRET, toleranceSeconds });

    await expect(check(NOW - 300)).resolves.toBe(true);
    await expect(check(NOW - 301)).resolves.toBe(false);
    await expect(check(NOW + 300)).resolves.toBe(true);
    await expect(check(NOW + 301)).resolves.toBe(false);
    await expect(check(NOW - 1000, 3600)).resolves.toBe(true);
    await expect(check(NOW - 86_400, 0)).resolves.toBe(true);
  });

  it('agrees with Ray’s own verifier on malformed and edge-case headers', async () => {
    const good = raySignWebhook({ secret: SECRET, body: BODY, timestamp: NOW });
    const sig = good.split('v1=')[1] ?? '';
    const headers = [
      good,
      `v1=${sig},t=${NOW}`,
      ` t=${NOW} , v1=${sig} `,
      `t=${NOW},v1=${sig},v2=ignored`,
      `t=${NOW},v0=abc,v1=${sig}`,
      `t=${NOW}`,
      `v1=${sig}`,
      '',
      'garbage',
      `t=abc,v1=${sig}`,
      `t=0,v1=${sig}`,
      `t=-5,v1=${sig}`,
      `t=${NOW},v1=`,
      `t=${NOW},v1=${sig.slice(0, 62)}`,
      `t=${NOW},v1=${sig.toUpperCase()}`,
      `t=${NOW},v1=${'0'.repeat(64)}`,
      `t=${NOW - 1},v1=${sig}`,
      `t=${NOW - 400},v1=${sig}`,
    ];
    for (const header of headers) {
      const expected = rayVerifyWebhook({ header, body: BODY, secret: SECRET });
      const actual = await verifyWebhookSignature({
        payload: BODY,
        headers: { 'x-ray-signature': header },
        secret: SECRET,
      });
      expect({ header, ok: actual }).toEqual({ header, ok: expected });
    }
  });

  it('returns false when the header is missing', async () => {
    await expect(
      verifyWebhookSignature({ payload: BODY, headers: new Headers(), secret: SECRET }),
    ).resolves.toBe(false);
  });

  it('throws on an empty secret or a non-raw payload', async () => {
    const headers = {
      'x-ray-signature': raySignWebhook({ secret: SECRET, body: BODY, timestamp: NOW }),
    };
    await expect(verifyWebhookSignature({ payload: BODY, headers, secret: '' })).rejects.toThrow(
      TypeError,
    );
    await expect(
      // @ts-expect-error a parsed object is not a raw body
      verifyWebhookSignature({ payload: deliveredEvent, headers, secret: SECRET }),
    ).rejects.toThrow(/raw body/);
  });
});

describe('parseWebhookEvent', () => {
  it('returns the typed event after verifying', async () => {
    const completed = {
      event: 'send.completed',
      occurred_at: '2026-09-14T09:31:40.001Z',
      send_id: 's',
      channel_config_id: null,
      channel_config_ids: [],
      template_id: null,
      recipient_count: 1,
      totals: { total: 1, delivered: 1, failed_terminal: 0, suppressed: 0 },
    };
    const body = JSON.stringify(completed);
    const request = new Request('https://example.com/webhooks/ray', {
      method: 'POST',
      headers: { 'x-ray-signature': raySignWebhook({ secret: SECRET, body, timestamp: NOW }) },
      body,
    });
    const event: WebhookEvent = await parseWebhookEvent({
      payload: await request.text(),
      headers: request.headers,
      secret: SECRET,
    });
    expect(event).toEqual(completed);
    if (event.event === 'send.completed') {
      expect(event.totals.delivered).toBe(1);
    } else {
      throw new Error('narrowing failed');
    }
  });

  it.each([
    ['missing_signature', {}],
    ['malformed_signature', { 'x-ray-signature': 'nope' }],
    ['timestamp_out_of_tolerance', { 'x-ray-signature': `t=${NOW - 3600},v1=${'a'.repeat(64)}` }],
    ['signature_mismatch', { 'x-ray-signature': `t=${NOW},v1=${'a'.repeat(64)}` }],
  ] as const)('throws WebhookVerificationError(%s)', async (reason, headers) => {
    const error = await parseWebhookEvent({ payload: BODY, headers, secret: SECRET }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect(error).toMatchObject({ reason, name: 'WebhookVerificationError' });
  });

  it('throws invalid_payload for a validly signed non-JSON body', async () => {
    const body = 'not json';
    const headers = { 'x-ray-signature': raySignWebhook({ secret: SECRET, body, timestamp: NOW }) };
    await expect(
      parseWebhookEvent({ payload: body, headers, secret: SECRET }),
    ).rejects.toMatchObject({
      reason: 'invalid_payload',
    });
  });
});

describe('generic_webhook channel signatures', () => {
  const sentAt = '2026-09-14T09:30:01.234Z';
  const envelope = {
    id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    title: 'New order A-1042',
    body: 'Ada ordered 3 items for $59.00',
    data: { orderId: 'A-1042', total: '59.00' },
    sentAt,
  };
  const payload = JSON.stringify(envelope);
  const secret = 'channel-signing-secret-1234';

  it('verifies and parses a request signed like Ray’s generic_webhook channel', async () => {
    const headers = raySignChannelWebhook(secret, sentAt, payload);
    await expect(verifyChannelWebhookSignature({ payload, headers, secret })).resolves.toBe(true);
    await expect(parseChannelWebhook({ payload, headers, secret })).resolves.toEqual(envelope);
  });

  it('is not confused with the delivery webhook scheme', async () => {
    const headers = raySignChannelWebhook(secret, sentAt, payload);
    await expect(verifyWebhookSignature({ payload, headers, secret })).resolves.toBe(false);
    const deliveryHeaders = {
      'x-ray-signature': raySignWebhook({ secret, body: payload, timestamp: NOW }),
    };
    await expect(
      verifyChannelWebhookSignature({ payload, headers: deliveryHeaders, secret }),
    ).resolves.toBe(false);
  });

  it('rejects tampering, stale timestamps and a rewritten timestamp header', async () => {
    const headers = raySignChannelWebhook(secret, sentAt, payload);
    await expect(
      verifyChannelWebhookSignature({ payload: payload.replace('59.00', '0.01'), headers, secret }),
    ).resolves.toBe(false);
    await expect(
      verifyChannelWebhookSignature({
        payload,
        headers: { ...headers, 'x-ray-timestamp': '2026-09-14T09:30:02.234Z' },
        secret,
      }),
    ).resolves.toBe(false);

    vi.setSystemTime(Date.parse(sentAt) + 301_000);
    await expect(verifyChannelWebhookSignature({ payload, headers, secret })).resolves.toBe(false);
    await expect(
      verifyChannelWebhookSignature({ payload, headers, secret, toleranceSeconds: 0 }),
    ).resolves.toBe(true);
  });

  it.each([
    ['missing_signature', { 'x-ray-signature': 'sha256=abc' }],
    ['malformed_signature', { 'x-ray-signature': 'v1=abc', 'x-ray-timestamp': sentAt }],
    ['malformed_signature', { 'x-ray-signature': 'sha256=abc', 'x-ray-timestamp': 'yesterday' }],
    [
      'signature_mismatch',
      { 'x-ray-signature': `sha256=${'b'.repeat(64)}`, 'x-ray-timestamp': sentAt },
    ],
  ] as const)('parseChannelWebhook throws %s', async (reason, headers) => {
    await expect(parseChannelWebhook({ payload, headers, secret })).rejects.toMatchObject({
      reason,
    });
  });
});
