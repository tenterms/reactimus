import { describe, expect, it } from 'vitest';
import { groupQueries } from './grouper.js';
import { compileRules } from '../rules/engine.js';
import type { FeedbackRule, GscRawRow } from '../types.js';

function raw(query: string, impressions: number, clicks = 0, avgPosition = 10): GscRawRow {
  return {
    url: 'https://example.co.uk/it-support-sheffield/',
    query,
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    avgPosition,
    startDate: '2026-04-08',
    endDate: '2026-07-08',
    pulledAt: '2026-07-08T00:00:00Z',
  };
}

const CTX = { client: 'Acme IT', site: 'sc-domain:example.co.uk' };

describe('groupQueries', () => {
  it('groups near-identical phrase variants', () => {
    const groups = groupQueries([
      raw('it support sheffield', 900, 40, 3.1),
      raw('it support in sheffield', 300, 12, 3.8),
      raw('sheffield it support', 150, 4, 4.5),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.variantCount).toBe(3);
    expect(g.canonicalQuery).toBe('it support sheffield'); // highest impressions
    expect(g.totalImpressions).toBe(1350);
    expect(g.totalClicks).toBe(56);
    expect(g.bestQuery).toBe('it support sheffield'); // best avg position
    expect(g.highestImpressionQuery).toBe('it support sheffield');
  });

  it('keeps synonym-like and modifier variants separate', () => {
    const groups = groupQueries([
      raw('it support sheffield', 900),
      raw('it services sheffield', 500),
      raw('it support services', 200),
      raw('it support company', 100),
      raw('it support birmingham', 90),
      raw('technology businesses sheffield', 50),
    ]);
    expect(groups).toHaveLength(6);
  });

  it('computes impression-weighted average position', () => {
    const groups = groupQueries([
      raw('it support sheffield', 100, 0, 2),
      raw('sheffield it support', 300, 0, 6),
    ]);
    expect(groups[0]!.weightedAvgPosition).toBe(5); // (100*2 + 300*6) / 400
  });

  it('groups regular plural variants of the same phrase', () => {
    const groups = groupQueries([raw('it support service sheffield', 10), raw('it support services sheffield', 20)]);
    expect(groups).toHaveLength(1);
  });

  it('prefers natural wording when demand ties', () => {
    const groups = groupQueries([
      raw('it support in sheffield', 100, 5),
      raw('it support sheffield', 100, 5),
    ]);
    expect(groups[0]!.canonicalQuery).toBe('it support sheffield'); // fewer function words
  });

  it('merges groups only under an explicit synonym rule', () => {
    const rule: FeedbackRule = {
      ruleId: 'R1',
      createdAt: '2026-07-01T00:00:00Z',
      createdBy: 'seo@tenterms.com',
      client: 'Acme IT',
      site: 'sc-domain:example.co.uk',
      scope: 'client',
      ruleType: 'mark_as_synonyms',
      phraseA: 'it support sheffield',
      phraseB: 'managed it services sheffield',
      queryGroup: 'it support sheffield',
      url: '',
      betterUrl: '',
      originalDecision: '',
      correctedDecision: '',
      reason: 'Client treats these as one offer',
      status: 'active',
      confidence: 1,
      appliesFrom: '',
      appliesUntil: '',
      notes: '',
    };
    const compiled = compileRules([rule], CTX);
    const groups = groupQueries(
      [raw('it support sheffield', 900), raw('managed it services sheffield', 100)],
      compiled,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.canonicalQuery).toBe('it support sheffield');
    expect(groups[0]!.groupingRationale).toContain('R1');
  });

  it('a more specific distinct-intents rule beats a broader synonym rule', () => {
    const synonymGlobal: FeedbackRule = {
      ruleId: 'R-GLOBAL',
      createdAt: '2026-06-01T00:00:00Z',
      createdBy: '',
      client: '',
      site: '',
      scope: 'global',
      ruleType: 'mark_as_synonyms',
      phraseA: 'it support',
      phraseB: 'it services',
      queryGroup: '',
      url: '',
      betterUrl: '',
      originalDecision: '',
      correctedDecision: '',
      reason: '',
      status: 'active',
      confidence: 1,
      appliesFrom: '',
      appliesUntil: '',
      notes: '',
    };
    const distinctClient: FeedbackRule = {
      ...synonymGlobal,
      ruleId: 'R-CLIENT',
      createdAt: '2026-07-01T00:00:00Z',
      client: 'Acme IT',
      scope: 'client',
      ruleType: 'mark_as_distinct_intents',
      reason: 'Different SERPs for this client',
    };
    const compiled = compileRules([synonymGlobal, distinctClient], CTX);
    const groups = groupQueries([raw('it support', 100), raw('it services', 100)], compiled);
    expect(groups).toHaveLength(2);
  });

  it('split_group rules force a query into its own group', () => {
    const rule: FeedbackRule = {
      ruleId: 'R-SPLIT',
      createdAt: '2026-07-01T00:00:00Z',
      createdBy: '',
      client: 'Acme IT',
      site: '',
      scope: 'client',
      ruleType: 'split_group',
      phraseA: '',
      phraseB: 'sheffield it support',
      queryGroup: '',
      url: '',
      betterUrl: '',
      originalDecision: '',
      correctedDecision: '',
      reason: 'Local pack behaves differently for reversed order',
      status: 'active',
      confidence: 1,
      appliesFrom: '',
      appliesUntil: '',
      notes: '',
    };
    const compiled = compileRules([rule], CTX);
    const groups = groupQueries(
      [raw('it support sheffield', 900), raw('sheffield it support', 100)],
      compiled,
    );
    expect(groups).toHaveLength(2);
  });

  it('ignores inactive and out-of-scope rules', () => {
    const draft: FeedbackRule = {
      ruleId: 'R-DRAFT',
      createdAt: '2026-07-01T00:00:00Z',
      createdBy: '',
      client: 'Acme IT',
      site: '',
      scope: 'client',
      ruleType: 'mark_as_synonyms',
      phraseA: 'it support sheffield',
      phraseB: 'it services sheffield',
      queryGroup: '',
      url: '',
      betterUrl: '',
      originalDecision: '',
      correctedDecision: '',
      reason: '',
      status: 'draft',
      confidence: 1,
      appliesFrom: '',
      appliesUntil: '',
      notes: '',
    };
    const otherClient: FeedbackRule = { ...draft, ruleId: 'R-OTHER', status: 'active', client: 'Someone Else' };
    const compiled = compileRules([draft, otherClient], CTX);
    const groups = groupQueries(
      [raw('it support sheffield', 900), raw('it services sheffield', 100)],
      compiled,
    );
    expect(groups).toHaveLength(2);
  });
});
