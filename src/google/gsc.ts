import { google, searchconsole_v1 } from 'googleapis';
import { createGoogleAuth } from './auth.js';
import type { GscRawRow, ToolConfig } from '../types.js';

/** Compute the analysis window: explicit dates win, else monthsBack (default 3). */
export function dateWindow(config: ToolConfig, today = new Date()): { start: string; end: string } {
  if (config.startDate && config.endDate) {
    return { start: config.startDate, end: config.endDate };
  }
  // GSC data lags ~2 days; end the window 2 days ago.
  const end = new Date(today);
  end.setDate(end.getDate() - 2);
  const start = new Date(end);
  start.setMonth(start.getMonth() - (config.monthsBack || 3));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

export class GscClient {
  private api: searchconsole_v1.Searchconsole;

  constructor() {
    this.api = google.searchconsole({ version: 'v1', auth: createGoogleAuth() as never });
  }

  /**
   * Pull per-query metrics for one page URL. Errors are caught and returned
   * so one failing URL never aborts the run.
   */
  async queriesForUrl(
    config: ToolConfig,
    url: string,
  ): Promise<{ rows: GscRawRow[]; error?: string }> {
    const { start, end } = dateWindow(config);
    const filters: searchconsole_v1.Schema$ApiDimensionFilter[] = [
      { dimension: 'page', operator: 'equals', expression: url },
    ];
    if (config.countryFilter) {
      filters.push({ dimension: 'country', operator: 'equals', expression: config.countryFilter });
    }
    if (config.deviceFilter) {
      filters.push({ dimension: 'device', operator: 'equals', expression: config.deviceFilter });
    }

    try {
      const res = await this.api.searchanalytics.query({
        siteUrl: config.gscProperty,
        requestBody: {
          startDate: start,
          endDate: end,
          dimensions: ['query'],
          dimensionFilterGroups: [{ filters }],
          rowLimit: config.maxRawQueriesPerUrl,
        },
      });

      const pulledAt = new Date().toISOString();
      const rows: GscRawRow[] = (res.data.rows ?? [])
        .filter(
          (r) =>
            (r.impressions ?? 0) >= config.minImpressions &&
            (r.clicks ?? 0) >= config.minClicks,
        )
        .map((r) => ({
          url,
          query: r.keys?.[0] ?? '',
          clicks: r.clicks ?? 0,
          impressions: r.impressions ?? 0,
          ctr: round4(r.ctr ?? 0),
          avgPosition: round2(r.position ?? 0),
          startDate: start,
          endDate: end,
          country: config.countryFilter,
          device: config.deviceFilter,
          pulledAt,
        }))
        .filter((r) => r.query !== '');
      return { rows };
    } catch (err) {
      return { rows: [], error: (err as Error).message };
    }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
