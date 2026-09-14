import { encodePath, type HttpClient, type RequestOptions } from '../core';
import type {
  Webhook,
  WebhookArchived,
  WebhookCreateBody,
  WebhookList,
  WebhookListQuery,
  WebhookUpdateBody,
  WebhookUpdated,
  WebhookWithSecret,
} from '../types';

/** Delivery webhook subscriptions (`/tenant-webhooks`). Pro plan and above. */
export class Webhooks {
  constructor(private readonly http: HttpClient) {}

  /** `GET /tenant-webhooks`. */
  list(query: WebhookListQuery = {}, options?: RequestOptions): Promise<WebhookList> {
    return this.http.request<WebhookList>({
      method: 'GET',
      path: '/tenant-webhooks',
      query: { includeArchived: query.includeArchived },
      retry: 'read',
      options,
    });
  }

  /** `GET /tenant-webhooks/{id}`. */
  get(webhookId: string, options?: RequestOptions): Promise<Webhook> {
    return this.http.request<Webhook>({
      method: 'GET',
      path: `/tenant-webhooks/${encodePath(webhookId)}`,
      retry: 'read',
      options,
    });
  }

  /** `POST /tenant-webhooks`. The response's `secret` is shown only once: store it. */
  create(body: WebhookCreateBody, options?: RequestOptions): Promise<WebhookWithSecret> {
    return this.http.request<WebhookWithSecret>({
      method: 'POST',
      path: '/tenant-webhooks',
      body,
      retry: 'write',
      options,
    });
  }

  /** `PATCH /tenant-webhooks/{id}`. With `rotateSecret: true` the response includes the new `secret`. */
  update(
    webhookId: string,
    body: WebhookUpdateBody,
    options?: RequestOptions,
  ): Promise<WebhookUpdated> {
    return this.http.request<WebhookUpdated>({
      method: 'PATCH',
      path: `/tenant-webhooks/${encodePath(webhookId)}`,
      body,
      retry: 'write',
      options,
    });
  }

  /** `DELETE /tenant-webhooks/{id}`: archives the webhook. */
  delete(webhookId: string, options?: RequestOptions): Promise<WebhookArchived> {
    return this.http.request<WebhookArchived>({
      method: 'DELETE',
      path: `/tenant-webhooks/${encodePath(webhookId)}`,
      retry: 'write',
      options,
    });
  }
}
