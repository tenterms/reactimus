import type { SheetRow } from '../google/sheets.js';
import type { DataStore } from '../pipeline/run.js';
import { HEADERS } from '../google/schema.js';

/** In-memory DataStore for local development, demos, and tests. */
export class MemoryStore implements DataStore {
  tabs = new Map<string, SheetRow[]>();

  constructor(seed: Record<string, SheetRow[]> = {}) {
    for (const [tab, rows] of Object.entries(seed)) {
      this.tabs.set(tab, rows.map((r) => ({ ...r })));
    }
  }

  async ensureTabs(): Promise<void> {
    for (const tab of Object.keys(HEADERS)) {
      if (!this.tabs.has(tab)) this.tabs.set(tab, []);
    }
  }

  async readTab(tab: string): Promise<SheetRow[]> {
    return (this.tabs.get(tab) ?? []).map((r) => ({ ...r }));
  }

  async writeTab(tab: string, rows: SheetRow[]): Promise<void> {
    this.tabs.set(tab, rows.map((r) => ({ ...r })));
  }

  async appendRows(tab: string, rows: SheetRow[]): Promise<void> {
    const existing = this.tabs.get(tab) ?? [];
    this.tabs.set(tab, [...existing, ...rows.map((r) => ({ ...r }))]);
  }

  async updateCell(tab: string, a1: string, value: string): Promise<void> {
    const match = a1.match(/^([A-Z]+)(\d+)$/);
    if (!match) return;
    const colIndex = colToIndex(match[1]!);
    const rowIndex = parseInt(match[2]!, 10) - 2; // data rows start at sheet row 2
    const headers = HEADERS[tab] ?? [];
    const header = headers[colIndex];
    const rows = this.tabs.get(tab);
    if (!header || !rows || !rows[rowIndex]) return;
    rows[rowIndex]![header] = value;
  }
}

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
