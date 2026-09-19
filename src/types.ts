/**
 * Public types. Response shapes come from the generated OpenAPI types
 * (`src/generated/openapi.ts`); request bodies and a few response fields the
 * spec leaves as `unknown` / `string` are narrowed by hand to match the Ray
 * API's actual validation code.
 */
import type { components } from './generated/openapi';

type Schemas = components['schemas'];

export type { components, paths } from './generated/openapi';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Values for `{{variables}}` in templates and inline content. */
export type Params = Record<string, JsonValue>;

/** Channel types (`GET /channels` → `kind`). */
export type ChannelType =
  | 'ses_email'
  | 'smtp_email'
  | 'fcm_push'
  | 'slack_webhook'
  | 'discord_webhook'
  | 'telegram_bot'
  | 'twilio_sms'
  | 'sendsms_mn'
  | 'generic_webhook';

/** Template kinds. Each channel type accepts exactly one (`twilio_sms` and `sendsms_mn` share `sms_text`). */
export type TemplateKind =
  | 'email_html'
  | 'fcm_basic'
  | 'slack_text'
  | 'discord_text'
  | 'telegram_text'
  | 'sms_text'
  | 'webhook_json';

/** Open variants for response fields, so a new server-side value doesn't break type narrowing. */
type Open<T extends string> = T | (string & {});

// ---------------------------------------------------------------------------
// Recipients (per channel)
// ---------------------------------------------------------------------------

export interface EmailAddress {
  email: string;
  /** Display name, 1 to 255 characters, no line breaks. */
  name?: string;
}

export interface EmailAttachment {
  /** 1 to 255 characters, no line breaks. */
  filename: string;
  /** Base64-encoded file contents (about 10 MiB decoded per file, 25 MiB total). */
  content: string;
  contentType?: string;
  /** Defaults to `attachment`. Use `inline` with `contentId` for `cid:` images. */
  disposition?: 'attachment' | 'inline';
  contentId?: string;
}

/** Recipient for `ses_email` and `smtp_email` channels. */
export interface EmailRecipient extends EmailAddress {
  /** Up to 50. */
  cc?: EmailAddress[];
  /** Up to 50. */
  bcc?: EmailAddress[];
  /** Up to 20. */
  attachments?: EmailAttachment[];
}

/**
 * Recipient for `fcm_push`: exactly one of `deviceToken` or `topic`. Ray keeps
 * no device registry, so pass the FCM token on every send.
 */
export type FcmRecipient =
  | { deviceToken: string; topic?: never }
  | { topic: string; deviceToken?: never };

/** Recipient for `telegram_bot`. */
export interface TelegramRecipient {
  chatId: string;
}

/**
 * Recipient for `twilio_sms`: an international E.164 number such as
 * `+97699112233`. Spaces, dashes, dots and parentheses are removed and a
 * leading `00` is read as `+`; a number without a country code is a `400`.
 */
export interface TwilioSmsRecipient {
  phoneNumber: string;
}

/**
 * Recipient for `sendsms_mn`: a Mongolian 8-digit number such as `99112233`
 * (spaces, dashes and a `+976` prefix are removed; any other length is a `400`).
 */
export interface SendsmsMnRecipient {
  phoneNumber: string;
}

/** Recipient for `slack_webhook`, `discord_webhook` and `generic_webhook` (the destination lives in the channel config). */
export type EmptyRecipient = Record<string, never>;

export type Recipient =
  | EmailRecipient
  | FcmRecipient
  | TelegramRecipient
  | TwilioSmsRecipient
  | SendsmsMnRecipient
  | EmptyRecipient;

/** Maps a channel type to its recipient shape. */
export interface RecipientByChannel {
  ses_email: EmailRecipient;
  smtp_email: EmailRecipient;
  fcm_push: FcmRecipient;
  telegram_bot: TelegramRecipient;
  twilio_sms: TwilioSmsRecipient;
  sendsms_mn: SendsmsMnRecipient;
  slack_webhook: EmptyRecipient;
  discord_webhook: EmptyRecipient;
  generic_webhook: EmptyRecipient;
}

// ---------------------------------------------------------------------------
// Content (per template kind)
// ---------------------------------------------------------------------------

/** `email_html`: raw email content. Designed-mode (visual editor) content is dashboard-only. */
export interface EmailHtmlContent {
  /** 1 to 998 characters, no line breaks after rendering. */
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

/** `fcm_basic`: push notification. */
export interface FcmContent {
  /** 1 to 200 characters. */
  title: string;
  /** 1 to 2000 characters. */
  body: string;
  imageUrl?: string;
  data?: Record<string, string>;
}

/** `slack_text`. */
export interface SlackContent {
  /** 1 to 40,000 characters (Slack mrkdwn). */
  text: string;
}

/** `discord_text`. */
export interface DiscordContent {
  /** 1 to 2000 characters. */
  content: string;
}

/** `telegram_text`. */
export interface TelegramContent {
  /** 1 to 4096 characters. */
  text: string;
  disableLinkPreview?: boolean;
}

/**
 * `sms_text`, for `twilio_sms` and `sendsms_mn`. Plain text: no markup, param
 * values are inserted verbatim. Length is checked after params are rendered
 * (`400` from `send()` / `testSend()` when exceeded): Twilio allows 1600
 * characters; sendsms.mn sends one SMS, so at most 159 characters of GSM-7
 * text (plain Latin), or 69 once the text has any other character, such as
 * Cyrillic.
 */
export interface SmsTextContent {
  /** 1 to 1600 characters. */
  text: string;
}

/** `webhook_json`: the envelope your endpoint receives is `{ id, title, body, data?, sentAt }`. */
export interface WebhookJsonContent {
  /** 1 to 200 characters. */
  title: string;
  /** 1 to 4000 characters. */
  body: string;
  data?: Record<string, string>;
}

export type TemplateContent =
  | EmailHtmlContent
  | FcmContent
  | SlackContent
  | DiscordContent
  | TelegramContent
  | SmsTextContent
  | WebhookJsonContent;

/** Maps a template kind to its content shape. */
export interface ContentByTemplateKind {
  email_html: EmailHtmlContent;
  fcm_basic: FcmContent;
  slack_text: SlackContent;
  discord_text: DiscordContent;
  telegram_text: TelegramContent;
  sms_text: SmsTextContent;
  webhook_json: WebhookJsonContent;
}

// ---------------------------------------------------------------------------
// POST /send
// ---------------------------------------------------------------------------

/** Render a published template. */
export interface TemplateSource {
  templateId: string;
  content?: never;
  logTitle?: never;
  logDescription?: never;
}

/** Render inline, channel-shaped content. */
export interface InlineContentSource {
  content: TemplateContent;
  templateId?: never;
  /** Feed title template (max 500). Inline content only. */
  logTitle?: string;
  /** Feed description template (max 2000). Inline content only. */
  logDescription?: string;
}

export type ContentSource = TemplateSource | InlineContentSource;

export interface FeedEntry {
  /** Max 500. Required for feed-only sends. */
  title?: string;
  /** Max 2000. */
  description?: string;
}

interface SendOptionsFields {
  /** ISO 8601 datetime; offsets allowed. Delivery (and feed visibility) waits until then. */
  notBefore?: string;
  /** `high` (default) for transactional; `low` for bulk so it never delays transactional sends. */
  priority?: 'high' | 'low';
  /** Email only. Rewrite links through Ray for click tracking. */
  trackClicks?: boolean;
  /** 1 to 256. Groups click stats across sends. */
  campaignId?: string;
}

export interface SendTarget {
  recipient: Recipient;
  /** 1 to 256. Your id for this end user. */
  externalUserId?: string;
}

/** One recipient on one channel. */
export type SingleSendBody = ContentSource &
  SendOptionsFields & {
    channelConfigId: string;
    recipient: Recipient;
    targets?: never;
    deliveries?: never;
    params?: Params;
    /** 1 to 256. Stored on the delivery row; needed for feed entries. */
    externalUserId?: string;
    /** Create a feed entry (requires `externalUserId`). */
    showInFeed?: boolean;
    feed?: FeedEntry;
  };

/** The same message to 1 to 1000 recipients on one channel. */
export type FanOutSendBody = ContentSource &
  SendOptionsFields & {
    channelConfigId: string;
    targets: SendTarget[];
    recipient?: never;
    deliveries?: never;
    params?: Params;
    externalUserId?: string;
    /** One feed entry per target that has its own `externalUserId`. */
    showInFeed?: boolean;
    feed?: FeedEntry;
  };

/** One entry of a multi-channel send. */
export type Delivery = ContentSource & {
  channelConfigId: string;
  recipient: Recipient;
  /** Replaces (does not merge with) the top-level `params`. */
  params?: Params;
};

/** One logical notification to one person over 1 to 10 channels. */
export type MultiChannelSendBody = SendOptionsFields & {
  deliveries: Delivery[];
  /** Required when `feed` is set. */
  externalUserId?: string;
  params?: Params;
  /** Creates exactly one feed entry for `externalUserId`. */
  feed?: FeedEntry;
  channelConfigId?: never;
  templateId?: never;
  content?: never;
  recipient?: never;
  targets?: never;
  logTitle?: never;
  logDescription?: never;
  showInFeed?: never;
};

/** An in-app feed entry with no channel delivery. */
export interface FeedOnlySendBody {
  feed: FeedEntry & { title: string };
  externalUserId: string;
  notBefore?: string;
  channelConfigId?: never;
  deliveries?: never;
  templateId?: never;
  content?: never;
  recipient?: never;
  targets?: never;
  showInFeed?: never;
}

/** Body of `POST /send`: exactly one of the four request modes. */
export type SendBody = SingleSendBody | FanOutSendBody | MultiChannelSendBody | FeedOnlySendBody;

/** `202` response of `POST /send` and `POST /templates/{id}/test-send`. */
export type SendAccepted = Schemas['SendAccepted'];

// ---------------------------------------------------------------------------
// GET /sends/{id}
// ---------------------------------------------------------------------------

export type DeliveryStatus =
  | 'pending'
  | 'claimed'
  | 'failed_retryable'
  | 'delivered'
  | 'failed_terminal'
  | 'suppressed';

/** One delivery row of a send. */
export interface SendRow {
  id: string;
  channelConfigId: string;
  /** `null` for inline content. */
  templateId: string | null;
  templateVersionId: string | null;
  externalUserId: string | null;
  showInFeed: boolean;
  /** The recipient as sent (attachments listed without contents; `{ redacted: true }` after 30 days). */
  recipient: Record<string, unknown>;
  logTitle: string;
  logDescription: string;
  status: Open<DeliveryStatus>;
  providerMessageId: string | null;
  /** `{ name, message }` for provider errors, `{ reason, details }` for pipeline failures. */
  providerError: Record<string, unknown> | null;
  isTest: boolean;
  notBefore: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
}

export interface SendDetail extends Omit<Schemas['SendDetail'], 'aggregate' | 'rows'> {
  /** Row counts by status over the whole send. A status key appears only when non-zero. */
  aggregate: { total: number } & Partial<Record<DeliveryStatus, number>>;
  rows: SendRow[];
}

export interface SendDetailQuery {
  /** `nextCursor` from the previous page. */
  cursor?: string;
  /** Rows per page, 1 to 200 (default 50). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Channels, identity, usage
// ---------------------------------------------------------------------------

export type Channel = Omit<Schemas['ChannelList']['channels'][number], 'kind' | 'templateKind'> & {
  kind: Open<ChannelType>;
  templateKind: Open<TemplateKind>;
};

export interface ChannelList {
  channels: Channel[];
}

/** `GET /me`: the API key's workspace and scopes. */
export type Me = Omit<Schemas['Me'], 'scopes'> & { scopes: Open<'read' | 'write'>[] };

/** `GET /billing/subscription`. */
export interface Usage {
  /** Internal plan key: `free`, `starter`, `growth` (Pro) or `business` (Scale). */
  plan: Open<'free' | 'starter' | 'growth' | 'business'>;
  subscription: {
    provider: Open<'polar' | 'qpay'>;
    plan: string;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  usage: {
    /** `null` when the plan has no quota. */
    monthlyQuota: number | null;
    used: number | null;
    remaining: number | null;
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type Template = Omit<
  Schemas['TemplateList']['templates'][number],
  'channelKind' | 'sourceMode'
> & {
  channelKind: Open<TemplateKind>;
  sourceMode: Open<'raw' | 'designed'>;
};

export interface TemplateList {
  templates: Template[];
}

export interface TemplateListQuery {
  folder?: string;
  includeArchived?: boolean;
}

type DetailSchema = Schemas['TemplateDetail'];

export type TemplateDetail = Omit<DetailSchema, 'channelKind' | 'sourceMode'> & {
  channelKind: Open<TemplateKind>;
  sourceMode: Open<'raw' | 'designed'>;
};

export type TemplateVersion = NonNullable<DetailSchema['published']>;
export type TemplateDraftVersion = NonNullable<DetailSchema['draft']>;

export interface ParamOverride {
  /** Mark a `{{variable}}` optional so sends without it don't fail. */
  optional?: boolean;
  description?: string;
}

/**
 * Body of `POST /templates` and `PATCH /templates/{id}`. `PATCH` takes the
 * full body too (it replaces the draft) and `channelKind` cannot change.
 */
export type TemplateUpsertBody = {
  [K in TemplateKind]: {
    /** 1 to 100, unique in the workspace. */
    name: string;
    /** Max 200. */
    folder?: string;
    channelKind: K;
    content: ContentByTemplateKind[K];
    /** Feed title template, 1 to 500. */
    logTitle: string;
    /** Feed description template, 1 to 2000. */
    logDescription: string;
    paramOverrides?: Record<string, ParamOverride>;
    /** Publish immediately. */
    publish?: boolean;
  };
}[TemplateKind];

export type TemplateCreated = Schemas['TemplateCreated'];
export type TemplateDraft = Schemas['TemplateDraft'];
export type TemplatePublished = Schemas['TemplatePublished'];
export type TemplateArchived = Schemas['TemplateArchived'];

export interface TestSendBody {
  channelConfigId: string;
  recipient: Recipient;
  params?: Params;
}

// ---------------------------------------------------------------------------
// Feed (GET /notifications) and clicks
// ---------------------------------------------------------------------------

export type FeedNotification = Omit<
  Schemas['Notifications']['notifications'][number],
  'status' | 'providerMessageId' | 'dispatchedAt'
> & {
  /** Always `delivered`. */
  status: 'delivered';
  /** Always `null` (kept for compatibility). */
  providerMessageId: null;
  /** Always `null` (kept for compatibility). */
  dispatchedAt: null;
};

export interface NotificationList {
  notifications: FeedNotification[];
  nextCursor: string | null;
}

export interface NotificationListQuery {
  /** Your end user's id (1 to 256). Required. */
  externalUserId: string;
  /** 1 to 200 (default 50). */
  limit?: number;
  cursor?: string;
  templateId?: string;
  channelConfigId?: string;
  /** Inclusive lower bound on `createdAt`, ISO 8601 UTC with `Z`. */
  after?: string;
  /** Inclusive upper bound on `createdAt`, ISO 8601 UTC with `Z`. */
  before?: string;
}

export type ClickStats = Schemas['ClickStats'];

/** At least one of `sendId` or `campaignId`. */
export type ClickStatsQuery =
  | { sendId: string; campaignId?: string }
  | { campaignId: string; sendId?: string };

// ---------------------------------------------------------------------------
// Delivery webhooks
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | 'notification.delivered'
  | 'notification.failed_terminal'
  | 'send.completed';

export type Webhook = Omit<Schemas['Webhook'], 'events'> & { events: Open<WebhookEventType>[] };
export type WebhookWithSecret = Webhook & { secret: string };

export interface WebhookList {
  webhooks: Webhook[];
}

export interface WebhookListQuery {
  includeArchived?: boolean;
}

export interface WebhookCreateBody {
  /** 1 to 100. */
  name: string;
  /** Public `https` URL. */
  url: string;
  events: WebhookEventType[];
}

/** At least one field. `rotateSecret: true` returns the new `secret`. */
export interface WebhookUpdateBody {
  name?: string;
  url?: string;
  events?: WebhookEventType[];
  enabled?: boolean;
  rotateSecret?: boolean;
}

/** `PATCH /tenant-webhooks/{id}`; `secret` is present only when rotated. */
export type WebhookUpdated = Webhook & { secret?: string };

export type WebhookArchived = Schemas['WebhookArchived'];

/** `notification.delivered` / `notification.failed_terminal` payload. */
export interface NotificationWebhookEvent {
  event: 'notification.delivered' | 'notification.failed_terminal';
  occurred_at: string;
  send_id: string;
  /** Stable per delivery row; deduplicate on it. */
  notification_log_id: string;
  channel_config_id: string;
  template_id: string | null;
  external_user_id: string | null;
  provider_message_id: string | null;
  provider_error: Record<string, unknown> | null;
  is_test: boolean;
}

/** `send.completed` payload. */
export interface SendCompletedWebhookEvent {
  event: 'send.completed';
  occurred_at: string;
  send_id: string;
  /** `null` for multi-channel and feed-only sends. */
  channel_config_id: string | null;
  channel_config_ids: string[];
  template_id: string | null;
  recipient_count: number;
  totals: { total: number; delivered: number; failed_terminal: number; suppressed: number };
}

/** Body Ray POSTs to a delivery webhook endpoint. */
export type WebhookEvent = NotificationWebhookEvent | SendCompletedWebhookEvent;

/** Body the `generic_webhook` channel POSTs to its configured URL. */
export interface ChannelWebhookEnvelope {
  /** Delivery row id; the same on every retry. */
  id: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sentAt: string;
}
