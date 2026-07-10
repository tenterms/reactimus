import { describe, expect, it } from 'vitest';
import { consolidateNewPageGroups } from './consolidate.js';
import type { AnalysedGroup, RecommendationCategory } from '../types.js';

function group(
  canonical: string,
  impressions: number,
  category: RecommendationCategory = 'new_commercial_page',
): AnalysedGroup {
  return {
    url: 'https://example.co.uk/service/compliance/',
    signature: '',
    canonicalQuery: canonical,
    variants: [{ query: canonical, clicks: 1, impressions, ctr: 0, avgPosition: 10 }],
    totalClicks: 1,
    totalImpressions: impressions,
    weightedAvgPosition: 10,
    bestQuery: canonical,
    highestImpressionQuery: canonical,
    variantCount: 1,
    groupingRationale: '',
    mention: { mentioned: false, type: 'not_covered', evidence: '', location: '' },
    scores: {
      topicalRelevance: 3,
      intentMatch: 4,
      commerciality: 4,
      distinctTopic: 4,
      cannibalisationRisk: 1,
      betterExistingUrl: '',
      unknownQualifier: '',
      scoreNotes: [],
    },
    category,
    rationale: 'distinct commercial topic',
    confidence: 0.6,
  };
}

describe('consolidateNewPageGroups', () => {
  it('clusters modifier variants of the same page topic together', () => {
    const clusters = consolidateNewPageGroups([
      group('cyber compliance services', 500),
      group('cyber compliance company', 120),
      group('best cyber compliance providers', 80),
      group('cyber compliance services uk', 60),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.seed.canonicalQuery).toBe('cyber compliance services');
    expect(clusters[0]!.totalImpressions).toBe(760);
    expect(clusters[0]!.members).toHaveLength(4);
  });

  it('clusters subset themes but keeps industry-specific variants separate', () => {
    const clusters = consolidateNewPageGroups([
      group('vciso services', 300),
      group('vciso security services', 150),
      group('vciso consulting firms for healthcare', 40),
    ]);
    // vciso + vciso security merge; the healthcare-audience variant is
    // conservatively its own page idea.
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.members).toHaveLength(2);
  });

  it('keeps genuinely different topics apart', () => {
    const clusters = consolidateNewPageGroups([
      group('cyber compliance services', 500),
      group('medical device security services', 300),
      group('penetration testing sheffield', 200),
    ]);
    expect(clusters).toHaveLength(3);
  });

  it('keeps different locations apart', () => {
    const clusters = consolidateNewPageGroups([
      group('cyber security sheffield', 300),
      group('cyber security newcastle', 200),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('never mixes commercial and informational pages', () => {
    const clusters = consolidateNewPageGroups([
      group('cyber compliance services', 300, 'new_commercial_page'),
      group('what is cyber compliance', 200, 'new_supporting_content'),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('highest-demand group seeds and names the cluster', () => {
    const clusters = consolidateNewPageGroups([
      group('compliance services cyber uk', 50),
      group('cyber compliance services', 900),
    ]);
    expect(clusters[0]!.seed.canonicalQuery).toBe('cyber compliance services');
  });
});
