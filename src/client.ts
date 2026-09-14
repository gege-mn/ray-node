import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  HttpClient,
  type RequestOptions,
} from './core';
import { RayError } from './errors';
import { Channels } from './resources/channels';
import { Clicks } from './resources/clicks';
import { Notifications } from './resources/notifications';
import { Sends } from './resources/sends';
import { Templates } from './resources/templates';
import { Webhooks } from './resources/webhooks';
import { randomUUID, readEnv, VERSION } from './runtime';
import type { Me, SendAccepted, SendBody, Usage } from './types';

export interface RayOptions {
  /** API key (`ck_live_...`). Defaults to the `RAY_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `https://ray-api.gege.mn`. */
  baseUrl?: string;
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Per-attempt timeout in milliseconds. Default 30000. `0` disables it. */
  timeoutMs?: number;
  /** Retries for retryable failures (see README "Retries"). Default 2. */
  maxRetries?: number;
  /** Prepended to the SDK's own `ray-node/<version>` User-Agent. */
  userAgent?: string;
}

export interface SendOptions extends RequestOptions {
  /**
   * Idempotency key for this send. When omitted the SDK generates a random
   * UUID so its own retries can't send twice. Pass a key derived from your
   * business event (e.g. `order-confirmation-<orderId>`) to also dedupe
   * retries you make yourself, across processes, for 24 hours.
   */
  idempotencyKey?: string;
}

/**
 * Ray API client.
 *
 * @example
 * import { Ray } from '@gege-mn/ray';
 * const ray = new Ray(process.env.RAY_API_KEY);
 * const { sendId } = await ray.send({
 *   channelConfigId: '9f1c2a7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
 *   templateId: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
 *   params: { name: 'Ada' },
 *   recipient: { email: 'ada@example.com' },
 * });
 */
export class Ray {
  readonly sends: Sends;
  readonly channels: Channels;
  readonly templates: Templates;
  readonly notifications: Notifications;
  readonly clicks: Clicks;
  readonly webhooks: Webhooks;

  private readonly http: HttpClient;

  constructor(apiKey?: string, options?: RayOptions);
  constructor(options?: RayOptions);
  constructor(apiKeyOrOptions?: string | RayOptions, maybeOptions: RayOptions = {}) {
    const options =
      typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null
        ? apiKeyOrOptions
        : { ...maybeOptions, apiKey: apiKeyOrOptions ?? maybeOptions.apiKey };

    const apiKey = options.apiKey?.trim() || readEnv('RAY_API_KEY');
    if (!apiKey) {
      throw new RayError({
        status: 0,
        code: 'missing_api_key',
        message:
          'Missing Ray API key. Pass it as `new Ray(apiKey)` or set the RAY_API_KEY environment variable. ' +
          'Create a key in the Ray dashboard: https://ray.gege.mn',
      });
    }

    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof fetchImpl !== 'function') {
      throw new TypeError(
        '@gege-mn/ray: no global fetch found. Use Node 18+ or pass `fetch` in the client options.',
      );
    }

    const sdkAgent = `ray-node/${VERSION}`;
    this.http = new HttpClient({
      apiKey,
      baseUrl: (options.baseUrl ?? readEnv('RAY_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      // Unbound global fetch throws "Illegal invocation" in some runtimes.
      fetch: options.fetch ? options.fetch : (input, init) => fetchImpl(input, init),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      userAgent: options.userAgent ? `${options.userAgent} ${sdkAgent}` : sdkAgent,
    });

    this.sends = new Sends(this.http);
    this.channels = new Channels(this.http);
    this.templates = new Templates(this.http);
    this.notifications = new Notifications(this.http);
    this.clicks = new Clicks(this.http);
    this.webhooks = new Webhooks(this.http);
  }

  /** The resolved base URL, without a trailing slash. */
  get baseUrl(): string {
    return this.http.config.baseUrl;
  }

  /**
   * `POST /send` (`write` scope): renders and queues a notification, resolving
   * with `{ sendId }` once Ray accepted it (delivery is asynchronous).
   *
   * Always sends an `Idempotency-Key` (yours, or a generated UUID), so network
   * errors, timeouts, 429, 5xx and "idempotency key in progress" 409s are
   * retried without risk of a duplicate send.
   */
  async send(body: SendBody, options: SendOptions = {}): Promise<SendAccepted> {
    const { idempotencyKey, ...requestOptions } = options;
    const headerKey = Object.entries(requestOptions.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'idempotency-key',
    )?.[1];
    const key = idempotencyKey?.trim() || headerKey?.trim() || (await randomUUID());
    return this.http.request<SendAccepted>({
      method: 'POST',
      path: '/send',
      body,
      headers: { 'idempotency-key': key },
      retry: 'idempotent',
      options: {
        ...requestOptions,
        headers: withoutHeader(requestOptions.headers, 'idempotency-key'),
      },
    });
  }

  /** `GET /me`: the workspace (`tenantId`), key id and scopes of the API key. */
  me(options?: RequestOptions): Promise<Me> {
    return this.http.request<Me>({ method: 'GET', path: '/me', retry: 'read', options });
  }

  /** `GET /billing/subscription`: plan, subscription and this month's notification usage. */
  usage(options?: RequestOptions): Promise<Usage> {
    return this.http.request<Usage>({
      method: 'GET',
      path: '/billing/subscription',
      retry: 'read',
      options,
    });
  }
}

function withoutHeader(
  headers: Record<string, string> | undefined,
  name: string,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== name));
}
