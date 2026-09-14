import type { HttpClient, RequestOptions } from '../core';
import type { FeedNotification, NotificationList, NotificationListQuery } from '../types';

export class Notifications {
  constructor(private readonly http: HttpClient) {}

  /** `GET /notifications`: one page of an end user's in-app feed, newest first. */
  list(query: NotificationListQuery, options?: RequestOptions): Promise<NotificationList> {
    return this.http.request<NotificationList>({
      method: 'GET',
      path: '/notifications',
      query: {
        externalUserId: query.externalUserId,
        limit: query.limit,
        cursor: query.cursor,
        templateId: query.templateId,
        channelConfigId: query.channelConfigId,
        after: query.after,
        before: query.before,
      },
      retry: 'read',
      options,
    });
  }

  /**
   * Iterates the whole feed (newest first), fetching pages as needed. `limit`
   * is the page size.
   *
   * @example
   * for await (const n of ray.notifications.listAll({ externalUserId: 'user_123' })) { ... }
   */
  async *listAll(
    query: NotificationListQuery,
    options?: RequestOptions,
  ): AsyncGenerator<FeedNotification, void, undefined> {
    let cursor = query.cursor;
    do {
      const page = await this.list({ ...query, limit: query.limit ?? 200, cursor }, options);
      yield* page.notifications;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}
