/**
 * Error codes returned by the Ray API in the `error` field of its JSON error
 * envelope, plus the SDK's own client-side codes (`connection_error`,
 * `timeout`, `missing_api_key`). Other strings may appear in future API
 * versions, so the type stays open.
 */
export type RayErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'quota_exceeded'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limit_exceeded'
  | 'internal_server_error'
  | 'connection_error'
  | 'timeout'
  | 'missing_api_key'
  | (string & {});

export interface RayErrorInit {
  status: number;
  code: RayErrorCode;
  message: string;
  requestId?: string | undefined;
  retryAfter?: number | undefined;
  headers?: Headers | undefined;
  body?: unknown;
  cause?: unknown;
}

/**
 * Thrown for every failed Ray API call.
 *
 * - `status`: HTTP status, or `0` when no response was received (network
 *   error, timeout, missing API key).
 * - `code`: the API's stable machine-readable `error` code (branch on this).
 * - `message`: human-readable detail from the API (don't parse it).
 * - `requestId`: the `x-request-id` response header, useful for support.
 * - `retryAfter`: seconds to wait before retrying (`429` responses).
 * - `body`: the parsed error body; `402` responses carry `limit` and `used`.
 */
export class RayError extends Error {
  readonly status: number;
  readonly code: RayErrorCode;
  readonly requestId: string | undefined;
  readonly retryAfter: number | undefined;
  readonly headers: Headers | undefined;
  readonly body: unknown;

  constructor(init: RayErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'RayError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
    this.headers = init.headers;
    this.body = init.body;
  }
}

/** Codes used when a response has no JSON error envelope (e.g. a proxy error page). */
const FALLBACK_CODES: Record<number, RayErrorCode> = {
  400: 'validation_error',
  401: 'unauthorized',
  402: 'quota_exceeded',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'rate_limit_exceeded',
};

/** Parses `Retry-After` (delta-seconds or HTTP date) into seconds. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - nowMs) / 1000);
}

/**
 * Builds a `RayError` from a non-2xx response. Ray's envelope is
 * `{ "error": "<code>", "message": "<detail>" }` with optional extras
 * (`retry_after_seconds` on 429, `limit` / `used` on 402); a 500 carries only
 * `{ "error": "internal_server_error" }`, and unknown paths return plain text.
 */
export async function errorFromResponse(res: Response): Promise<RayError> {
  const text = await res.text().catch(() => '');
  let body: unknown = text === '' ? undefined : text;
  try {
    if (text !== '') body = JSON.parse(text);
  } catch {
    // Not JSON: keep the raw text.
  }

  const envelope =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as { error?: unknown; message?: unknown; retry_after_seconds?: unknown })
      : undefined;

  const code: RayErrorCode =
    typeof envelope?.error === 'string'
      ? envelope.error
      : (FALLBACK_CODES[res.status] ??
        (res.status >= 500 ? 'internal_server_error' : 'http_error'));

  let message: string;
  if (typeof envelope?.message === 'string' && envelope.message !== '') {
    message = envelope.message;
  } else if (typeof body === 'string' && body.trim() !== '' && body.length <= 500) {
    message = body.trim();
  } else {
    message = `Ray API request failed with status ${res.status}${code ? ` (${code})` : ''}`;
  }

  let retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  if (retryAfter === undefined && typeof envelope?.retry_after_seconds === 'number') {
    retryAfter = envelope.retry_after_seconds;
  }

  return new RayError({
    status: res.status,
    code,
    message,
    requestId: res.headers.get('x-request-id') ?? undefined,
    retryAfter,
    headers: res.headers,
    body,
  });
}
