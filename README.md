# @gege-mn/ray

The official TypeScript SDK for [Ray](https://ray.gege.mn), the notification delivery API.

[![npm](https://img.shields.io/npm/v/@gege-mn/ray)](https://www.npmjs.com/package/@gege-mn/ray)
[![CI](https://github.com/gege-mn/ray-node/actions/workflows/ci.yml/badge.svg)](https://github.com/gege-mn/ray-node/actions/workflows/ci.yml)

Ray is a multi-tenant notification delivery API (not the Ray distributed computing framework). You configure channels once (Amazon SES or SMTP email, Firebase push, Slack, Discord, Telegram, or your own HTTPS webhook), keep message templates in Ray, and send with one `POST /send` call: to one recipient, fanned out to up to 1000 recipients, or to one person over several channels at once. Ray queues and paces delivery per provider, retries transient failures, tracks per-recipient status, keeps an in-app notification feed per end user, and calls your webhooks when deliveries finish.

- Zero runtime dependencies, built on `fetch` and Web Crypto
- ESM and CommonJS, full TypeScript types
- Runs on Node.js 18+, Bun, Deno, Cloudflare Workers and Vercel Edge
- Safe retries: `send()` always carries an `Idempotency-Key`
- Webhook signature verification that matches Ray's signer exactly

Docs: https://ray.gege.mn/docs · SDK guide: https://ray.gege.mn/docs/sdk · API reference: https://ray-api.gege.mn/docs · For AI agents: https://ray.gege.mn/llms.txt

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Sending](#sending)
- [Idempotency](#idempotency)
- [Delivery status](#delivery-status)
- [In-app feed](#in-app-feed)
- [Templates](#templates)
- [Channels](#channels)
- [Click stats](#click-stats)
- [Delivery webhooks](#delivery-webhooks)
- [Verifying webhooks](#verifying-webhooks)
- [Errors](#errors)
- [Retries, timeouts and configuration](#retries-timeouts-and-configuration)
- [Account and usage](#account-and-usage)
- [TypeScript](#typescript)
- [For AI agents](#for-ai-agents)

## Install

```bash
npm install @gege-mn/ray
# or
pnpm add @gege-mn/ray
# or
yarn add @gege-mn/ray
# or
bun add @gege-mn/ray
```

Deno: `import { Ray } from 'npm:@gege-mn/ray';`

## Quickstart

1. Create an API key in the Ray dashboard (https://ray.gege.mn) and add a channel (for example Amazon SES).
2. Set `RAY_API_KEY=ck_live_...` in your server environment.
3. Send:

```ts
import { Ray } from '@gege-mn/ray';

const ray = new Ray(); // reads RAY_API_KEY; or new Ray('ck_live_...')

const { channels } = await ray.channels.list();
const email = channels.find((c) => c.kind === 'ses_email');

const { sendId } = await ray.send({
  channelConfigId: email!.id,
  content: {
    subject: 'Welcome, {{name}}',
    bodyHtml: '<p>Hi {{name}}, thanks for signing up.</p>',
    bodyText: 'Hi {{name}}, thanks for signing up.',
  },
  params: { name: 'Ada' },
  recipient: { email: 'ada@example.com' },
});

const status = await ray.sends.get(sendId);
console.log(status.aggregate); // { total: 1, pending: 1 } → later { total: 1, delivered: 1 }
```

`send()` resolves as soon as Ray accepts the request (HTTP `202`). Delivery is asynchronous; read it with `ray.sends.get()` or subscribe to [delivery webhooks](#delivery-webhooks).

Keep the API key on the server. Never ship it to browsers or mobile apps.

## Sending

`ray.send(body, options?)` calls `POST /send` and returns `{ sendId }`. A request uses exactly one of four modes, and every channel delivery uses exactly one content source: `templateId` (a published template) or inline `content`. The `SendBody` type rejects invalid combinations at compile time.

### Single recipient, with a template

```ts
const { sendId } = await ray.send(
  {
    channelConfigId: '9f1c2a7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
    templateId: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
    params: { name: 'Ada', code: '482913' },
    recipient: { email: 'ada@example.com', name: 'Ada Lovelace' },
    externalUserId: 'user_123', // your id for the end user
    showInFeed: true, // also add an entry to user_123's in-app feed
  },
  { idempotencyKey: 'signup-code-user_123-482913' },
);
```

### Single recipient, with inline content

The `content` shape depends on the channel's template kind (see [Channels](#channels)). Here, a push notification:

```ts
await ray.send({
  channelConfigId: '3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d', // fcm_push
  content: { title: 'Order shipped', body: 'Order {{orderId}} is on its way.' },
  logTitle: 'Order shipped', // feed title, inline content only
  logDescription: 'Order {{orderId}} left the warehouse.',
  params: { orderId: 'A-1042' },
  recipient: { deviceToken: 'fcm-device-token-from-your-app' },
  externalUserId: 'user_123',
  showInFeed: true,
});
```

With inline content every top-level `{{variable}}` in `content`, `logTitle` and `logDescription` needs a value in `params`.

### Fan-out (1 to 1000 recipients)

`targets[]` sends the same rendered message to many recipients on one channel in one request (one `sendId`, one rate-limit token).

```ts
const users = [
  { id: 'user_1', email: 'ada@example.com' },
  { id: 'user_2', email: 'grace@example.com' },
];

await ray.send({
  channelConfigId: '9f1c2a7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  templateId: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
  params: { releaseName: 'September update' }, // one params set for everyone
  targets: users.map((u) => ({ recipient: { email: u.email }, externalUserId: u.id })),
  showInFeed: true, // one feed entry per target with an externalUserId
  priority: 'low', // bulk: never delays transactional sends
});
```

One invalid target rejects the whole request with `400`. For per-recipient values (a name, a code) make one send per recipient. For more than 1000 recipients, split into several sends.

### Multi-channel (one person, 1 to 10 channels)

```ts
await ray.send({
  externalUserId: 'user_42',
  params: { feature: 'dark mode' },
  feed: { title: 'New feature is live', description: 'Try dark mode in settings.' },
  deliveries: [
    {
      channelConfigId: '3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d', // push
      content: { title: 'New: {{feature}}', body: 'Open settings to try it.' },
      recipient: { deviceToken: 'fcm-device-token-from-your-app' },
    },
    {
      channelConfigId: '9f1c2a7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b', // email
      templateId: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
      recipient: { email: 'ada@example.com' },
    },
    {
      channelConfigId: '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f', // slack
      content: { text: 'Shipped *{{feature}}* to user_42' },
      params: { feature: 'dark mode (beta)' }, // replaces top-level params for this delivery
      recipient: {},
    },
  ],
});
```

`feed` with `deliveries` creates exactly one feed entry (requires top-level `externalUserId`). Each channel is delivered and retried independently.

### Feed-only (in-app notification, no channel)

```ts
await ray.send({
  externalUserId: 'user_42',
  feed: { title: 'Your export is ready', description: 'Download it from the Reports page.' },
});
```

### Scheduling

Pass `notBefore` (ISO 8601, offsets allowed) to deliver later. Feed entries become visible at that time too.

```ts
await ray.send({
  channelConfigId: '9f1c2a7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  templateId: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
  recipient: { email: 'ada@example.com' },
  notBefore: '2026-09-15T09:00:00+08:00',
});
```

### Email attachments, cc and bcc

Attachments are base64 inside the email recipient (up to 20 files, about 10 MiB each, about 25 MiB total; `POST /send` accepts bodies up to 45 MiB).

```ts
import { readFile } from 'node:fs/promises';

await ray.send({
  channelConfigId: '9f1c2a7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  content: {
    subject: 'Invoice {{number}}',
    bodyHtml: '<p>Your invoice is attached.</p><img src="cid:logo">',
    bodyText: 'Your invoice is attached.',
  },
  params: { number: 'INV-1042' },
  recipient: {
    email: 'ada@example.com',
    cc: [{ email: 'billing@example.com', name: 'Billing' }],
    bcc: [{ email: 'archive@example.com' }],
    attachments: [
      {
        filename: 'INV-1042.pdf',
        content: (await readFile('INV-1042.pdf')).toString('base64'),
        contentType: 'application/pdf',
      },
      {
        filename: 'logo.png',
        content: (await readFile('logo.png')).toString('base64'),
        contentType: 'image/png',
        disposition: 'inline',
        contentId: 'logo',
      },
    ],
  },
  trackClicks: true, // email only: rewrite links for click stats
  campaignId: 'invoices-2026-09',
});
```

### Other send fields

| Field | Notes |
| --- | --- |
| `priority` | `'high'` (default) or `'low'` for bulk/marketing. |
| `trackClicks` | Email only. Read results with `ray.clicks.get()`. |
| `campaignId` | Groups click stats across sends. |
| `externalUserId` | Your end-user id (1 to 256 chars); needed for feed entries. |
| `showInFeed` / `feed` | Create in-app feed entries. See https://ray.gege.mn/docs/sending#feed-entries. |

## Idempotency

`send()` always sends an `Idempotency-Key` header:

- If you pass `{ idempotencyKey }`, that key is used.
- Otherwise the SDK generates a random UUID for the call and reuses it on every retry of that call, so the SDK's own retries can never deliver twice.

A generated key only protects retries inside one `send()` call. If your own code retries (a queue job that runs again, a process that restarts), pass a key derived from the business event so Ray deduplicates across attempts for 24 hours:

```ts
await ray.send(body, { idempotencyKey: `order-confirmation-${order.id}` });
```

Same key and same body within 24 hours returns the original `{ sendId }` without sending again. Same key with a different body throws `RayError` `409 conflict`. Only `POST /send` supports idempotency keys. Details: https://ray.gege.mn/docs/idempotency

## Delivery status

```ts
const detail = await ray.sends.get(sendId, { limit: 50 });
detail.aggregate; // { total: 3, delivered: 2, suppressed: 1 } (whole send)
detail.rows; // this page of delivery rows, oldest first
detail.nextCursor; // pass as { cursor } for the next page, null on the last page

// Every row of a large fan-out:
for await (const row of ray.sends.listAllRows(sendId)) {
  if (row.status === 'failed_terminal') console.warn(row.recipient, row.providerError);
}
```

Statuses: `pending`, `claimed`, `failed_retryable` (in progress) and `delivered`, `failed_terminal`, `suppressed` (final). Prefer [delivery webhooks](#delivery-webhooks) over polling.

## In-app feed

Feed entries are created by `send()` with `showInFeed` or `feed`. Read them per end user (newest first) from your backend:

```ts
const page = await ray.notifications.list({ externalUserId: 'user_123', limit: 20 });
page.notifications; // [{ id, sendId, logTitle, logDescription, createdAt, ... }]
page.nextCursor;

// Filters: templateId, channelConfigId, after, before (ISO 8601 UTC with Z)
for await (const entry of ray.notifications.listAll({
  externalUserId: 'user_123',
  after: '2026-09-01T00:00:00Z',
})) {
  console.log(entry.logTitle);
}
```

`logTitle` and `logDescription` are not HTML-escaped by Ray. Render them as text.

## Templates

```ts
// Create (and publish) a template
const { id, requiredParams } = await ray.templates.create({
  name: 'welcome-email',
  folder: 'onboarding',
  channelKind: 'email_html',
  content: {
    subject: 'Welcome, {{name}}',
    bodyHtml: '<p>Hi {{name}}</p>',
    bodyText: 'Hi {{name}}',
  },
  logTitle: 'Welcome email sent',
  logDescription: 'Welcomed {{name}}',
  publish: true,
});

const { templates } = await ray.templates.list({ folder: 'onboarding', includeArchived: false });
const template = await ray.templates.get(id); // includes `published` and `draft` versions

// Update the draft (full body; channelKind can't change), then publish it
await ray.templates.update(id, {
  name: 'welcome-email',
  channelKind: 'email_html',
  content: { subject: 'Welcome aboard, {{name}}', bodyHtml: '<p>Hi {{name}}</p>', bodyText: 'Hi {{name}}' },
  logTitle: 'Welcome email sent',
  logDescription: 'Welcomed {{name}}',
});
await ray.templates.publish(id);

// Send the published version once to yourself (no feed entry, no webhooks)
await ray.templates.testSend(id, {
  channelConfigId: '9f1c2a7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  recipient: { email: 'me@example.com' },
  params: { name: 'Test' },
});

await ray.templates.archive(id);
await ray.templates.unarchive(id);
```

Templates use `{{variable}}` placeholders and `{{#section}}...{{/section}}` blocks. See https://ray.gege.mn/docs/templates

## Channels

```ts
const { channels } = await ray.channels.list();
// [{ id, name, kind: 'ses_email', templateKind: 'email_html', recipientSchema: { ...JSON Schema } }]
```

Channels are configured in the dashboard. `channelConfigId` in `send()` is a channel's `id`.

| Channel `kind` | Template kind | `recipient` | Inline `content` |
| --- | --- | --- | --- |
| `ses_email`, `smtp_email` | `email_html` | `{ email, name?, cc?, bcc?, attachments? }` | `{ subject, bodyHtml, bodyText }` |
| `fcm_push` | `fcm_basic` | `{ deviceToken }` or `{ topic }` | `{ title, body, imageUrl?, data? }` |
| `slack_webhook` | `slack_text` | `{}` | `{ text }` |
| `discord_webhook` | `discord_text` | `{}` | `{ content }` |
| `telegram_bot` | `telegram_text` | `{ chatId }` | `{ text, disableLinkPreview? }` |
| `generic_webhook` | `webhook_json` | `{}` | `{ title, body, data? }` |

## Click stats

```ts
const stats = await ray.clicks.get({ sendId }); // or { campaignId: 'invoices-2026-09' }
stats.totalClicks;
stats.byUrl; // [{ url, clicks }]
```

## Delivery webhooks

Ray POSTs to your endpoint when a delivery reaches a final state (Pro plan and above).

```ts
const webhook = await ray.webhooks.create({
  name: 'production',
  url: 'https://api.example.com/webhooks/ray',
  events: ['notification.failed_terminal', 'send.completed'],
});
console.log(webhook.secret); // shown only now: store it as RAY_WEBHOOK_SECRET

const { webhooks } = await ray.webhooks.list();
const one = await ray.webhooks.get(webhook.id); // consecutiveFailures, lastError, ...

await ray.webhooks.update(webhook.id, { events: ['send.completed'], enabled: true });
const { secret } = await ray.webhooks.update(webhook.id, { rotateSecret: true }); // old secret stops working
await ray.webhooks.delete(webhook.id); // archives it
```

Events: `notification.delivered`, `notification.failed_terminal`, `send.completed`. Delivery is at-least-once and unordered: deduplicate on `notification_log_id` (notification events) or `send_id` (`send.completed`). Details: https://ray.gege.mn/docs/webhooks

## Verifying webhooks

Ray signs every delivery webhook with the `X-Ray-Signature` header:

```http
X-Ray-Signature: t=1789378201,v1=5f2b7c1e9a0d4b3c8e6f1a2d7b9c0e4f3a5d8b1c6e2f9a7d0b4c3e8f1a6d2b9c
```

`v1` is the hex HMAC-SHA256 of `"<t>.<raw request body>"` keyed with the webhook secret (UTF-8, not base64-decoded). The SDK verifies it with Web Crypto, so the same code works on every runtime.

```ts
verifyWebhookSignature(options: {
  payload: string | Uint8Array | ArrayBuffer; // the RAW body, exactly as received
  headers: Headers | Record<string, string | string[] | undefined>; // must contain x-ray-signature
  secret: string | string[]; // several secrets are accepted during a rotation
  toleranceSeconds?: number; // default 300; 0 disables the timestamp check
}): Promise<boolean>

parseWebhookEvent(sameOptions): Promise<WebhookEvent> // throws WebhookVerificationError
```

`parseWebhookEvent` verifies and returns the typed event, or throws `WebhookVerificationError` with `reason` = `missing_signature` | `malformed_signature` | `timestamp_out_of_tolerance` | `signature_mismatch` | `invalid_payload`.

Always verify the raw body. Parsing and re-serializing JSON changes the bytes and breaks the signature.

### Next.js (App Router route handler)

```ts
// app/api/webhooks/ray/route.ts
import { parseWebhookEvent, WebhookVerificationError } from '@gege-mn/ray';

export async function POST(request: Request) {
  let event;
  try {
    event = await parseWebhookEvent({
      payload: await request.text(),
      headers: request.headers,
      secret: process.env.RAY_WEBHOOK_SECRET!,
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return new Response(`invalid signature: ${err.reason}`, { status: 400 });
    }
    throw err;
  }

  switch (event.event) {
    case 'notification.failed_terminal':
      await markDeliveryFailed(event.notification_log_id, event.provider_error); // your code, idempotent
      break;
    case 'send.completed':
      await recordSendTotals(event.send_id, event.totals); // your code, idempotent
      break;
  }
  return new Response(null, { status: 204 });
}
```

### Express

```ts
import express from 'express';
import { verifyWebhookSignature, type WebhookEvent } from '@gege-mn/ray';

const app = express();

// Keep the body raw for this route (register before any app-wide express.json()).
app.post('/webhooks/ray', express.raw({ type: 'application/json' }), async (req, res) => {
  const ok = await verifyWebhookSignature({
    payload: req.body, // Buffer
    headers: req.headers,
    secret: process.env.RAY_WEBHOOK_SECRET!,
  });
  if (!ok) return res.status(400).send('invalid signature');

  const event = JSON.parse(req.body.toString('utf8')) as WebhookEvent;
  res.status(204).end(); // acknowledge within 10 seconds
  void handleRayEvent(event); // then process
});
```

### Cloudflare Workers

```ts
import { parseWebhookEvent } from '@gege-mn/ray';

export default {
  async fetch(request: Request, env: { RAY_WEBHOOK_SECRET: string }): Promise<Response> {
    const event = await parseWebhookEvent({
      payload: await request.text(),
      headers: request.headers,
      secret: env.RAY_WEBHOOK_SECRET,
    }).catch(() => null);
    if (!event) return new Response('invalid signature', { status: 400 });

    if (event.event === 'send.completed') {
      console.log(event.send_id, event.totals);
    }
    return new Response(null, { status: 204 });
  },
};
```

### Testing your handler

`signWebhookPayload` produces a header exactly like Ray's:

```ts
import { signWebhookPayload } from '@gege-mn/ray';

const body = JSON.stringify({ event: 'send.completed', send_id: 's_1' /* ... */ });
const signature = await signWebhookPayload({ payload: body, secret: 'test-secret' });
await fetch('http://localhost:3000/api/webhooks/ray', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ray-signature': signature },
  body,
});
```

### The `generic_webhook` channel

Notifications sent through an HTTPS webhook *channel* use a different signature: `X-Ray-Timestamp: <ISO 8601>` and `X-Ray-Signature: sha256=<hex HMAC-SHA256 of "<X-Ray-Timestamp>.<raw body>">`. Use `verifyChannelWebhookSignature` (same options, returns `Promise<boolean>`) or `parseChannelWebhook` (returns `{ id, title, body, data?, sentAt }`):

```ts
import { parseChannelWebhook } from '@gege-mn/ray';

const envelope = await parseChannelWebhook({
  payload: await request.text(),
  headers: request.headers,
  secret: process.env.RAY_CHANNEL_WEBHOOK_SECRET!,
});
// Deduplicate on envelope.id (the same on every retry).
```

## Errors

Every failed call throws a `RayError`:

| Property | Meaning |
| --- | --- |
| `status` | HTTP status. `0` when no response arrived (`connection_error`, `timeout`). |
| `code` | Stable machine-readable code from the API's `error` field. Branch on this. |
| `message` | Human-readable detail from the API. Don't parse it. |
| `requestId` | The `x-request-id` response header, for support requests. |
| `retryAfter` | Seconds to wait (429). |
| `body` | Parsed error body (a `402` carries `limit` and `used`). |
| `headers` | Response headers. |

```ts
import { RayError } from '@gege-mn/ray';

try {
  await ray.send(body, { idempotencyKey: `welcome-${user.id}` });
} catch (err) {
  if (!(err instanceof RayError)) throw err;
  switch (err.code) {
    case 'validation_error': // 400: fix the request (bad recipient, missing params, write scope...)
    case 'not_found': // 404: wrong channelConfigId/templateId, or template not published
      console.error(err.status, err.code, err.message, err.requestId);
      throw err;
    case 'quota_exceeded': // 402: Free plan monthly quota reached
      break;
    case 'rate_limit_exceeded': // 429: already retried by the SDK; err.retryAfter seconds
    case 'internal_server_error': // 5xx: already retried by the SDK
    case 'connection_error':
    case 'timeout':
      // re-enqueue the job; reuse the same idempotencyKey
      break;
  }
}
```

| Status | `code` |
| --- | --- |
| 400 | `validation_error` |
| 401 | `unauthorized` |
| 402 | `quota_exceeded` |
| 403 | `forbidden` (plan lacks the feature, e.g. delivery webhooks) |
| 404 | `not_found` |
| 409 | `conflict` (idempotency key reuse, duplicate template name) |
| 413 | `payload_too_large` |
| 429 | `rate_limit_exceeded` |
| 500 | `internal_server_error` |

A `202` from `send()` is not a delivery. Provider failures appear later on delivery rows and in webhooks. Full list: https://ray.gege.mn/docs/errors

## Retries, timeouts and configuration

```ts
const ray = new Ray('ck_live_...', {
  baseUrl: 'https://ray-api.gege.mn', // default (or RAY_BASE_URL)
  timeoutMs: 30_000, // per attempt, default 30s; 0 disables
  maxRetries: 2, // default 2
  fetch: customFetch, // default: global fetch
  userAgent: 'my-app/1.0', // prepended to "ray-node/<version>"
});

// Also accepted: new Ray({ apiKey, ...options })

// Per call:
await ray.channels.list({ timeoutMs: 5_000, maxRetries: 0, signal: AbortSignal.timeout(10_000), headers: {} });
```

The API key defaults to `process.env.RAY_API_KEY`. The constructor throws `RayError` (`code: 'missing_api_key'`) when neither is set.

Retry rules (exponential backoff 0.5s, 1s, 2s, 4s, 8s max, with up to 25% jitter; `Retry-After` is honored when present, and a requested wait over 60s is not retried):

| Call | Retried on |
| --- | --- |
| `GET` requests (`sends.get`, `notifications.list`, `templates.list`, `me`, ...) | Network errors, timeouts, `429`, `5xx` |
| `send()` (always has an `Idempotency-Key`) | Network errors, timeouts, `429`, `5xx`, and `409` "request with this Idempotency-Key is already in progress" |
| Every other write (`templates.create/update/publish/archive/unarchive/testSend`, `webhooks.create/update/delete`) | `429` only |

Why writes other than `send()` are conservative: Ray has no idempotency keys for them, and a network error or `5xx` doesn't tell you whether the change happened (a retried `testSend` sends twice, a retried `rotateSecret` loses the first new secret). A `429` is safe to retry because Ray's rate limiter rejects the request before it runs. Handle other failures of those calls yourself.

Aborting `signal` cancels the in-flight request and any pending retry, and rejects with the signal's reason.

## Account and usage

```ts
const me = await ray.me(); // { tenantId, apiKeyId, scopes: ['read', 'write'] }
const usage = await ray.usage();
// { plan: 'starter', subscription: {...} | null, usage: { monthlyQuota, used, remaining } }
```

## TypeScript

All request and response types are exported:

```ts
import type {
  SendBody, // SingleSendBody | FanOutSendBody | MultiChannelSendBody | FeedOnlySendBody
  SendAccepted,
  SendDetail,
  SendRow,
  DeliveryStatus,
  Recipient, // EmailRecipient | FcmRecipient | TelegramRecipient | EmptyRecipient
  TemplateContent, // EmailHtmlContent | FcmContent | SlackContent | DiscordContent | TelegramContent | WebhookJsonContent
  Template,
  TemplateDetail,
  TemplateUpsertBody,
  FeedNotification,
  Channel,
  Webhook,
  WebhookEvent, // NotificationWebhookEvent | SendCompletedWebhookEvent
  RequestOptions,
  paths, // raw OpenAPI-generated types
  components,
} from '@gege-mn/ray';
```

Response types are generated from Ray's OpenAPI spec (`pnpm generate`); request types are hand-written to match the API's validation.

## For AI agents

- Docs index for LLMs: https://ray.gege.mn/llms.txt (all docs in one file: https://ray.gege.mn/llms-full.txt; every page as markdown at `https://ray.gege.mn/docs/<slug>.md`)
- OpenAPI 3.1: https://ray-api.gege.mn/openapi.json
- Hosted MCP server: `https://ray-api.gege.mn/mcp` (Streamable HTTP, `Authorization: Bearer <RAY_API_KEY>`), e.g. `claude mcp add --transport http ray https://ray-api.gege.mn/mcp --header "Authorization: Bearer $RAY_API_KEY"`
- Local MCP bridge: `npx -y @gege-mn/ray-mcp` (https://github.com/gege-mn/ray-mcp)
- Agent skills: `npx skills add gege-mn/ray-skills` (https://github.com/gege-mn/ray-skills)

Integration checklist: call `ray.channels.list()` to get `channelConfigId` and the recipient shape, send with `ray.send()` (pass a business-derived `idempotencyKey`), check results with `ray.sends.get()` or delivery webhooks verified by `parseWebhookEvent`, and branch on `RayError.code`.

## License

[MIT](./LICENSE) © gege.mn
