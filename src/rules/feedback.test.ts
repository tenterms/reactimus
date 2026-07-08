import { describe, expect, it } from 'vitest';
import { processFeedback } from './feedback.js';
import type { SheetRow } from '../google/sheets.js';

const CTX = { client: 'Acme IT', site: 'sc-domain:example.co.uk', user: 'seo@tenterms.com' };

function recRow(overrides: SheetRow): SheetRow {
  return {
    URL: 'https://example.co.uk/it-support-sheffield/',
    'Recommendation type': 'add_to_body',
    'Canonical query group': 'it support sheffield',
    'Review status': '',
    'Reviewer notes': '',
    'Corrected recommendation': '',
    'Corrected canonical query': '',
    'Corrected group': '',
    'Better URL': '',
    'Feedback reason': '',
    'Remember this rule?': '',
    'Feedback scope': '',
    ...overrides,
  };
}

describe('processFeedback', () => {
  it('creates a change_recommendation rule when remembered', () => {
    const { rules, logs, processedMarkers } = processFeedback(
      [
        recRow({
          'Corrected recommendation': 'new_commercial_page',
          'Feedback reason': 'Deserves its own landing page',
          'Remember this rule?': 'yes',
          'Feedback scope': 'client',
        }),
      ],
      CTX,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]!.ruleType).toBe('change_recommendation');
    expect(rules[0]!.scope).toBe('client');
    expect(rules[0]!.originalDecision).toBe('add_to_body');
    expect(rules[0]!.correctedDecision).toBe('new_commercial_page');
    expect(logs[0]!.ruleCreated).toBe(true);
    expect(processedMarkers[0]!.marker).toMatch(/^saved:R-/);
  });

  it('logs but creates no rule when not remembered', () => {
    const { rules, logs, processedMarkers } = processFeedback(
      [recRow({ 'Review status': 'rejected', 'Feedback reason': 'One-off oddity' })],
      CTX,
    );
    expect(rules).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.originalDecision).toBe('add_to_body'); // original preserved
    expect(processedMarkers[0]!.marker).toBe('logged');
  });

  it('parses distinct directive into mark_as_distinct_intents', () => {
    const { rules } = processFeedback(
      [
        recRow({
          'Corrected group': 'distinct: it support | it services',
          'Feedback reason': 'Different SERPs; treat as separate intents',
          'Remember this rule?': 'yes',
          'Feedback scope': 'client',
        }),
      ],
      CTX,
    );
    expect(rules[0]!.ruleType).toBe('mark_as_distinct_intents');
    expect(rules[0]!.phraseA).toBe('it support');
    expect(rules[0]!.phraseB).toBe('it services');
  });

  it('parses merge directive into mark_as_synonyms with preferred wording', () => {
    const { rules } = processFeedback(
      [
        recRow({
          'Corrected group': 'merge: it support sheffield | managed it services sheffield',
          'Corrected canonical query': 'it support sheffield',
          'Remember this rule?': 'yes',
        }),
      ],
      CTX,
    );
    expect(rules[0]!.ruleType).toBe('mark_as_synonyms');
    expect(rules[0]!.phraseA).toBe('it support sheffield');
    expect(rules[0]!.phraseB).toBe('managed it services sheffield');
  });

  it('treats a Better URL as assign_to_existing_page', () => {
    const { rules } = processFeedback(
      [
        recRow({
          'Better URL': 'https://example.co.uk/it-services/',
          'Remember this rule?': 'yes',
          'Feedback scope': 'sitewide',
        }),
      ],
      CTX,
    );
    expect(rules[0]!.ruleType).toBe('assign_to_existing_page');
    expect(rules[0]!.betterUrl).toBe('https://example.co.uk/it-services/');
  });

  it('creates global-scope rules as drafts requiring approval', () => {
    const { rules } = processFeedback(
      [
        recRow({
          'Corrected recommendation': 'reject',
          'Remember this rule?': 'yes',
          'Feedback scope': 'global',
        }),
      ],
      CTX,
    );
    expect(rules[0]!.status).toBe('draft');
  });

  it('skips rows already processed', () => {
    const { rules, logs } = processFeedback(
      [
        recRow({
          'Corrected recommendation': 'reject',
          'Remember this rule?': 'saved:R-XYZ-01',
        }),
      ],
      CTX,
    );
    expect(rules).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('ignores untouched rows', () => {
    const { rules, logs } = processFeedback([recRow({})], CTX);
    expect(rules).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });
});
