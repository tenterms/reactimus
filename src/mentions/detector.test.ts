import { describe, expect, it } from 'vitest';
import { detectMention } from './detector.js';
import type { PageContentRow, QueryGroup } from '../types.js';

function page(overrides: Partial<PageContentRow>): PageContentRow {
  return {
    url: 'https://example.co.uk/it-support-sheffield/',
    httpStatus: 200,
    canonicalUrl: '',
    titleTag: '',
    metaDescription: '',
    h1: '',
    h2s: [],
    bodyText: '',
    wordCount: 0,
    lastFetched: '',
    ...overrides,
  };
}

function group(canonical: string, variants: string[] = []): QueryGroup {
  const all = [canonical, ...variants];
  return {
    url: 'https://example.co.uk/it-support-sheffield/',
    signature: '',
    canonicalQuery: canonical,
    variants: all.map((q) => ({ query: q, clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 })),
    totalClicks: 0,
    totalImpressions: 0,
    weightedAvgPosition: 0,
    bestQuery: canonical,
    highestImpressionQuery: canonical,
    variantCount: all.length,
    groupingRationale: '',
  };
}

const G = group('IT Support Sheffield', ['IT Support in Sheffield', 'Sheffield IT Support']);

describe('detectMention', () => {
  it('exact canonical phrase counts as exact', () => {
    const r = detectMention(G, page({ bodyText: 'We provide IT Support Sheffield businesses trust.' }));
    expect(r.type).toBe('exact');
    expect(r.location).toBe('body');
  });

  it('function words inserted still count as exact', () => {
    const r = detectMention(G, page({ h1: 'IT Support in Sheffield' }));
    expect(r.type).toBe('exact');
    expect(r.location).toBe('h1');
  });

  it('natural reorder from a grouped variant counts as exact', () => {
    const r = detectMention(G, page({ titleTag: 'Sheffield IT Support | Acme' }));
    expect(r.type).toBe('exact');
    expect(r.location).toBe('title');
  });

  it('phrase with extra descriptive words counts as close variant', () => {
    const r = detectMention(G, page({ bodyText: 'We offer professional IT support services in Sheffield for SMEs.' }));
    expect(['exact', 'close_variant']).toContain(r.type);
  });

  it('"our Sheffield IT support team" counts as a mention', () => {
    const r = detectMention(G, page({ bodyText: 'Get in touch with our Sheffield IT support team today.' }));
    expect(r.mentioned).toBe(true);
    expect(['exact', 'close_variant']).toContain(r.type);
  });

  it('scattered words count as concept covered, not a phrase mention', () => {
    const r = detectMention(
      G,
      page({
        bodyText:
          'Our IT team works remotely. We offer full support packages. Offices are located near Sheffield city centre, and we cover the whole region with responsive engineers.',
      }),
    );
    expect(r.type).toBe('concept_covered');
  });

  it('different modifier phrases do NOT count as mentions', () => {
    for (const text of [
      'IT Services Sheffield',
      'IT Support Services for your business',
      'a leading IT Support Company',
      'Technology Businesses thrive here',
      'IT Support Birmingham',
    ]) {
      const r = detectMention(G, page({ bodyText: text }));
      expect(r.type, text).toBe('not_covered');
    }
  });

  it('compound spelling on the page counts as a mention of the spaced form', () => {
    const g = group('cyber security consultancy');
    const r = detectMention(g, page({ h1: 'Cybersecurity Consultancy for regulated industries' }));
    expect(r.mentioned).toBe(true);
    expect(['exact', 'close_variant']).toContain(r.type);
  });

  it('reports evidence snippet and location', () => {
    const r = detectMention(G, page({ h2s: ['Why choose our IT support in Sheffield?'] }));
    expect(r.location).toBe('h2');
    expect(r.evidence.toLowerCase()).toContain('it support in sheffield');
  });
});
