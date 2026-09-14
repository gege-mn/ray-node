/**
 * Signature verification for requests Ray sends to your servers. Uses Web
 * Crypto only (`crypto.subtle`), so it runs on Node 18+, Bun, Deno,
 * Cloudflare Workers and Vercel Edge.
 *
 * Two different schemes exist:
 *
 * 1. Delivery webhooks (`POST /tenant-webhooks` subscriptions):
 *    `X-Ray-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
 *    → `verifyWebhookSignature` / `parseWebhookEvent`.
 * 2. The `generic_webhook` delivery channel (when a signing secret is set):
 *    `X-Ray-Timestamp: <ISO 8601>` and
 *    `X-Ray-Signature: sha256=<hex HMAC-SHA256(secret, "<X-Ray-Timestamp>.<raw body>")>`
 *    → `verifyChannelWebhookSignature` / `parseChannelWebhook`.
 *
 * In both, the secret is used as UTF-8 bytes exactly as Ray returned it.
 */
import { getWebCrypto } from './runtime';
import type { ChannelWebhookEnvelope, WebhookEvent } from './types';

export const SIGNATURE_HEADER = 'x-ray-signature';
export const TIMESTAMP_HEADER = 'x-ray-timestamp';
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Anything with header lookup: a Fetch `Headers`, Node's `IncomingHttpHeaders`, or a plain object. */
export type HeadersLike =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

/** The raw request body, exactly as received. Never a re-serialized JSON object. */
export type RawBody = string | Uint8Array | ArrayBuffer;

export interface VerifyWebhookOptions {
  /** Raw request body (`await request.text()`, `express.raw()` buffer, ...). */
  payload: RawBody;
  /** Request headers; `x-ray-signature` (and `x-ray-timestamp` for channel webhooks) are read from them. */
  headers: HeadersLike;
  /** Signing secret. Pass several during a rotation; any match is accepted. */
  secret: string | readonly string[];
  /** Maximum clock difference in seconds (default 300). `0` disables the check. */
  toleranceSeconds?: number;
}

export type WebhookVerificationReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch'
  | 'invalid_payload';

/** Thrown by `parseWebhookEvent` / `parseChannelWebhook` when a request can't be trusted. */
export class WebhookVerificationError extends Error {
  readonly reason: WebhookVerificationReason;

  constructor(reason: WebhookVerificationReason, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
  }
}

type CheckResult = { ok: true } | { ok: false; reason: WebhookVerificationReason; message: string };

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Delivery webhooks
// ---------------------------------------------------------------------------

/**
 * Verifies the `X-Ray-Signature` header of a delivery webhook request.
 * Resolves `true` only when a `v1` signature matches and `t` is within
 * `toleranceSeconds` of the current time.
 *
 * @example
 * const ok = await verifyWebhookSignature({
 *   payload: await request.text(),
 *   headers: request.headers,
 *   secret: process.env.RAY_WEBHOOK_SECRET!,
 * });
 */
export async function verifyWebhookSignature(options: VerifyWebhookOptions): Promise<boolean> {
  return (await checkDeliveryWebhook(options)).ok;
}

/**
 * Verifies a delivery webhook request and returns its typed event. Throws
 * `WebhookVerificationError` (with a `reason`) when verification fails.
 */
export async function parseWebhookEvent(options: VerifyWebhookOptions): Promise<WebhookEvent> {
  const result = await checkDeliveryWebhook(options);
  if (!result.ok) throw new WebhookVerificationError(result.reason, result.message);
  return parseJson<WebhookEvent>(options.payload);
}

/**
 * Produces an `X-Ray-Signature` header value the way Ray signs delivery
 * webhooks. Useful for testing your webhook handler.
 */
export async function signWebhookPayload(options: {
  payload: RawBody;
  secret: string;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
}): Promise<string> {
  const t = options.timestamp ?? Math.floor(Date.now() / 1000);
  const mac = await hmac(options.secret, signedBytes(`${t}.`, options.payload));
  return `t=${t},v1=${toHex(mac)}`;
}

async function checkDeliveryWebhook(options: VerifyWebhookOptions): Promise<CheckResult> {
  const header = readHeader(options.headers, SIGNATURE_HEADER);
  if (!header) {
    return fail('missing_signature', 'Missing X-Ray-Signature header');
  }

  // `t=<num>,v1=<hex>`; any order, unknown fields ignored (same as Ray's own verifier).
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',').map((p) => p.trim())) {
    if (part.startsWith('t=')) {
      const n = Number(part.slice(2));
      if (part.length > 2 && Number.isFinite(n) && n > 0) timestamp = n;
    } else if (part.startsWith('v1=')) {
      signatures.push(part.slice(3));
    }
  }
  if (timestamp === null || signatures.length === 0) {
    return fail(
      'malformed_signature',
      'X-Ray-Signature must look like t=<timestamp>,v1=<signature>',
    );
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (tolerance > 0 && Math.abs(Math.floor(Date.now() / 1000) - timestamp) > tolerance) {
    return fail(
      'timestamp_out_of_tolerance',
      `X-Ray-Signature timestamp is more than ${tolerance}s from the current time`,
    );
  }

  const data = signedBytes(`${timestamp}.`, options.payload);
  return (await matchesAny(options.secret, data, signatures))
    ? { ok: true }
    : fail('signature_mismatch', 'X-Ray-Signature does not match the payload and secret');
}

// ---------------------------------------------------------------------------
// generic_webhook channel
// ---------------------------------------------------------------------------

/**
 * Verifies a request from Ray's `generic_webhook` delivery channel
 * (`X-Ray-Signature: sha256=...` plus `X-Ray-Timestamp`).
 */
export async function verifyChannelWebhookSignature(
  options: VerifyWebhookOptions,
): Promise<boolean> {
  return (await checkChannelWebhook(options)).ok;
}

/**
 * Verifies a `generic_webhook` channel request and returns its envelope
 * `{ id, title, body, data?, sentAt }`. Throws `WebhookVerificationError`.
 */
export async function parseChannelWebhook(
  options: VerifyWebhookOptions,
): Promise<ChannelWebhookEnvelope> {
  const result = await checkChannelWebhook(options);
  if (!result.ok) throw new WebhookVerificationError(result.reason, result.message);
  return parseJson<ChannelWebhookEnvelope>(options.payload);
}

async function checkChannelWebhook(options: VerifyWebhookOptions): Promise<CheckResult> {
  const signature = readHeader(options.headers, SIGNATURE_HEADER);
  const timestamp = readHeader(options.headers, TIMESTAMP_HEADER);
  if (!signature || !timestamp) {
    return fail('missing_signature', 'Missing X-Ray-Signature or X-Ray-Timestamp header');
  }
  if (!signature.startsWith('sha256=')) {
    return fail('malformed_signature', 'X-Ray-Signature must look like sha256=<signature>');
  }
  const sentAtMs = Date.parse(timestamp);
  if (Number.isNaN(sentAtMs)) {
    return fail('malformed_signature', 'X-Ray-Timestamp is not a valid ISO 8601 timestamp');
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (tolerance > 0 && Math.abs(Date.now() - sentAtMs) > tolerance * 1000) {
    return fail(
      'timestamp_out_of_tolerance',
      `X-Ray-Timestamp is more than ${tolerance}s from the current time`,
    );
  }

  // The timestamp header string is signed verbatim, not a normalized form.
  const data = signedBytes(`${timestamp}.`, options.payload);
  return (await matchesAny(options.secret, data, [signature.slice('sha256='.length)]))
    ? { ok: true }
    : fail('signature_mismatch', 'X-Ray-Signature does not match the payload and secret');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(reason: WebhookVerificationReason, message: string): CheckResult {
  return { ok: false, reason, message };
}

function readHeader(headers: HeadersLike, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null | undefined }).get(name);
    return value ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== name) continue;
    const value = record[key];
    return Array.isArray(value) ? value.join(',') : value;
  }
  return undefined;
}

function toBytes(payload: RawBody): Uint8Array {
  if (typeof payload === 'string') return encoder.encode(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (Object.prototype.toString.call(payload) === '[object ArrayBuffer]') {
    return new Uint8Array(payload as ArrayBuffer);
  }
  throw new TypeError(
    '@gege-mn/ray: webhook payload must be the raw body as a string, Uint8Array/Buffer or ArrayBuffer',
  );
}

function signedBytes(prefix: string, payload: RawBody): Uint8Array {
  const head = encoder.encode(prefix);
  const body = toBytes(payload);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

async function importKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const crypto = await getWebCrypto();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

async function hmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const crypto = await getWebCrypto();
  const key = await importKey(secret, 'sign');
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource));
}

async function matchesAny(
  secret: string | readonly string[],
  data: Uint8Array,
  hexSignatures: string[],
): Promise<boolean> {
  const secrets = typeof secret === 'string' ? [secret] : [...secret];
  if (secrets.length === 0 || secrets.some((s) => typeof s !== 'string' || s === '')) {
    throw new TypeError('@gege-mn/ray: webhook secret must be a non-empty string');
  }
  const decoded = hexSignatures.map(fromHex).filter((b): b is Uint8Array => b !== null);
  if (decoded.length === 0) return false;

  const crypto = await getWebCrypto();
  let matched = false;
  for (const s of secrets) {
    const key = await importKey(s, 'verify');
    for (const signature of decoded) {
      // subtle.verify compares in constant time. No early exit, so timing
      // doesn't reveal which secret matched.
      if (
        await crypto.subtle.verify('HMAC', key, signature as BufferSource, data as BufferSource)
      ) {
        matched = true;
      }
    }
  }
  return matched;
}

/** Decodes a 64-character hex SHA-256 MAC, or `null` if it isn't one. */
function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseJson<T>(payload: RawBody): T {
  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(toBytes(payload));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WebhookVerificationError('invalid_payload', 'Webhook payload is not valid JSON');
  }
}
