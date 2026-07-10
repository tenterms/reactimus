import type {
  AnalysedGroup,
  NewPageIdeaRow,
  RecommendationRow,
  ToolConfig,
} from '../types.js';
import { contentTokens } from '../text/normalise.js';
import { INFORMATIONAL_MARKERS } from '../config/defaults.js';
import type { NewPageCluster } from './consolidate.js';

export function titleCase(phrase: string): string {
  return phrase
    .split(/\s+/)
    .map((w, i) =>
      i > 0 && w.length <= 2 && w === w.toLowerCase() ? w : w[0]!.toUpperCase() + w.slice(1),
    )
    .join(' ');
}

function slugify(phrase: string): string {
  return contentTokens(phrase, { singularise: false }).join('-');
}

export function priorityFromDemand(g: AnalysedGroup): 'high' | 'medium' | 'low' {
  if (g.totalImpressions >= 500 || g.totalClicks >= 20) return 'high';
  if (g.totalImpressions >= 100 || g.totalClicks >= 5) return 'medium';
  return 'low';
}

function demandSummary(g: AnalysedGroup): string {
  return (
    `${g.totalImpressions} impressions, ${g.totalClicks} clicks over the analysis window; ` +
    `avg position ${g.weightedAvgPosition}; ${g.variantCount} variant(s), ` +
    `top variant "${g.highestImpressionQuery}".`
  );
}

function variantsSummary(g: AnalysedGroup): string {
  return g.variants.map((v) => `${v.query} (${v.impressions} imp, ${v.clicks} clicks)`).join('; ');
}

function mentionEvidence(g: AnalysedGroup): string {
  if (g.mention.type === 'not_covered') return 'Not currently covered on the page.';
  return `${g.mention.type.replace(/_/g, ' ')} in ${g.mention.location}: "${g.mention.evidence}"`;
}

function cannibalisationNotes(g: AnalysedGroup): string {
  const notes = g.scores.scoreNotes.filter((n) => n.startsWith('Cannibalisation'));
  return notes.join(' ') || '';
}

/** Build the editorial Recommendations row for one analysed group. */
export function buildRecommendation(g: AnalysedGroup): RecommendationRow {
  const base: RecommendationRow = {
    url: g.url,
    recommendationType: g.category,
    canonicalQueryGroup: g.canonicalQuery,
    queryVariants: variantsSummary(g),
    searchDemandSummary: demandSummary(g),
    suggestedPlacement: '',
    suggestedContentTweak: '',
    existingPageEvidence: mentionEvidence(g),
    cannibalisationNotes: cannibalisationNotes(g),
    priority: priorityFromDemand(g),
    confidence: g.confidence,
    reviewStatus: '',
    reviewerNotes: '',
    correctedRecommendation: '',
    correctedCanonicalQuery: '',
    correctedGroup: '',
    betterUrl: '',
    feedbackReason: '',
    rememberRule: '',
    feedbackScope: '',
  };

  switch (g.category) {
    case 'add_to_h2':
      base.suggestedPlacement = 'New or reworded H2 section';
      base.suggestedContentTweak =
        `Add a section headed around "${titleCase(g.canonicalQuery)}" (natural phrasing preferred over exact match). ` +
        `Rationale: ${g.rationale}`;
      break;
    case 'add_to_body':
      base.suggestedPlacement = 'Existing paragraph copy';
      base.suggestedContentTweak =
        `Work "${g.canonicalQuery}" (or a natural variant) into existing paragraph copy where it fits the flow — ` +
        `avoid bolted-on SEO sentences. Rationale: ${g.rationale}`;
      break;
    case 'add_to_faq':
      base.suggestedPlacement = 'FAQ section on this page (H3 question + short answer)';
      base.suggestedContentTweak =
        `Add an H3 FAQ answering "${suggestFaqQuestion(g.canonicalQuery)}" with a short, direct answer — ` +
        `see the Suggested Edits tab for draft copy. Rationale: ${g.rationale}`;
      break;
    case 'new_commercial_page':
      base.suggestedPlacement = 'New commercial page (see New Page Ideas tab)';
      base.suggestedContentTweak = `Do not add to this page. ${g.rationale}`;
      break;
    case 'new_supporting_content':
      base.suggestedPlacement = 'New supporting content (see New Page Ideas tab)';
      base.suggestedContentTweak = `Do not add to this page. ${g.rationale}`;
      break;
    case 'assign_to_existing_page':
      base.suggestedPlacement = g.scores.betterExistingUrl || 'Another existing page';
      base.suggestedContentTweak =
        `Target this query group on ${g.scores.betterExistingUrl || 'the better-matching page'} instead. ${g.rationale}`;
      break;
    case 'reject':
      base.suggestedPlacement = 'No action';
      base.suggestedContentTweak = g.rationale;
      break;
  }

  return base;
}

export function suggestFaqQuestion(canonical: string): string {
  const phrase = canonical.replace(/\?+\s*$/, '').trim();
  const tokens = phrase.toLowerCase().split(/\s+/);
  const startsWithQuestionWord =
    tokens.length > 0 &&
    (INFORMATIONAL_MARKERS.has(tokens[0]!) || ['can', 'do', 'does', 'is', 'are', 'should'].includes(tokens[0]!));
  if (startsWithQuestionWord) {
    return titleCase(phrase) + '?';
  }
  return `What should I know about ${phrase}?`;
}

/**
 * Build one New Page Ideas row from a consolidated cluster of new_* groups.
 * The highest-demand group names the page; the others become supporting
 * queries the same page should target.
 */
export function buildNewPageIdea(cluster: NewPageCluster, config: ToolConfig): NewPageIdeaRow {
  const g = cluster.seed;
  const commercial = g.category === 'new_commercial_page';
  const conflicting =
    cluster.members.map((m) => m.scores.betterExistingUrl).find(Boolean) ?? '';
  const memberSummary =
    cluster.members.length > 1
      ? ` Consolidates ${cluster.members.length} related query groups: ${cluster.members
          .map((m) => `"${m.canonicalQuery}" (${m.totalImpressions} imp)`)
          .join(', ')}.`
      : '';
  const bestConfidence = Math.max(...cluster.members.map((m) => m.confidence));
  const demandProxy: AnalysedGroup = {
    ...g,
    totalImpressions: cluster.totalImpressions,
    totalClicks: cluster.totalClicks,
  };

  return {
    suggestedPageIdea: commercial
      ? titleCase(g.canonicalQuery)
      : `Guide: ${titleCase(g.canonicalQuery)}`,
    pageType: commercial ? 'service/landing page' : 'guide/blog post',
    commercialOrInformational: commercial ? 'commercial' : 'informational',
    sourceUrl: g.url,
    sourceQueryGroup: g.canonicalQuery,
    supportingQueryVariants: cluster.members
      .flatMap((m) => m.variants.map((v) => v.query))
      .join('; '),
    totalImpressions: cluster.totalImpressions,
    totalClicks: cluster.totalClicks,
    suggestedTargetIntent: commercial ? 'commercial' : 'informational',
    whySeparatePage: g.rationale + memberSummary,
    cannibalisationCheck:
      cluster.members.map(cannibalisationNotes).find(Boolean) ||
      (config.website
        ? 'No conflicting page found in the site inventory.'
        : 'Site inventory not available; verify manually.'),
    existingConflictingUrl: conflicting,
    suggestedUrlSlug: '/' + slugify(g.canonicalQuery) + '/',
    internalLinkingOpportunity: `Link from ${g.url} (the page whose GSC data surfaced this demand).`,
    priority: priorityFromDemand(demandProxy),
    confidence: bestConfidence,
    reviewStatus: '',
    reviewerNotes: '',
  };
}
