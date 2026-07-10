import { describe, expect, it } from 'vitest';
import { buildSuggestedEdits } from './suggestedEdits.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { AnalysedGroup, PageContentRow, RecommendationCategory } from '../types.js';

const URL = 'https://example.co.uk/it-support-sheffield/';

const PAGE: PageContentRow = {
  url: URL,
  httpStatus: 200,
  canonicalUrl: URL,
  titleTag: 'IT Support Sheffield | Acme IT',
  metaDescription: '',
  h1: 'IT Support in Sheffield',
  h2s: ['Our support packages', 'Response times'],
  bodyText: 'Acme provides managed IT support across Sheffield.',
  wordCount: 10,
  lastFetched: '',
};

function analysed(
  canonical: string,
  category: RecommendationCategory,
  overrides: Partial<AnalysedGroup> = {},
): AnalysedGroup {
  return {
    url: URL,
    signature: '',
    canonicalQuery: canonical,
    variants: [{ query: canonical, clicks: 5, impressions: 200, ctr: 0.02, avgPosition: 8 }],
    totalClicks: 5,
    totalImpressions: 200,
    weightedAvgPosition: 8,
    bestQuery: canonical,
    highestImpressionQuery: canonical,
    variantCount: 1,
    groupingRationale: '',
    mention: { mentioned: false, type: 'not_covered', evidence: '', location: '' },
    scores: {
      topicalRelevance: 4,
      intentMatch: 4,
      commerciality: 4,
      distinctTopic: 2,
      cannibalisationRisk: 1,
      betterExistingUrl: '',
      unknownQualifier: '',
      headSynonym: false,
      scoreNotes: [],
    },
    category,
    rationale: 'test',
    confidence: 0.7,
    ...overrides,
  };
}

const pages = new Map([[URL.replace(/\/+$/, '').toLowerCase(), PAGE]]);
const config = { ...DEFAULT_CONFIG, clientName: 'Acme IT' };

describe('buildSuggestedEdits', () => {
  it('produces an H2 edit with heading text and placement', () => {
    const edits = buildSuggestedEdits([analysed('it support packages sheffield', 'add_to_h2')], pages, config);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.editType).toBe('New H2 section');
    expect(edits[0]!.suggestedCopy).toContain('H2: It Support Packages Sheffield');
    expect(edits[0]!.whereOnPage).toContain('Our support packages'); // best-overlap section
  });

  it('anchors promotable H2s to the existing copy', () => {
    const g = analysed('managed it support sheffield', 'add_to_h2', {
      mention: { mentioned: true, type: 'exact', evidence: 'managed IT support across Sheffield', location: 'body' },
    });
    const edits = buildSuggestedEdits([g], pages, config);
    expect(edits[0]!.whereOnPage).toContain('Promote the existing copy');
    expect(edits[0]!.whereOnPage).toContain('managed IT support across Sheffield');
  });

  it('produces body edits anchored to the best-matching section', () => {
    const edits = buildSuggestedEdits([analysed('it support response times', 'add_to_body')], pages, config);
    expect(edits[0]!.editType).toBe('Body copy');
    expect(edits[0]!.whereOnPage).toContain('Response times');
    expect(edits[0]!.suggestedCopy).toContain('"it support response times"');
  });

  it('consolidates FAQ groups into one H3 question set per page', () => {
    const edits = buildSuggestedEdits(
      [
        analysed('how much does it support cost', 'add_to_faq'),
        analysed('what is managed it support', 'add_to_faq'),
      ],
      pages,
      config,
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]!.editType).toBe('FAQ (H3 questions)');
    const h3Count = (edits[0]!.suggestedCopy.match(/H3:/g) ?? []).length;
    expect(h3Count).toBe(2);
    expect(edits[0]!.suggestedCopy).toContain('How Much Does it Support Cost?');
  });

  it('clusters same-theme H2 groups into one edit', () => {
    const edits = buildSuggestedEdits(
      [
        analysed('it support packages sheffield', 'add_to_h2', { totalImpressions: 500 }),
        analysed('it support packages', 'add_to_h2', { totalImpressions: 100 }),
      ],
      pages,
      config,
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]!.keywordsTargeted).toContain('it support packages sheffield');
    expect(edits[0]!.keywordsTargeted).toContain('it support packages');
    expect(edits[0]!.why).toContain('do not create separate headings');
  });

  it('ignores non-on-page categories', () => {
    const edits = buildSuggestedEdits(
      [analysed('cyber security services', 'new_commercial_page'), analysed('other thing', 'reject')],
      pages,
      config,
    );
    expect(edits).toHaveLength(0);
  });
});
