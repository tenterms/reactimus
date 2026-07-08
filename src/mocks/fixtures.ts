import type { GscRawRow, PageContentRow, ToolConfig } from '../types.js';
import type { QuerySource } from '../pipeline/run.js';
import type { SheetRow } from '../google/sheets.js';
import { TAB } from '../google/schema.js';

const SITE = 'https://acme-it.example.co.uk';
export const URL_SUPPORT = `${SITE}/it-support-sheffield/`;
export const URL_SERVICES = `${SITE}/it-services-sheffield/`;

const WINDOW = { startDate: '2026-04-06', endDate: '2026-07-06' };
const PULLED = '2026-07-08T09:00:00Z';

function raw(url: string, query: string, impressions: number, clicks: number, pos: number): GscRawRow {
  return {
    url,
    query,
    clicks,
    impressions,
    ctr: impressions ? Math.round((clicks / impressions) * 10000) / 10000 : 0,
    avgPosition: pos,
    ...WINDOW,
    pulledAt: PULLED,
  };
}

/** Realistic-ish GSC data exercising every recommendation category. */
export const MOCK_GSC_ROWS: GscRawRow[] = [
  // Near-identical variants → one group, already in H1 → no action
  raw(URL_SUPPORT, 'it support sheffield', 2200, 96, 2.4),
  raw(URL_SUPPORT, 'it support in sheffield', 640, 22, 2.9),
  raw(URL_SUPPORT, 'sheffield it support', 310, 9, 3.6),
  // Synonym-like → separate group; sibling page owns it → assign_to_existing_page
  raw(URL_SUPPORT, 'it services sheffield', 880, 12, 8.2),
  // Commercial modifier on-topic, mentioned only in body → add_to_h2 (prominence)
  raw(URL_SUPPORT, 'managed it support sheffield', 540, 18, 5.1),
  raw(URL_SUPPORT, 'managed it support in sheffield', 120, 4, 5.8),
  // Cost query → FAQ material
  raw(URL_SUPPORT, 'how much does it support cost', 260, 6, 9.4),
  // Secondary relevant detail → add_to_body
  raw(URL_SUPPORT, 'remote it support sheffield', 190, 5, 7.2),
  // Distinct commercial topic → new_commercial_page
  raw(URL_SUPPORT, 'cyber security services sheffield', 470, 3, 14.8),
  // Informational, related but too broad → new_supporting_content
  raw(URL_SUPPORT, 'what is managed it support', 350, 4, 11.3),
  // Different target location → distinct page opportunity
  raw(URL_SUPPORT, 'it support rotherham', 410, 2, 12.6),
  // Excluded location → reject
  raw(URL_SUPPORT, 'it support leeds', 380, 1, 18.9),
  // Wrong intent → reject
  raw(URL_SUPPORT, 'it support jobs sheffield', 290, 0, 15.2),
  // Unrelated → reject
  raw(URL_SUPPORT, 'technology businesses sheffield', 150, 0, 22.1),
];

export const MOCK_PAGES: Record<string, PageContentRow> = {
  [URL_SUPPORT]: {
    url: URL_SUPPORT,
    httpStatus: 200,
    canonicalUrl: URL_SUPPORT,
    titleTag: 'IT Support Sheffield | Acme IT',
    metaDescription: 'Fast, friendly IT support for Sheffield businesses. Helpdesk, on-site engineers and proactive monitoring.',
    h1: 'IT Support in Sheffield',
    h2s: ['Why Sheffield businesses choose Acme', 'Our support packages', 'Response times you can rely on'],
    bodyText:
      'Acme IT provides responsive IT support to businesses across Sheffield and South Yorkshire. ' +
      'Our helpdesk resolves most issues within the hour, and our engineers cover Microsoft 365, networking, servers and devices. ' +
      'We offer fully managed IT support in Sheffield with proactive monitoring, plus remote it support for hybrid teams. ' +
      'Whether you need day-to-day helpdesk cover or strategic guidance, our Sheffield IT support team is here to help.',
    wordCount: 78,
    lastFetched: PULLED,
  },
  [URL_SERVICES]: {
    url: URL_SERVICES,
    httpStatus: 200,
    canonicalUrl: URL_SERVICES,
    titleTag: 'IT Services Sheffield | Acme IT',
    metaDescription: 'Complete IT services for Sheffield organisations: cloud, connectivity, procurement and consultancy.',
    h1: 'IT Services in Sheffield',
    h2s: ['Cloud services', 'Connectivity', 'IT procurement'],
    bodyText:
      'Acme IT delivers a full range of IT services to Sheffield organisations, from cloud migration and connectivity to procurement and IT consultancy.',
    wordCount: 26,
    lastFetched: PULLED,
  },
};

export class MockGscClient implements QuerySource {
  async queriesForUrl(config: ToolConfig, url: string) {
    const rows = MOCK_GSC_ROWS.filter(
      (r) =>
        r.url === url &&
        r.impressions >= config.minImpressions &&
        r.clicks >= config.minClicks,
    );
    return { rows };
  }
}

export async function mockFetchPage(url: string): Promise<PageContentRow> {
  return (
    MOCK_PAGES[url] ?? {
      url,
      httpStatus: 404,
      canonicalUrl: '',
      titleTag: '',
      metaDescription: '',
      h1: '',
      h2s: [],
      bodyText: '',
      wordCount: 0,
      lastFetched: PULLED,
    }
  );
}

/** Seed tabs for the offline demo. */
export const DEMO_SEED: Record<string, SheetRow[]> = {
  [TAB.config]: [
    { Setting: 'Client name', Value: 'Acme IT' },
    { Setting: 'Website', Value: SITE },
    { Setting: 'GSC property', Value: 'sc-domain:acme-it.example.co.uk' },
    { Setting: 'Months back', Value: '3' },
    { Setting: 'Minimum impressions threshold', Value: '10' },
    { Setting: 'Maximum raw queries per URL', Value: '250' },
    { Setting: 'Maximum query groups per URL', Value: '50' },
    { Setting: 'Target locations', Value: 'Sheffield, Rotherham, Barnsley' },
    { Setting: 'Excluded locations', Value: 'Leeds' },
  ],
  [TAB.inputUrls]: [
    {
      URL: URL_SUPPORT,
      'Page type': 'service',
      'Primary topic': 'IT support Sheffield',
      'Target intent': 'commercial',
      'Business priority': 'high',
    },
  ],
  [TAB.siteInventory]: [
    {
      URL: URL_SERVICES,
      'Title tag': MOCK_PAGES[URL_SERVICES]!.titleTag,
      H1: MOCK_PAGES[URL_SERVICES]!.h1,
      'Page type': 'service',
      'Primary topic': 'IT services Sheffield',
      'Target intent': 'commercial',
    },
  ],
};
