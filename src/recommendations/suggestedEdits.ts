import type {
  AnalysedGroup,
  PageContentRow,
  SuggestedEditRow,
  ToolConfig,
} from '../types.js';
import { contentTokens } from '../text/normalise.js';
import { priorityFromDemand, suggestFaqQuestion, titleCase } from './generator.js';
import { themeTokens } from './consolidate.js';
import type { LlmAdapter } from '../llm/adapter.js';

const normUrl = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '');

/**
 * When the configured LLM adapter supports copy drafting, replace each
 * edit's template copy with publishable draft copy grounded in the fetched
 * page content. Heuristic templates are kept whenever the adapter declines
 * (no key, fetch-failed page, refusal, error) — the tab is never emptier
 * because the LLM was unavailable.
 */
export async function applyLlmDrafts(
  edits: SuggestedEditRow[],
  pages: Map<string, PageContentRow>,
  config: ToolConfig,
  adapter: LlmAdapter,
): Promise<number> {
  if (!adapter.draftEdit) return 0;
  let drafted = 0;
  for (const edit of edits) {
    const draft = await adapter.draftEdit({ edit, page: pages.get(normUrl(edit.url)), config });
    if (draft) {
      edit.suggestedCopy = draft;
      edit.why +=
        ' (Draft copy written by the LLM from the fetched page content — review before publishing.)';
      drafted++;
    }
  }
  return drafted;
}

/**
 * Cluster same-page groups that share a theme (or promote the same body
 * evidence), so one edit covers all its close keyword variants instead of
 * producing near-duplicate heading/body suggestions. Highest demand first;
 * the cluster's first member names the edit.
 */
function clusterByTheme(groups: AnalysedGroup[]): AnalysedGroup[][] {
  const sorted = [...groups].sort((a, b) => b.totalImpressions - a.totalImpressions);
  const clusters: Array<{ members: AnalysedGroup[]; theme: Set<string>; evidence: string }> = [];
  const similar = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size === 0 || b.size === 0) return false;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    if (shared === a.size || shared === b.size) return true;
    return shared / (a.size + b.size - shared) > 0.5;
  };

  for (const g of sorted) {
    const theme = themeTokens(g.canonicalQuery);
    const evidence = g.mention.evidence;
    const home = clusters.find(
      (c) => (evidence !== '' && c.evidence === evidence) || similar(c.theme, theme),
    );
    if (home) {
      home.members.push(g);
      for (const t of theme) home.theme.add(t);
    } else {
      clusters.push({ members: [g], theme, evidence });
    }
  }
  return clusters.map((c) => c.members);
}

/**
 * Turn the on-page recommendation categories (add_to_h2 / add_to_body /
 * add_to_faq) into a flat list of copy-and-paste edits: what to add, where
 * on the page, and which keywords it covers. Draft copy is template-based
 * and marked for editorial adaptation — the point is actionability, not
 * finished prose. FAQ items are consolidated into one H3 question set per
 * page, matching the client's FAQ-as-H3 convention.
 */
export function buildSuggestedEdits(
  groups: AnalysedGroup[],
  pages: Map<string, PageContentRow>,
  config: ToolConfig,
): SuggestedEditRow[] {
  const client = config.clientName || 'We';
  const edits: SuggestedEditRow[] = [];

  const byUrl = new Map<string, AnalysedGroup[]>();
  for (const g of groups) {
    if (g.category !== 'add_to_h2' && g.category !== 'add_to_body' && g.category !== 'add_to_faq') {
      continue;
    }
    const list = byUrl.get(g.url) ?? [];
    list.push(g);
    byUrl.set(g.url, list);
  }

  for (const [url, urlGroups] of byUrl) {
    const page = pages.get(normUrl(url));
    const h2s = page?.h2s ?? [];

    const bestSection = (g: AnalysedGroup): string => {
      const queryTokens = new Set(contentTokens(g.canonicalQuery));
      let best = '';
      let bestOverlap = 0;
      for (const h2 of h2s) {
        const overlap = contentTokens(h2).filter((t) => queryTokens.has(t)).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = h2;
        }
      }
      return best;
    };

    const allVariants = (cluster: AnalysedGroup[]) =>
      cluster.flatMap((g) => g.variants.map((v) => v.query)).join('; ');
    const demandProxyOf = (cluster: AnalysedGroup[]): AnalysedGroup => ({
      ...cluster[0]!,
      totalImpressions: cluster.reduce((s, g) => s + g.totalImpressions, 0),
      totalClicks: cluster.reduce((s, g) => s + g.totalClicks, 0),
    });
    const alsoCovers = (cluster: AnalysedGroup[]) =>
      cluster.length > 1
        ? ` One section covers ${cluster.length} close keyword groups: ${cluster
            .map((g) => `"${g.canonicalQuery}"`)
            .join(', ')} — do not create separate headings for each.`
        : '';

    // --- H2 edits: one per theme cluster ---
    for (const cluster of clusterByTheme(urlGroups.filter((x) => x.category === 'add_to_h2'))) {
      const g = cluster[0]!;
      const heading = titleCase(g.canonicalQuery);
      const promotable = g.mention.type === 'exact' || g.mention.type === 'close_variant';
      const section = bestSection(g);
      const otherVariants = cluster
        .slice(1)
        .map((m) => m.canonicalQuery)
        .filter((q) => q !== g.canonicalQuery);
      edits.push({
        url,
        editType: 'New H2 section',
        whereOnPage: promotable
          ? `Promote the existing copy — "${g.mention.evidence}" — into its own section`
          : section
            ? `New section after "${section}"`
            : 'New section after the opening content',
        suggestedCopy:
          `H2: ${heading}\n` +
          `Opening line: "${client} provides ${g.canonicalQuery} designed around your organisation's needs — [adapt to the page's tone and add 1–2 specifics]."` +
          (otherVariants.length > 0
            ? `\nWork these close variants into the section copy (not extra headings): ${otherVariants.join('; ')}.`
            : ''),
        keywordsTargeted: allVariants(cluster),
        why: g.rationale + alsoCovers(cluster),
        priority: priorityFromDemand(demandProxyOf(cluster)),
        confidence: Math.max(...cluster.map((m) => m.confidence)),
        status: '',
        reviewerNotes: '',
      });
    }

    // --- Body edits: one per theme cluster, anchored to the best section ---
    for (const cluster of clusterByTheme(urlGroups.filter((x) => x.category === 'add_to_body'))) {
      const g = cluster[0]!;
      const section = bestSection(g);
      const otherVariants = cluster
        .slice(1)
        .map((m) => m.canonicalQuery)
        .filter((q) => q !== g.canonicalQuery);
      edits.push({
        url,
        editType: 'Body copy',
        whereOnPage: section
          ? `Within the "${section}" section`
          : 'Within the main body copy, where it fits the flow',
        suggestedCopy:
          `Add one sentence using "${g.canonicalQuery}"` +
          (g.highestImpressionQuery !== g.canonicalQuery
            ? ` (or the variant "${g.highestImpressionQuery}")`
            : '') +
          `.\nDraft: "${client} also offers ${g.canonicalQuery} — [tie this to an existing point in the section rather than adding a standalone SEO sentence]."` +
          (otherVariants.length > 0
            ? `\nOne or two sentences can also cover: ${otherVariants.join('; ')} — no need for one sentence per keyword.`
            : ''),
        keywordsTargeted: allVariants(cluster),
        why: g.rationale + alsoCovers(cluster),
        priority: priorityFromDemand(demandProxyOf(cluster)),
        confidence: Math.max(...cluster.map((m) => m.confidence)),
        status: '',
        reviewerNotes: '',
      });
    }

    // --- FAQ edits: one consolidated H3 question set per page ---
    const faqGroups = urlGroups.filter((x) => x.category === 'add_to_faq');
    if (faqGroups.length > 0) {
      const items = faqGroups
        .sort((a, b) => b.totalImpressions - a.totalImpressions)
        .map((g) => {
          const question = suggestFaqQuestion(g.canonicalQuery);
          return (
            `H3: ${question}\n` +
            `Suggested answer: "${client} ${answerStem(g, page)} — [give a 2–3 sentence direct answer, then a next step such as a link to contact]."`
          );
        });
      const demandProxy: AnalysedGroup = {
        ...faqGroups[0]!,
        totalImpressions: faqGroups.reduce((s, g) => s + g.totalImpressions, 0),
        totalClicks: faqGroups.reduce((s, g) => s + g.totalClicks, 0),
      };
      edits.push({
        url,
        editType: 'FAQ (H3 questions)',
        whereOnPage: 'FAQ section near the bottom of the page (create one if it does not exist)',
        suggestedCopy: items.join('\n\n'),
        keywordsTargeted: faqGroups
          .flatMap((g) => g.variants.map((v) => v.query))
          .join('; '),
        why: `Answers ${faqGroups.length} question-led/conversational query group(s) searchers use to find this page.`,
        priority: priorityFromDemand(demandProxy),
        confidence: Math.max(...faqGroups.map((g) => g.confidence)),
        status: '',
        reviewerNotes: '',
      });
    }
  }

  // Highest-value edits first.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return edits.sort((a, b) => rank[a.priority] - rank[b.priority] || b.confidence - a.confidence);
}

/** A phrase-appropriate stem for the FAQ answer draft. */
function answerStem(g: AnalysedGroup, page?: PageContentRow): string {
  const topic = page?.h1 || page?.titleTag || g.canonicalQuery;
  return `provides ${topic.toLowerCase().replace(/\s*\|.*$/, '')} and can help with "${g.canonicalQuery}"`;
}
