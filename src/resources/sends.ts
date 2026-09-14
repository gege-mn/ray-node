import { encodePath, type HttpClient, type RequestOptions } from '../core';
import type { SendDetail, SendDetailQuery, SendRow } from '../types';

export class Sends {
  constructor(private readonly http: HttpClient) {}

  /**
   * `GET /sends/{id}`: status counts for the whole send plus one page of
   * delivery rows (oldest first). Follow `nextCursor`, or use `listAllRows`.
   */
  get(sendId: string, query: SendDetailQuery = {}, options?: RequestOptions): Promise<SendDetail> {
    return this.http.request<SendDetail>({
      method: 'GET',
      path: `/sends/${encodePath(sendId)}`,
      query: { cursor: query.cursor, limit: query.limit },
      retry: 'read',
      options,
    });
  }

  /**
   * Iterates every delivery row of a send, fetching pages as needed.
   *
   * @example
   * for await (const row of ray.sends.listAllRows(sendId)) console.log(row.status);
   */
  async *listAllRows(
    sendId: string,
    query: Omit<SendDetailQuery, 'cursor'> = {},
    options?: RequestOptions,
  ): AsyncGenerator<SendRow, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.get(sendId, { limit: query.limit ?? 200, cursor }, options);
      yield* page.rows;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}
