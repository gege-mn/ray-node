import type { HttpClient, RequestOptions } from '../core';
import type { ChannelList } from '../types';

export class Channels {
  constructor(private readonly http: HttpClient) {}

  /**
   * `GET /channels`: channel configs in the workspace, each with its `kind`,
   * the `templateKind` it accepts and the JSON Schema of its `recipient`.
   */
  list(options?: RequestOptions): Promise<ChannelList> {
    return this.http.request<ChannelList>({
      method: 'GET',
      path: '/channels',
      retry: 'read',
      options,
    });
  }
}
