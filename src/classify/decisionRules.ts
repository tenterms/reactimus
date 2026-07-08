import type {
  AnalysedGroup,
  GroupScores,
  MentionResult,
  QueryGroup,
  RecommendationCategory,
} from '../types.js';
import type { DecisionThresholds } from '../config/defaults.js';
import { DEFAULT_THRESHOLDS, INFORMATIONAL_MARKERS } from '../config/defaults.js';
import { contentSignature, contentTokens } from '../text/normalise.js';
import type { CompiledRules } from '../rules/engine.js';
import { findIrrelevantRule, urlGroupKey } from '../rules/engine.js';
import { classifyQueryIntent } from '../scoring/heuristics.js';

export interface Decision {
  category: RecommendationCategory;
  rationale: string;
  confidence: number;
}

/**
 * Classify a scored query group into exactly one recommendation category.
 * Explicit feedback rules always win; then the (configurable) default
 * decision rules run in a fixed order:
 * rules → reject → assign → already-covered → h2 → body/faq →
 * new commercial page → new supporting content → conservative fallback.
 */
export function classifyGroup(
  group: QueryGroup,
  scores: GroupScores,
  mention: MentionResult,
  compiledRules?: CompiledRules,
  thresholds: DecisionThresholds = DEFAULT_THRESHOLDS,
): Decision {
  const t = thresholds;
  // Recompute from the canonical query rather than trusting group.signature,
  // so rule lookups stay consistent however the group was keyed.
  const sig = contentSignature(group.canonicalQuery);

  // --- 1. Explicit feedback rules override everything ---
  if (compiledRules) {
    const irrelevant = findIrrelevantRule(compiledRules, group.url, sig);
    if (irrelevant) {
      return {
        category: 'reject',
        rationale: `Marked irrelevant by rule ${irrelevant.ruleId}: ${irrelevant.reason || 'no reason recorded'}.`,
        confidence: 0.95,
      };
    }
    const assignment = compiledRules.assignments.get(urlGroupKey(group.url, sig));
    if (assignment) {
      scores.betterExistingUrl = assignment.betterUrl;
      return {
        category: 'assign_to_existing_page',
        rationale: `Assigned to ${assignment.betterUrl} by rule ${assignment.ruleId}: ${assignment.reason || 'no reason recorded'}.`,
        confidence: 0.95,
      };
    }
    const override = compiledRules.categoryOverrides.get(urlGroupKey(group.url, sig));
    if (override) {
      return {
        category: override.category,
        rationale: `Category set by rule ${override.ruleId}: ${override.reason || 'no reason recorded'}.`,
        confidence: 0.95,
      };
    }
  }

  const tokens = contentTokens(group.canonicalQuery);
  const queryIntent = classifyQueryIntent(tokens);
  const isQuestionLed = tokens.some((tok) => INFORMATIONAL_MARKERS.has(tok));
  const dataConfidence = confidenceFromDemand(group.totalImpressions, group.totalClicks);

  // A distinct, commercial, non-cannibalising query group may deserve a new
  // page even when it is only weakly relevant to the *current* page — as long
  // as it relates to the wider site (relevance 2, not 0-1).
  const newPageCandidate =
    scores.commerciality >= t.newPageMinCommerciality &&
    scores.distinctTopic >= t.newPageMinDistinct &&
    scores.cannibalisationRisk <= t.newPageMaxCannibalisation;

  // --- 2. Reject: wrong intent, unrelated, or weakly related with no
  // new-page potential ---
  if (scores.intentMatch <= t.rejectMaxIntent) {
    return {
      category: 'reject',
      rationale: `Intent match ${scores.intentMatch}/5 — the searcher wants something this page does not offer.`,
      confidence: Math.min(0.85, dataConfidence + 0.1),
    };
  }
  if (
    scores.topicalRelevance <= 1 ||
    (scores.topicalRelevance <= t.rejectMaxRelevance && !newPageCandidate)
  ) {
    return {
      category: 'reject',
      rationale: `Topical relevance ${scores.topicalRelevance}/5 — not something someone would search when looking for this specific page.`,
      confidence: Math.min(0.85, dataConfidence + 0.1),
    };
  }

  // --- 3. Another page owns this intent ---
  if (scores.cannibalisationRisk >= t.assignMinCannibalisation && scores.betterExistingUrl) {
    return {
      category: 'assign_to_existing_page',
      rationale: `Cannibalisation risk ${scores.cannibalisationRisk}/5: ${scores.betterExistingUrl} is a stronger match for this query group.`,
      confidence: dataConfidence,
    };
  }

  // --- 4. Already covered prominently: no action needed ---
  const prominentlyCovered =
    (mention.type === 'exact' || mention.type === 'close_variant') &&
    (mention.location === 'title' || mention.location === 'h1' || mention.location === 'h2');
  if (prominentlyCovered) {
    return {
      category: 'reject',
      rationale: `Already covered: phrase appears in the page's ${mention.location} ("${mention.evidence}"). No change needed.`,
      confidence: 0.9,
    };
  }

  const addable =
    scores.topicalRelevance >= t.h2MinRelevance &&
    scores.intentMatch >= t.h2MinIntent &&
    scores.distinctTopic <= t.h2MaxDistinct &&
    scores.cannibalisationRisk <= t.h2MaxCannibalisation;

  // --- 5. add_to_h2: relevant, commercial, strengthens the core offer ---
  if (addable && scores.commerciality >= t.h2MinCommerciality) {
    const prominence =
      mention.type === 'exact' || mention.type === 'close_variant'
        ? ' Phrase already appears in body copy; the recommendation is to improve prominence.'
        : '';
    return {
      category: 'add_to_h2',
      rationale: `Highly relevant commercial query group (relevance ${scores.topicalRelevance}, intent ${scores.intentMatch}, commerciality ${scores.commerciality}) that would work as a section heading.${prominence}`,
      confidence: dataConfidence,
    };
  }

  // --- 6. add_to_body / add_to_faq: relevant but secondary ---
  if (addable && scores.commerciality < t.h2MinCommerciality) {
    // Already naturally covered in body and not heading-worthy: leave alone.
    if (mention.type === 'exact' || mention.type === 'close_variant') {
      return {
        category: 'reject',
        rationale: `Already covered naturally in the page copy ("${mention.evidence}"). Adding it again risks keyword stuffing.`,
        confidence: 0.85,
      };
    }
    if (isQuestionLed) {
      return {
        category: 'add_to_faq',
        rationale: `Question-led query group relevant to this page; answers a pre-conversion question without deserving a standalone article.`,
        confidence: dataConfidence,
      };
    }
    return {
      category: 'add_to_body',
      rationale: `Relevant secondary variant/detail (relevance ${scores.topicalRelevance}, commerciality ${scores.commerciality}); fits naturally in paragraph copy rather than a heading.`,
      confidence: dataConfidence,
    };
  }

  // --- 7. new_commercial_page: distinct commercial intent ---
  if (newPageCandidate) {
    const weaklyRelated = scores.topicalRelevance <= t.rejectMaxRelevance;
    return {
      category: 'new_commercial_page',
      rationale:
        `Commercial query group (commerciality ${scores.commerciality}) on a distinct topic (distinct-topic ${scores.distinctTopic}); forcing it into this page would cause topical drift.` +
        (weaklyRelated
          ? ' Only weakly related to the current page — verify this service belongs to the client before creating the page.'
          : ''),
      confidence: weaklyRelated ? Math.max(0.4, dataConfidence - 0.15) : dataConfidence,
    };
  }

  // --- 8. new_supporting_content: related informational topic ---
  if (
    scores.topicalRelevance >= t.supportingMinRelevance &&
    queryIntent === 'informational' &&
    scores.distinctTopic >= t.supportingMinDistinct
  ) {
    return {
      category: 'new_supporting_content',
      rationale: `Informational query group related to this page but too educational/broad for it (distinct-topic ${scores.distinctTopic}); better as supporting content that links back.`,
      confidence: dataConfidence,
    };
  }

  // --- 9. Conservative fallback: not confident enough to act ---
  return {
    category: 'reject',
    rationale: `Insufficient evidence to act (relevance ${scores.topicalRelevance}, intent ${scores.intentMatch}, commerciality ${scores.commerciality}, distinct-topic ${scores.distinctTopic}, cannibalisation ${scores.cannibalisationRisk}). Conservative default is no action.`,
    confidence: 0.5,
  };
}

/** More search demand → more confidence in the data behind the decision. */
function confidenceFromDemand(impressions: number, clicks: number): number {
  let c = 0.5;
  if (impressions >= 50) c += 0.1;
  if (impressions >= 250) c += 0.1;
  if (impressions >= 1000) c += 0.05;
  if (clicks >= 5) c += 0.05;
  if (clicks >= 25) c += 0.05;
  return Math.min(c, 0.85);
}

export function analyseGroup(
  group: QueryGroup,
  scores: GroupScores,
  mention: MentionResult,
  compiledRules?: CompiledRules,
  thresholds?: DecisionThresholds,
): AnalysedGroup {
  const decision = classifyGroup(group, scores, mention, compiledRules, thresholds);
  return {
    ...group,
    mention,
    scores,
    category: decision.category,
    rationale: decision.rationale,
    confidence: decision.confidence,
  };
}
