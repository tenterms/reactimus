import { describe, expect, it } from 'vitest';
import { runAnalyse, runApplyFeedback } from './run.js';
import { MemoryStore } from '../mocks/memoryStore.js';
import { DEMO_SEED, MockGscClient, mockFetchPage, URL_SUPPORT } from '../mocks/fixtures.js';
import { TAB } from '../google/schema.js';

const silent = () => {};

function deps(store: MemoryStore) {
  return { store, gsc: new MockGscClient(), fetchPage: mockFetchPage, log: silent };
}

describe('end-to-end pipeline (offline)', () => {
  it('produces grouped, scored, classified output across all tabs', async () => {
    const store = new MemoryStore(DEMO_SEED);
    await runAnalyse(deps(store));

    const raw = await store.readTab(TAB.gscRaw);
    expect(raw.length).toBeGreaterThan(10);

    const groups = await store.readTab(TAB.queryGroups);
    const canonical = groups.map((g) => g['Canonical query group']);
    expect(canonical).toContain('it support sheffield');
    // Near-identical variants grouped into one row
    expect(canonical).not.toContain('it support in sheffield');
    // Synonym-like queries stay separate
    expect(canonical).toContain('it services sheffield');

    const recs = await store.readTab(TAB.recommendations);
    const byGroup = new Map(recs.map((r) => [r['Canonical query group'], r]));
    expect(byGroup.get('it services sheffield')?.['Recommendation type']).toBe('assign_to_existing_page');
    expect(byGroup.get('managed it support sheffield')?.['Recommendation type']).toBe('add_to_h2');
    // No-action rows live in the Rejected tab, keeping Recommendations clean.
    expect(byGroup.has('it support jobs sheffield')).toBe(false);
    const rejectedTab = await store.readTab(TAB.rejected);
    expect(
      rejectedTab.find((r) => r['Canonical query group'] === 'it support jobs sheffield')?.[
        'Recommendation type'
      ],
    ).toBe('reject');

    const ideas = await store.readTab(TAB.newPageIdeas);
    expect(ideas.some((i) => i['Source query group'] === 'it support rotherham')).toBe(true);
  });

  it('re-runs without duplicating rows and preserves review columns', async () => {
    const store = new MemoryStore(DEMO_SEED);
    await runAnalyse(deps(store));

    // Reviewer annotates a row.
    const recs = await store.readTab(TAB.recommendations);
    const idx = recs.findIndex((r) => r['Canonical query group'] === 'managed it support sheffield');
    recs[idx]!['Review status'] = 'approved';
    recs[idx]!['Reviewer notes'] = 'Great catch — briefing copywriter.';
    await store.writeTab(TAB.recommendations, recs);

    await runAnalyse(deps(store));

    const after = await store.readTab(TAB.recommendations);
    expect(after.length).toBe(recs.length); // no duplication
    const row = after.find((r) => r['Canonical query group'] === 'managed it support sheffield');
    expect(row?.['Review status']).toBe('approved');
    expect(row?.['Reviewer notes']).toBe('Great catch — briefing copywriter.');
  });

  it('applies reviewer feedback as a rule on the next run (full loop)', async () => {
    const store = new MemoryStore(DEMO_SEED);
    await runAnalyse(deps(store));

    // Reviewer rejects a recommendation and asks the tool to remember it.
    const recs = await store.readTab(TAB.recommendations);
    const idx = recs.findIndex((r) => r['Canonical query group'] === 'remote it support sheffield');
    expect(idx).toBeGreaterThanOrEqual(0);
    recs[idx]!['Review status'] = 'rejected';
    recs[idx]!['Feedback reason'] = 'Client does not offer remote-only support.';
    recs[idx]!['Remember this rule?'] = 'yes';
    recs[idx]!['Feedback scope'] = 'client';
    await store.writeTab(TAB.recommendations, recs);

    await runApplyFeedback({ store, log: silent }, 'seo@tenterms.com');

    // Rule + audit trail created; row marked processed.
    const rules = await store.readTab(TAB.feedbackRules);
    expect(rules).toHaveLength(1);
    expect(rules[0]!['Rule type']).toBe('mark_irrelevant');
    expect(rules[0]!['Status']).toBe('active');
    const log = await store.readTab(TAB.reviewLog);
    expect(log).toHaveLength(1);
    expect(log[0]!['Original decision']).toBe('add_to_h2');
    const marked = await store.readTab(TAB.recommendations);
    expect(marked[idx]!['Remember this rule?']).toMatch(/^saved:/);

    // Next analysis applies the rule: the group moves to the Rejected tab.
    await runAnalyse(deps(store));
    const rerun = await store.readTab(TAB.rejected);
    const row = rerun.find((r) => r['Canonical query group'] === 'remote it support sheffield');
    expect(row?.['Recommendation type']).toBe('reject');
    expect(row?.['Suggested content tweak']).toContain(rules[0]!['Rule ID']);
  });

  it('synonym feedback merges groups on the next run', async () => {
    const store = new MemoryStore(DEMO_SEED);
    await runAnalyse(deps(store));

    const before = await store.readTab(TAB.queryGroups);
    expect(before.some((g) => g['Canonical query group'] === 'managed it support sheffield')).toBe(true);

    // Reviewer: treat "managed it support sheffield" as the same intent as
    // "it support sheffield" for this client.
    const recs = await store.readTab(TAB.recommendations);
    const idx = recs.findIndex((r) => r['Canonical query group'] === 'managed it support sheffield');
    recs[idx]!['Corrected group'] = 'merge: it support sheffield | managed it support sheffield';
    recs[idx]!['Corrected canonical query'] = 'it support sheffield';
    recs[idx]!['Remember this rule?'] = 'yes';
    recs[idx]!['Feedback scope'] = 'client';
    await store.writeTab(TAB.recommendations, recs);

    await runApplyFeedback({ store, log: silent }, 'seo@tenterms.com');
    await runAnalyse(deps(store));

    const after = await store.readTab(TAB.queryGroups);
    const merged = after.find((g) => g['Canonical query group'] === 'it support sheffield');
    expect(after.some((g) => g['Canonical query group'] === 'managed it support sheffield')).toBe(false);
    expect(merged?.['Query variants']).toContain('managed it support sheffield');
  });

  it('flags recommendations honestly when the page cannot be fetched', async () => {
    const store = new MemoryStore(DEMO_SEED);
    const failingFetch = async (url: string) => ({
      url,
      httpStatus: 403,
      canonicalUrl: '',
      titleTag: '',
      metaDescription: '',
      h1: '',
      h2s: [],
      bodyText: '',
      wordCount: 0,
      lastFetched: '2026-07-10T00:00:00Z',
    });
    await runAnalyse({ store, gsc: new MockGscClient(), fetchPage: failingFetch, log: silent });

    // Nothing polluted the inventory with empty titles.
    const inventory = await store.readTab(TAB.siteInventory);
    expect(inventory.every((r) => r['Title tag'] !== '' || r['Notes'] !== 'auto-added from analysed pages')).toBe(true);

    // Every surviving recommendation is capped and flagged.
    const recs = await store.readTab(TAB.recommendations);
    for (const r of recs) {
      expect(parseFloat(r['Confidence']!)).toBeLessThanOrEqual(0.4);
      expect(r['Suggested content tweak']).toContain('PAGE CONTENT UNAVAILABLE');
      expect(r['Existing page evidence']).toContain('page not fetched');
    }

    // Input URLs record the fetch failure.
    const inputs = await store.readTab(TAB.inputUrls);
    expect(inputs[0]?.['Status']).toContain('403');
  });

  it('URLs in Input URLs get status and last-analysed stamps', async () => {
    const store = new MemoryStore(DEMO_SEED);
    await runAnalyse(deps(store));
    const inputs = await store.readTab(TAB.inputUrls);
    const row = inputs.find((r) => r['URL'] === URL_SUPPORT);
    expect(row?.['Status']).toBe('ok');
    expect(row?.['Last analysed']).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});
