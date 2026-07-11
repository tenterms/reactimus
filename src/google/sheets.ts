import { google, sheets_v4 } from 'googleapis';
import { createGoogleAuth } from './auth.js';
import { CHECKBOX_COLUMNS, HEADERS, HIDDEN_TABS } from './schema.js';

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
      // Refresh sheet ids for validation setup below.
      const refreshed = await this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      existing.clear();
      for (const s of refreshed.data.sheets ?? []) {
        existing.set(s.properties?.title ?? '', s.properties?.sheetId ?? 0);
      }
    }

    // Render selector columns as real checkboxes.
    const validationRequests: sheets_v4.Schema$Request[] = [];
    for (const [tab, column] of Object.entries(CHECKBOX_COLUMNS)) {
      const sheetId = existing.get(tab);
      const colIndex = HEADERS[tab]?.indexOf(column) ?? -1;
      if (sheetId === undefined || colIndex < 0) continue;
      validationRequests.push({
        setDataValidation: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: 5000,
            startColumnIndex: colIndex,
            endColumnIndex: colIndex + 1,
          },
          rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true },
        },
      });
    }
    if (validationRequests.length > 0) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: validationRequests },
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

  /** Read a tab into header-keyed row objects (missing tab → empty). */
  async readTab(tab: string): Promise<SheetRow[]> {
    let res;
    try {
      res = await this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${tab}'`,
      });
    } catch (err) {
      if (/Unable to parse range/i.test((err as Error).message)) return [];
      throw err;
    }
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
    // 'TRUE'/'FALSE' become real booleans so checkbox columns render properly.
    const cell = (v: string) => (v === 'TRUE' ? true : v === 'FALSE' ? false : v);
    const values = [headers, ...rows.map((r) => headers.map((h) => cell(r[h] ?? '')))];
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

  /** Hide a tab (best-effort; used for migrated legacy tabs). */
  async hideTab(tab: string): Promise<void> {
    try {
      const meta = await this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      const sheet = (meta.data.sheets ?? []).find((s) => s.properties?.title === tab);
      if (!sheet || sheet.properties?.hidden) return;
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId: sheet.properties?.sheetId, hidden: true },
                fields: 'hidden',
              },
            },
          ],
        },
      });
    } catch {
      /* best-effort */
    }
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
