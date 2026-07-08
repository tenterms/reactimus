import { google, sheets_v4 } from 'googleapis';
import { createGoogleAuth } from './auth.js';
import { HEADERS, HIDDEN_TABS } from './schema.js';

export type SheetRow = Record<string, string>;

/**
 * Thin Google Sheets wrapper working in terms of header-keyed row objects.
 * All writes are full-tab merges built in memory, so callers can preserve
 * human review columns before writing back.
 */
export class SheetsClient {
  private api: sheets_v4.Sheets;

  constructor(private spreadsheetId: string) {
    this.api = google.sheets({ version: 'v4', auth: createGoogleAuth() as never });
  }

  /** Create any missing tabs with their headers; hide backend tabs. */
  async ensureTabs(): Promise<void> {
    const meta = await this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const existing = new Map(
      (meta.data.sheets ?? []).map((s) => [s.properties?.title ?? '', s.properties?.sheetId ?? 0]),
    );

    const requests: sheets_v4.Schema$Request[] = [];
    for (const [tab] of Object.entries(HEADERS)) {
      if (!existing.has(tab)) {
        requests.push({ addSheet: { properties: { title: tab, hidden: HIDDEN_TABS.includes(tab) } } });
      }
    }
    if (requests.length > 0) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests },
      });
    }

    // Write headers into any tab whose first row is empty.
    for (const [tab, headers] of Object.entries(HEADERS)) {
      const res = await this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${tab}'!1:1`,
      });
      const firstRow = res.data.values?.[0] ?? [];
      if (firstRow.length === 0) {
        await this.api.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `'${tab}'!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headers] },
        });
      }
    }
  }

  /** Read a tab into header-keyed row objects (all values as strings). */
  async readTab(tab: string): Promise<SheetRow[]> {
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${tab}'`,
    });
    const values = res.data.values ?? [];
    if (values.length < 2) return [];
    const headers = values[0]!.map((h) => String(h));
    return values.slice(1).map((row) => {
      const obj: SheetRow = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] !== undefined && row[i] !== null ? String(row[i]) : '';
      });
      return obj;
    });
  }

  /** Replace a tab's data rows (header row is preserved/rewritten). */
  async writeTab(tab: string, rows: SheetRow[]): Promise<void> {
    const headers = HEADERS[tab];
    if (!headers) throw new Error(`Unknown tab: ${tab}`);
    const values = [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))];
    await this.api.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `'${tab}'`,
    });
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${tab}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  }

  /** Append rows without touching existing data (e.g. Review Log). */
  async appendRows(tab: string, rows: SheetRow[]): Promise<void> {
    if (rows.length === 0) return;
    const headers = HEADERS[tab];
    if (!headers) throw new Error(`Unknown tab: ${tab}`);
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `'${tab}'`,
      valueInputOption: 'RAW',
      requestBody: { values: rows.map((r) => headers.map((h) => r[h] ?? '')) },
    });
  }

  /** Update specific cells in a tab (used to mark feedback rows processed). */
  async updateCell(tab: string, a1: string, value: string): Promise<void> {
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${tab}'!${a1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  }
}

/**
 * Merge freshly computed rows with existing rows, preserving the listed
 * review columns for rows whose key already exists. Rows that disappear from
 * the computed set but carry review data are kept (flagged stale) so human
 * work is never silently discarded.
 */
export function mergePreservingReviewColumns(
  existing: SheetRow[],
  computed: SheetRow[],
  keyOf: (row: SheetRow) => string,
  reviewColumns: string[],
  statusColumn = 'Review status',
): SheetRow[] {
  const existingByKey = new Map(existing.map((r) => [keyOf(r), r]));
  const computedKeys = new Set(computed.map((r) => keyOf(r)));

  const merged = computed.map((row) => {
    const prior = existingByKey.get(keyOf(row));
    if (!prior) return row;
    const out = { ...row };
    for (const col of reviewColumns) {
      if (prior[col]) out[col] = prior[col];
    }
    return out;
  });

  // Keep rows with human review data that the new run no longer produced.
  for (const prior of existing) {
    const key = keyOf(prior);
    if (computedKeys.has(key)) continue;
    const hasReviewData = reviewColumns.some((col) => (prior[col] ?? '').trim() !== '');
    if (hasReviewData) {
      const kept = { ...prior };
      if (!String(kept[statusColumn] ?? '').toLowerCase().includes('stale')) {
        kept[statusColumn] = [kept[statusColumn], '(stale: not in latest run)']
          .filter(Boolean)
          .join(' ');
      }
      merged.push(kept);
    }
  }
  return merged;
}
