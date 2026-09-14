import { errorFromResponse, parseRetryAfter, RayError } from './errors';

export const DEFAULT_BASE_URL = 'https://ray-api.gege.mn';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
/** A server-requested wait longer than this is not retried; the error is thrown instead. */
export const MAX_RETRY_AFTER_MS = 60_000;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Options accepted by every SDK method (the last argument). */
export interface RequestOptions {
  /** Abort the request (including pending retries). */
  signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds. Defaults to the client's `timeoutMs`. */
  timeoutMs?: number;
  /** Maximum retries for this call. Defaults to the client's `maxRetries`. */
  maxRetries?: number;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
}

/**
 * How a call may be retried.
 *
 * - `read`: GET. Retried on network errors, timeouts, 429 and 5xx.
 * - `idempotent`: `POST /send` with an `Idempotency-Key`. Same as `read`, plus
 *   409 "already in progress" (the first attempt is still being processed).
 * - `write`: every other POST / PATCH / DELETE. Retried only on 429, which Ray
 *   returns before the request reaches the handler, so nothing was changed.
 */
export type RetryMode = 'read' | 'idempotent' | 'write';

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | null | undefined> | undefined;
  body?: unknown;
  headers?: Record<string, string>;
  retry: RetryMode;
  options?: RequestOptions | undefined;
}

export interface ClientConfig {
  apiKey: string;
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs: number;
  maxRetries: number;
  userAgent: string;
}

type Attempt =
  | { kind: 'response'; value: unknown }
  | { kind: 'error'; error: RayError; retryable: boolean; delayMs?: number };

export class HttpClient {
  constructor(readonly config: ClientConfig) {}

  buildUrl(path: string, query?: ApiRequest['query']): string {
    let url = `${this.config.baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        params.append(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  async request<T>(req: ApiRequest): Promise<T> {
    const opts = req.options ?? {};
    const maxRetries = Math.max(0, opts.maxRetries ?? this.config.maxRetries);
    const url = this.buildUrl(req.path, req.query);

    for (let attempt = 0; ; attempt++) {
      const result = await this.attempt(req, url, opts);
      if (result.kind === 'response') return result.value as T;

      if (!result.retryable || attempt >= maxRetries) throw result.error;

      const delayMs = result.delayMs ?? backoffDelay(attempt);
      if (delayMs > MAX_RETRY_AFTER_MS) throw result.error;
      await sleep(delayMs, opts.signal);
    }
  }

  private async attempt(req: ApiRequest, url: string, opts: RequestOptions): Promise<Attempt> {
    const userSignal = opts.signal;
    if (userSignal?.aborted) throw abortReason(userSignal);

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;
    const onAbort = () => controller.abort();
    userSignal?.addEventListener('abort', onAbort, { once: true });

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.config.apiKey}`,
      'user-agent': this.config.userAgent,
    };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    Object.assign(headers, lowerKeys(req.headers), lowerKeys(opts.headers));

    try {
      let res: Response;
      try {
        res = await this.config.fetch(url, {
          method: req.method,
          headers,
          ...(req.body !== undefined && { body: JSON.stringify(req.body) }),
          signal: controller.signal,
        });
      } catch (err) {
        if (userSignal?.aborted) throw abortReason(userSignal);
        const retryable = req.retry !== 'write';
        const error = timedOut
          ? new RayError({
              status: 0,
              code: 'timeout',
              message: `Request to ${req.method} ${req.path} timed out after ${timeoutMs}ms`,
              cause: err,
            })
          : new RayError({
              status: 0,
              code: 'connection_error',
              message: `Could not reach the Ray API (${req.method} ${req.path}): ${
                err instanceof Error ? err.message : String(err)
              }`,
              cause: err,
            });
        return { kind: 'error', error, retryable };
      }

      if (res.ok) {
        try {
          const text = await res.text();
          return { kind: 'response', value: text === '' ? undefined : JSON.parse(text) };
        } catch (err) {
          if (userSignal?.aborted) throw abortReason(userSignal);
          // The request succeeded server-side; retrying could repeat a write.
          const error = new RayError({
            status: res.status,
            code: timedOut ? 'timeout' : 'invalid_response',
            message: timedOut
              ? `Reading the response of ${req.method} ${req.path} timed out after ${timeoutMs}ms`
              : `Ray API returned an unreadable response for ${req.method} ${req.path}`,
            requestId: res.headers.get('x-request-id') ?? undefined,
            headers: res.headers,
            cause: err,
          });
          return { kind: 'error', error, retryable: req.retry === 'read' };
        }
      }

      const error = await errorFromResponse(res);
      return {
        kind: 'error',
        error,
        retryable: isRetryableStatus(req.retry, error),
        delayMs: serverDelayMs(res, error),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      userSignal?.removeEventListener('abort', onAbort);
    }
  }
}

function isRetryableStatus(mode: RetryMode, error: RayError): boolean {
  if (error.status === 429) return true;
  if (mode === 'write') return false;
  if (error.status >= 500) return true;
  if (mode === 'idempotent' && error.status === 409) {
    // "a request with this Idempotency-Key is already in progress" /
    // "Idempotency-Key is in use; retry shortly". Not "reused with a
    // different request body", which is permanent.
    return /in progress|retry shortly/i.test(error.message);
  }
  return false;
}

/** Wait requested by the server (`Retry-After`, `retry_after_seconds`, `RateLimit-Reset`), in ms. */
function serverDelayMs(res: Response, error: RayError): number | undefined {
  if (error.retryAfter !== undefined) return Math.ceil(error.retryAfter * 1000);
  if (res.status === 429 && res.headers.get('ratelimit-remaining') === '0') {
    const reset = parseRetryAfter(res.headers.get('ratelimit-reset'));
    if (reset !== undefined) return Math.ceil(reset * 1000);
  }
  return undefined;
}

/** Exponential backoff (0.5s, 1s, 2s, ... capped at 8s) with up to 25% jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** attempt);
  return Math.round(base * (1 - random() * 0.25));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
}

export function encodePath(segment: string): string {
  if (typeof segment !== 'string' || segment === '') {
    throw new TypeError('@gege-mn/ray: id must be a non-empty string');
  }
  return encodeURIComponent(segment);
}
