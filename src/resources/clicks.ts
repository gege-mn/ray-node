import type { HttpClient, RequestOptions } from '../core';
import type { ClickStats, ClickStatsQuery } from '../types';

export class Clicks {
  constructor(private readonly http: HttpClient) {}

  /** `GET /clicks`: email link clicks for a send and/or campaign, grouped by URL. */
  get(query: ClickStatsQuery, options?: RequestOptions): Promise<ClickStats> {
    return this.http.request<ClickStats>({
      method: 'GET',
      path: '/clicks',
      query: { sendId: query.sendId, campaignId: query.campaignId },
      retry: 'read',
      options,
    });
  }
}
