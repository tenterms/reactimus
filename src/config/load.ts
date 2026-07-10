import type { ToolConfig } from '../types.js';
import { DEFAULT_CONFIG } from './defaults.js';
import type { SheetRow } from '../google/sheets.js';

/** Map of Config-tab setting labels (lowercased) to loader functions. */
const SETTERS: Record<string, (cfg: ToolConfig, value: string) => void> = {
  'client name': (c, v) => (c.clientName = v),
  website: (c, v) => (c.website = v),
  'gsc property': (c, v) => (c.gscProperty = v),
  'months back': (c, v) => (c.monthsBack = int(v, c.monthsBack)),
  'analysis date range (months back)': (c, v) => (c.monthsBack = int(v, c.monthsBack)),
  'start date': (c, v) => (c.startDate = v || undefined),
  'end date': (c, v) => (c.endDate = v || undefined),
  'country filter': (c, v) => (c.countryFilter = v || undefined),
  'device filter': (c, v) => (c.deviceFilter = v || undefined),
  'minimum impressions threshold': (c, v) => (c.minImpressions = int(v, c.minImpressions)),
  'minimum clicks threshold': (c, v) => (c.minClicks = int(v, c.minClicks)),
  'maximum raw queries per url': (c, v) => (c.maxRawQueriesPerUrl = int(v, c.maxRawQueriesPerUrl)),
  'maximum query groups per url': (c, v) => (c.maxQueryGroupsPerUrl = int(v, c.maxQueryGroupsPerUrl)),
  'reuse gsc pulls newer than (days)': (c, v) => (c.reusePullDays = int(v, c.reusePullDays)),
  'reuse pull days': (c, v) => (c.reusePullDays = int(v, c.reusePullDays)),
  'llm provider': (c, v) => (c.llmProvider = v.toLowerCase() === 'anthropic' ? 'anthropic' : 'none'),
  'llm model': (c, v) => (c.llmModel = v || c.llmModel),
  'client/business context': (c, v) => (c.clientContext = v),
  'client context': (c, v) => (c.clientContext = v),
  'business priorities': (c, v) => (c.businessPriorities = v),
  'priority topics': (c, v) => (c.priorityTopics = list(v)),
  'topics to prioritise': (c, v) => (c.priorityTopics = list(v)),
  'non-priority topics': (c, v) => (c.nonPriorityTopics = list(v)),
  'topics to avoid': (c, v) => (c.nonPriorityTopics = list(v)),
  'target locations': (c, v) => (c.targetLocations = list(v)),
  'excluded locations': (c, v) => (c.excludedLocations = list(v)),
  'target audiences': (c, v) => (c.targetAudiences = list(v)),
  'excluded audiences': (c, v) => (c.excludedAudiences = list(v)),
  'brand positioning': (c, v) => (c.brandPositioning = v),
  'approved terminology': (c, v) => (c.approvedTerminology = list(v)),
  'terminology to avoid': (c, v) => (c.terminologyToAvoid = list(v)),
};

function int(v: string, fallback: number): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(v: string): string[] {
  return v
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a ToolConfig from the Config tab (Setting/Value rows) merged over
 * defaults. Environment variables override the sheet for GSC property so a
 * local run can be redirected without editing the sheet.
 */
export function loadConfigFromRows(rows: SheetRow[]): ToolConfig {
  const config: ToolConfig = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    const key = (row['Setting'] ?? '').trim().toLowerCase();
    const value = (row['Value'] ?? '').trim();
    if (!key || !value) continue;
    SETTERS[key]?.(config, value);
  }
  if (process.env.GSC_PROPERTY) config.gscProperty = process.env.GSC_PROPERTY;
  return config;
}
