import { encodePath, type HttpClient, type RequestOptions } from '../core';
import type {
  SendAccepted,
  TemplateArchived,
  TemplateCreated,
  TemplateDetail,
  TemplateDraft,
  TemplateList,
  TemplateListQuery,
  TemplatePublished,
  TemplateUpsertBody,
  TestSendBody,
} from '../types';

export class Templates {
  constructor(private readonly http: HttpClient) {}

  /** `GET /templates`. */
  list(query: TemplateListQuery = {}, options?: RequestOptions): Promise<TemplateList> {
    return this.http.request<TemplateList>({
      method: 'GET',
      path: '/templates',
      query: { folder: query.folder, includeArchived: query.includeArchived },
      retry: 'read',
      options,
    });
  }

  /** `GET /templates/{id}`: metadata plus the published and draft versions. */
  get(templateId: string, options?: RequestOptions): Promise<TemplateDetail> {
    return this.http.request<TemplateDetail>({
      method: 'GET',
      path: `/templates/${encodePath(templateId)}`,
      retry: 'read',
      options,
    });
  }

  /** `POST /templates` (`write` scope). Pass `publish: true` to publish immediately. */
  create(body: TemplateUpsertBody, options?: RequestOptions): Promise<TemplateCreated> {
    return this.http.request<TemplateCreated>({
      method: 'POST',
      path: '/templates',
      body,
      retry: 'write',
      options,
    });
  }

  /**
   * `PATCH /templates/{id}` (`write` scope): replaces the draft. Takes the full
   * body; `channelKind` must match the template's.
   */
  update(
    templateId: string,
    body: TemplateUpsertBody,
    options?: RequestOptions,
  ): Promise<TemplateDraft> {
    return this.http.request<TemplateDraft>({
      method: 'PATCH',
      path: `/templates/${encodePath(templateId)}`,
      body,
      retry: 'write',
      options,
    });
  }

  /** `POST /templates/{id}/publish`: publishes the current draft. */
  publish(templateId: string, options?: RequestOptions): Promise<TemplatePublished> {
    return this.http.request<TemplatePublished>({
      method: 'POST',
      path: `/templates/${encodePath(templateId)}/publish`,
      retry: 'write',
      options,
    });
  }

  /** `POST /templates/{id}/archive`. */
  archive(templateId: string, options?: RequestOptions): Promise<TemplateArchived> {
    return this.http.request<TemplateArchived>({
      method: 'POST',
      path: `/templates/${encodePath(templateId)}/archive`,
      retry: 'write',
      options,
    });
  }

  /** `POST /templates/{id}/unarchive`. */
  unarchive(templateId: string, options?: RequestOptions): Promise<TemplateArchived> {
    return this.http.request<TemplateArchived>({
      method: 'POST',
      path: `/templates/${encodePath(templateId)}/unarchive`,
      retry: 'write',
      options,
    });
  }

  /**
   * `POST /templates/{id}/test-send`: sends the published version once. No
   * feed entry, no delivery webhooks, doesn't count toward the monthly quota
   * (separate daily allowance). Not idempotent, so never retried after it
   * may have reached the server.
   */
  testSend(
    templateId: string,
    body: TestSendBody,
    options?: RequestOptions,
  ): Promise<SendAccepted> {
    return this.http.request<SendAccepted>({
      method: 'POST',
      path: `/templates/${encodePath(templateId)}/test-send`,
      body,
      retry: 'write',
      options,
    });
  }
}
