import { describe, expect, it } from 'vitest';
import { classifyGroup } from './decisionRules.js';
import type { GroupScores, MentionResult, QueryGroup } from '../types.js';
import { compileRules } from '../rules/engine.js';
import type { FeedbackRule } from '../types.js';

function group(canonical: string, impressions = 400, clicks = 15): QueryGroup {
  return {
    url: 'https://example.co.uk/it-support-sheffield/',
    signature: canonical.toLowerCase().split(' ').sort().join('|'),
    canonicalQuery: canonical,
    variants: [{ query: canonical, clicks, impressions, ctr: 0.03, avgPosition: 8 }],
    totalClicks: clicks,
    totalImpressions: impressions,
    weightedAvgPosition: 8,
    bestQuery: canonical,
    highestImpressionQuery: canonical,
    variantCount: 1,
    groupingRationale: '',
  };
}

function scores(overrides: Partial<GroupScores>): GroupScores {
  return {
    topicalRelevance: 3,
    intentMatch: 3,
    commerciality: 3,
    distinctTopic: 3,
    cannibalisationRisk: 1,
    betterExistingUrl: '',
    unknownQualifier: '',
    headSynonym: false,
    scoreNotes: [],
    ...overrides,
  };
}

const NOT_COVERED: MentionResult = { mentioned: false, type: 'not_covered', evidence: '', location: '' };

describe('classifyGroup default decision rules', () => {
  it('recommends add_to_h2 for headline-topic variants with real demand', () => {
    const d = classifyGroup(
      group('it support company sheffield'),
      scores({
        topicalRelevance: 5,
        intentMatch: 5,
        commerciality: 4,
        distinctTopic: 2,
        cannibalisationRisk: 1,
        headSynonym: true,
      }),
      NOT_COVERED,
    );
    expect(d.category).toBe('add_to_h2');
  });

  it('demotes commercial-but-not-undeniable groups to body copy', () => {
    const d = classifyGroup(
      group('managed it support sheffield'),
      scores({ topicalRelevance: 4, intentMatch: 5, commerciality: 4, distinctTopic: 2, cannibalisationRisk: 1 }),
      NOT_COVERED,
    );
    expect(d.category).toBe('add_to_body');
    expect(d.rationale).toContain('not an undeniable heading');
  });

  it('does not give H2s to low-demand headline variants', () => {
    const d = classifyGroup(
      group('it support company sheffield', 40, 1),
      scores({
        topicalRelevance: 5,
        intentMatch: 5,
        commerciality: 4,
        distinctTopic: 2,
        cannibalisationRisk: 1,
        headSynonym: true,
      }),
      NOT_COVERED,
    );
    expect(d.category).toBe('add_to_body');
  });

  it('recommends add_to_body for relevant but less commercial groups', () => {
    const d = classifyGroup(
      group('remote it support sheffield'),
      scores({ topicalRelevance: 4, intentMatch: 4, commerciality: 3, distinctTopic: 2, cannibalisationRisk: 1 }),
      NOT_COVERED,
    );
    expect(d.category).toBe('add_to_body');
  });

  it('recommends add_to_faq for question-led relevant groups', () => {
    const d = classifyGroup(
      group('how much does it support cost'),
      scores({ topicalRelevance: 4, intentMatch: 4, commerciality: 3, distinctTopic: 2, cannibalisationRisk: 1 }),
      NOT_COVERED,
    );
    expect(d.category).toBe('add_to_faq');
  });

  it('recommends new_commercial_page for distinct commercial intent', () => {
    const d = classifyGroup(
      group('cyber security services sheffield'),
      scores({ topicalRelevance: 3, intentMatch: 4, commerciality: 4, distinctTopic: 4, cannibalisationRisk: 1 }),
      NOT_COVERED,
    );
    expect(d.category).toBe('new_commercial_page');
  });

  it('recommends new_supporting_content for related informational topics', () => {
    const d = classifyGroup(
      group('what is managed it support'),
      scores({ topicalRelevance: 3, intentMatch: 4, commerciality: 2, distinctTopic: 3, cannibalisationRisk: 1 }),
      NOT_COVERED,
    );
    expect(d.category).toBe('new_supporting_content');
  });

  it('recommends assign_to_existing_page on high cannibalisation risk with a better URL', () => {
    const d = classifyGroup(
      group('it services sheffield'),
      scores({
        topicalRelevance: 4,
        intentMatch: 4,
        commerciality: 4,
        cannibalisationRisk: 5,
        betterExistingUrl: 'https://example.co.uk/it-services-sheffield/',
      }),
      NOT_COVERED,
    );
    expect(d.category).toBe('link_to_existing_page');
  });

  it('rejects low relevance or wrong intent', () => {
    expect(
      classifyGroup(group('technology businesses sheffield'), scores({ topicalRelevance: 1 }), NOT_COVERED)
        .category,
    ).toBe('reject');
    expect(
      classifyGroup(group('it support jobs sheffield'), scores({ topicalRelevance: 4, intentMatch: 1 }), NOT_COVERED)
        .category,
    ).toBe('reject');
  });

  it('does not recommend adding phrases already prominent in headings', () => {
    const covered: MentionResult = {
      mentioned: true,
      type: 'exact',
      evidence: 'IT Support in Sheffield',
      location: 'h1',
    };
    const d = classifyGroup(
      group('it support sheffield'),
      scores({ topicalRelevance: 5, intentMatch: 5, commerciality: 4, distinctTopic: 1, cannibalisationRisk: 1 }),
      covered,
    );
    expect(d.category).toBe('reject');
    expect(d.rationale).toContain('Already covered');
  });

  it('recommends prominence improvement when phrase is only in body copy', () => {
    const bodyMention: MentionResult = {
      mentioned: true,
      type: 'close_variant',
      evidence: 'our Sheffield IT support team',
      location: 'body',
    };
    const d = classifyGroup(
      group('it support sheffield', 2000, 80),
      scores({ topicalRelevance: 5, intentMatch: 5, commerciality: 4, distinctTopic: 1, cannibalisationRisk: 1 }),
      bodyMention,
    );
    expect(d.category).toBe('add_to_h2');
    expect(d.rationale).toContain('prominence');
  });

  it('lets weakly-related distinct commercial groups through as low-confidence new-page ideas', () => {
    const d = classifyGroup(
      group('cyber security services sheffield'),
      scores({ topicalRelevance: 2, intentMatch: 4, commerciality: 4, distinctTopic: 4, cannibalisationRisk: 1 }),
      NOT_COVERED,
    );
    expect(d.category).toBe('new_commercial_page');
    expect(d.confidence).toBeLessThan(0.7);
    expect(d.rationale).toContain('verify');
  });

  it('routes long conversational queries to FAQ, never new pages', () => {
    const d = classifyGroup(
      group('can you recommend a compliance service with consultants skilled in cybersecurity compliance for manufacturing?'),
      scores({ topicalRelevance: 3, intentMatch: 4, commerciality: 4, distinctTopic: 4, cannibalisationRisk: 1 }),
      NOT_COVERED,
    );
    expect(d.category).toBe('add_to_faq');
  });

  it('rejects conversational queries with weak fit as demand signals only', () => {
    const d = classifyGroup(
      group('find me the easiest security consulting services to integrate into a fintech development cycle'),
      scores({ topicalRelevance: 2, intentMatch: 3, commerciality: 4, distinctTopic: 4, cannibalisationRisk: 1 }),
      NOT_COVERED,
    );
    expect(d.category).toBe('reject');
    expect(d.rationale).toContain('demand signal');
  });

  it('rejects page-topic-plus-unknown-qualifier variants with guidance', () => {
    const d = classifyGroup(
      group('cyber security consultancy oxted'),
      scores({
        topicalRelevance: 4,
        intentMatch: 5,
        commerciality: 4,
        distinctTopic: 3,
        cannibalisationRisk: 1,
        unknownQualifier: 'oxted',
      }),
      NOT_COVERED,
    );
    expect(d.category).toBe('reject');
    expect(d.rationale).toContain('oxted');
    expect(d.rationale).toContain('Target locations');
  });

  it('still rejects unrelated queries even with commercial markers', () => {
    const d = classifyGroup(
      group('wedding photographer sheffield'),
      scores({ topicalRelevance: 1, intentMatch: 4, commerciality: 4, distinctTopic: 5, cannibalisationRisk: 0 }),
      NOT_COVERED,
    );
    expect(d.category).toBe('reject');
  });

  it('falls back to reject when no rule fires', () => {
    const d = classifyGroup(group('ambiguous thing'), scores({}), NOT_COVERED);
    expect(d.category).toBe('reject');
    expect(d.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe('classifyGroup with feedback rules', () => {
  const baseRule: FeedbackRule = {
    ruleId: 'R1',
    createdAt: '2026-07-01T00:00:00Z',
    createdBy: 'seo@tenterms.com',
    client: 'Acme IT',
    site: 'sc-domain:example.co.uk',
    scope: 'sitewide',
    ruleType: 'mark_irrelevant',
    phraseA: '',
    phraseB: '',
    queryGroup: 'it support jobs sheffield',
    url: '',
    betterUrl: '',
    originalDecision: 'add_to_body',
    correctedDecision: 'reject',
    reason: 'Recruitment intent, not a sales query',
    status: 'active',
    confidence: 1,
    appliesFrom: '',
    appliesUntil: '',
    notes: '',
  };
  const ctx = { client: 'Acme IT', site: 'sc-domain:example.co.uk' };

  it('mark_irrelevant rule forces reject regardless of scores', () => {
    const compiled = compileRules([baseRule], ctx);
    const d = classifyGroup(
      group('it support jobs sheffield'),
      scores({ topicalRelevance: 5, intentMatch: 5, commerciality: 5 }),
      NOT_COVERED,
      compiled,
    );
    expect(d.category).toBe('reject');
    expect(d.rationale).toContain('R1');
  });

  it('assign_to_existing_page rule forces assignment', () => {
    const rule: FeedbackRule = {
      ...baseRule,
      ruleId: 'R2',
      ruleType: 'assign_to_existing_page',
      queryGroup: 'it services sheffield',
      url: 'https://example.co.uk/it-support-sheffield/',
      betterUrl: 'https://example.co.uk/it-services/',
    };
    const compiled = compileRules([rule], ctx);
    const d = classifyGroup(
      group('it services sheffield'),
      scores({ topicalRelevance: 4, intentMatch: 4 }),
      NOT_COVERED,
      compiled,
    );
    expect(d.category).toBe('link_to_existing_page');
  });

  it('change_recommendation rule overrides the category', () => {
    const rule: FeedbackRule = {
      ...baseRule,
      ruleId: 'R3',
      ruleType: 'change_recommendation',
      queryGroup: 'emergency it support sheffield',
      url: 'https://example.co.uk/it-support-sheffield/',
      correctedDecision: 'new_commercial_page',
    };
    const compiled = compileRules([rule], ctx);
    const d = classifyGroup(
      group('emergency it support sheffield'),
      scores({ topicalRelevance: 4, intentMatch: 4, commerciality: 4, distinctTopic: 2 }),
      NOT_COVERED,
      compiled,
    );
    expect(d.category).toBe('new_commercial_page');
    expect(d.rationale).toContain('R3');
  });
});
