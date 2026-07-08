import type {
  AnalysedGroup,
  NewPageIdeaRow,
  RecommendationRow,
  ToolConfig,
} from '../types.js';
import { contentTokens } from '../text/normalise.js';
import { INFORMATIONAL_MARKERS } from '../config/defaults.js';

function titleCase(phrase: string): string {
  return phrase
    .split(/\s+/)
    .map((w) => (w.length <= 2 && w === w.toLowerCase() ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

function slugify(phrase: string): string {
  return contentTokens(phrase, { singularise: false }).join('-');
}

function priorityFromDemand(g: AnalysedGroup): 'high' | 'medium' | 'low' {
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
      base.suggestedPlacement = 'FAQ section on this page';
      base.suggestedContentTweak =
        `Add an FAQ answering "${suggestFaqQuestion(g.canonicalQuery)}" with a short, direct answer. ` +
        `Rationale: ${g.rationale}`;
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

function suggestFaqQuestion(canonical: string): string {
  const tokens = canonical.toLowerCase().split(/\s+/);
  const startsWithQuestionWord = tokens.length > 0 && INFORMATIONAL_MARKERS.has(tokens[0]!);
  if (startsWithQuestionWord) {
    return titleCase(canonical) + '?';
  }
  return `What should I know about ${canonical}?`;
}

/** Build a New Page Ideas row from a new_* classified group. */
export function buildNewPageIdea(g: AnalysedGroup, config: ToolConfig): NewPageIdeaRow | null {
  if (g.category !== 'new_commercial_page' && g.category !== 'new_supporting_content') {
    return null;
  }
  const commercial = g.category === 'new_commercial_page';
  const conflicting = g.scores.betterExistingUrl;

  return {
    suggestedPageIdea: commercial
      ? titleCase(g.canonicalQuery)
      : `Guide: ${titleCase(g.canonicalQuery)}`,
    pageType: commercial ? 'service/landing page' : 'guide/blog post',
    commercialOrInformational: commercial ? 'commercial' : 'informational',
    sourceUrl: g.url,
    sourceQueryGroup: g.canonicalQuery,
    supportingQueryVariants: g.variants.map((v) => v.query).join('; '),
    totalImpressions: g.totalImpressions,
    totalClicks: g.totalClicks,
    suggestedTargetIntent: commercial ? 'commercial' : 'informational',
    whySeparatePage: g.rationale,
    cannibalisationCheck:
      cannibalisationNotes(g) ||
      (config.website
        ? 'No conflicting page found in the site inventory.'
        : 'Site inventory not available; verify manually.'),
    existingConflictingUrl: conflicting,
    suggestedUrlSlug: '/' + slugify(g.canonicalQuery) + '/',
    internalLinkingOpportunity: `Link from ${g.url} (the page whose GSC data surfaced this demand).`,
    priority: priorityFromDemand(g),
    confidence: g.confidence,
    reviewStatus: '',
    reviewerNotes: '',
  };
}
