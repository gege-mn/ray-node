# Changelog

All notable changes to `@gege-mn/ray` are documented here. This project follows [Semantic Versioning](https://semver.org/).

## 0.2.0 (2026-10-25)

- SMS channels: `twilio_sms` and `sendsms_mn` channel types, the `sms_text` template kind, `TwilioSmsRecipient`, `SendsmsMnRecipient` and `SmsTextContent`.
- `EmailRecipient.from` (per-send sender override), `EmailRecipient.replyTo` and `EmailRecipient.headers` (custom headers) for `ses_email` and `smtp_email`.

## 0.1.0 (2026-09-14)

Initial release.

- `Ray` client: `send`, `sends.get` / `sends.listAllRows`, `channels.list`, `templates.{list,get,create,update,publish,archive,unarchive,testSend}`, `notifications.list` / `notifications.listAll`, `clicks.get`, `webhooks.{list,get,create,update,delete}`, `me`, `usage`.
- Automatic `Idempotency-Key` on `send()`.
- Retries with exponential backoff and jitter; honors `Retry-After`.
- `RayError` with `status`, `code`, `message`, `requestId`, `retryAfter`.
- Webhook helpers: `verifyWebhookSignature`, `parseWebhookEvent`, `signWebhookPayload`, `verifyChannelWebhookSignature`, `parseChannelWebhook` (Web Crypto, edge-compatible).
- Types generated from the Ray OpenAPI spec, with hand-written request types per send mode and channel.
- Zero runtime dependencies. ESM + CJS. Node 18+, Bun, Deno, Cloudflare Workers, Vercel Edge.
