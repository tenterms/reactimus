import { describe, expect, it } from 'vitest';
import { scoreGroup } from './heuristics.js';
import { detectMention } from '../mentions/detector.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { PageContentRow, QueryGroup, SiteInventoryRow, ToolConfig } from '../types.js';

const PAGE: PageContentRow = {
  url: 'https://example.co.uk/it-support-sheffield/',
  httpStatus: 200,
  canonicalUrl: 'https://example.co.uk/it-support-sheffield/',
  titleTag: 'IT Support Sheffield | Acme IT',
  metaDescription: 'Responsive IT support for Sheffield businesses.',
  h1: 'IT Support in Sheffield',
  h2s: ['Why choose Acme', 'Our support packages', 'Response times'],
  bodyText:
    'Acme provides managed IT support to businesses across Sheffield and South Yorkshire. ' +
    'Our helpdesk resolves most issues within the hour. We support Microsoft 365, networking and servers.',
  wordCount: 300,
  lastFetched: '',
};

const INVENTORY: SiteInventoryRow[] = [
  {
    url: 'https://example.co.uk/it-support-sheffield/',
    titleTag: PAGE.titleTag,
    h1: PAGE.h1,
    pageType: 'service',
    primaryTopic: 'IT support Sheffield',
    targetIntent: 'commercial',
    canonicalUrl: '',
    notes: '',
  },
  {
    url: 'https://example.co.uk/it-services-sheffield/',
    titleTag: 'IT Services Sheffield | Acme IT',
    h1: 'IT Services in Sheffield',
    pageType: 'service',
    primaryTopic: 'IT services Sheffield',
    targetIntent: 'commercial',
    canonicalUrl: '',
    notes: '',
  },
];

const CONFIG: ToolConfig = {
  ...DEFAULT_CONFIG,
  clientName: 'Acme IT',
  targetLocations: ['Sheffield', 'Rotherham', 'Barnsley'],
  excludedLocations: ['Leeds'],
};

function group(canonical: string): QueryGroup {
  return {
    url: PAGE.url,
    signature: '',
    canonicalQuery: canonical,
    variants: [{ query: canonical, clicks: 5, impressions: 200, ctr: 0.025, avgPosition: 9 }],
    totalClicks: 5,
    totalImpressions: 200,
    weightedAvgPosition: 9,
    bestQuery: canonical,
    highestImpressionQuery: canonical,
    variantCount: 1,
    groupingRationale: '',
  };
}

function score(canonical: string) {
  const g = group(canonical);
  const mention = detectMention(g, PAGE);
  return scoreGroup(g, mention, {
    page: PAGE,
    inputMeta: {
      url: PAGE.url,
      pageType: 'service',
      primaryTopic: 'IT support Sheffield',
      targetIntent: 'commercial',
      businessPriority: 'high',
      notes: '',
      lastAnalysed: '',
      status: '',
    },
    inventory: INVENTORY,
    config: CONFIG,
  });
}

describe('scoreGroup', () => {
  it('scores the core page phrase as central and low-risk', () => {
    const s = score('it support sheffield');
    expect(s.topicalRelevance).toBe(5);
    expect(s.intentMatch).toBeGreaterThanOrEqual(4);
    expect(s.distinctTopic).toBeLessThanOrEqual(2);
  });

  it('flags a sibling page as a cannibalisation risk for its own phrase', () => {
    const s = score('it services sheffield');
    expect(s.cannibalisationRisk).toBeGreaterThanOrEqual(4);
    expect(s.betterExistingUrl).toBe('https://example.co.uk/it-services-sheffield/');
  });

  it('scores excluded locations as barely relevant', () => {
    const s = score('it support leeds');
    expect(s.topicalRelevance).toBeLessThanOrEqual(1);
  });

  it('treats a different target location as a distinct topic', () => {
    const s = score('it support rotherham');
    expect(s.distinctTopic).toBe(5);
  });

  it('treats cost/price modifiers as same-topic, not new pages', () => {
    const s = score('it support cost sheffield');
    expect(s.distinctTopic).toBeLessThanOrEqual(2);
    expect(s.commerciality).toBe(5);
  });

  it('scores unrelated topics low', () => {
    const s = score('wedding photographer sheffield');
    expect(s.topicalRelevance).toBeLessThanOrEqual(2);
  });

  it('classifies question queries as informational-leaning commerciality', () => {
    const s = score('what is managed it support');
    expect(s.commerciality).toBeLessThanOrEqual(2);
  });

  it('question phrasing does not drown out topic relevance', () => {
    const s = score('how much does it support cost');
    expect(s.topicalRelevance).toBeGreaterThanOrEqual(4);
    expect(s.intentMatch).toBeGreaterThanOrEqual(4);
  });

  it('flags recruitment queries as wrong intent', () => {
    const s = score('it support jobs sheffield');
    expect(s.intentMatch).toBeLessThanOrEqual(1);
  });

  it('keeps site-related distinct services as weak candidates (relevance 2)', () => {
    const s = score('cyber security services sheffield');
    expect(s.topicalRelevance).toBe(2); // "services" overlaps the site inventory
  });

  it('demotes queries with no topic overlap with the wider site', () => {
    const s = score('wedding photographer sheffield');
    expect(s.topicalRelevance).toBeLessThanOrEqual(1);
  });
});
