import type {
  GroupScores,
  InputUrlRow,
  MentionResult,
  PageContentRow,
  QueryGroup,
  SiteInventoryRow,
  ToolConfig,
} from '../types.js';
import { contentTokens } from '../text/normalise.js';
import {
  COMMERCIAL_MARKERS,
  GEO_MODIFIERS,
  INFORMATIONAL_MARKERS,
  QUESTION_STOPWORDS,
  WRONG_INTENT_MARKERS,
} from '../config/defaults.js';

/** Strong transactional markers within COMMERCIAL_MARKERS. */
const STRONG_COMMERCIAL = new Set([
  'buy',
  'hire',
  'quote',
  'quotes',
  'cost',
  'costs',
  'price',
  'prices',
  'pricing',
  'near',
  'cheap',
  'affordable',
]);

export type QueryIntent = 'commercial' | 'informational' | 'ambiguous';

export function classifyQueryIntent(tokens: string[]): QueryIntent {
  const hasCommercial = tokens.some((t) => COMMERCIAL_MARKERS.has(t));
  const hasInformational = tokens.some((t) => INFORMATIONAL_MARKERS.has(t));
  if (hasInformational && !hasCommercial) return 'informational';
  if (hasCommercial && !hasInformational) return 'commercial';
  if (hasCommercial && hasInformational) return 'ambiguous';
  return 'ambiguous';
}

export interface ScoringContext {
  page: PageContentRow;
  inputMeta?: InputUrlRow;
  inventory: SiteInventoryRow[];
  config: ToolConfig;
}

interface PageProfile {
  headTokens: Set<string>; // title + h1 + primary topic
  h2Tokens: Set<string>;
  bodyTokens: Set<string>;
  allTokens: Set<string>;
}

export function buildPageProfile(page: PageContentRow, inputMeta?: InputUrlRow): PageProfile {
  const headTokens = new Set([
    ...contentTokens(page.titleTag),
    ...contentTokens(page.h1),
    ...contentTokens(inputMeta?.primaryTopic ?? ''),
  ]);
  const h2Tokens = new Set(page.h2s.flatMap((h) => contentTokens(h)));
  const bodyTokens = new Set([
    ...contentTokens(page.bodyText),
    ...contentTokens(page.metaDescription),
  ]);
  return {
    headTokens,
    h2Tokens,
    bodyTokens,
    allTokens: new Set([...headTokens, ...h2Tokens, ...bodyTokens]),
  };
}

/**
 * Topic-carrying tokens of a query: content tokens minus question/filler
 * words. "how much does it support cost" -> [it, support, cost]. Falls back
 * to all tokens when filtering would leave nothing.
 */
export function coreTokens(tokens: string[]): string[] {
  const core = tokens.filter(
    (t) => !INFORMATIONAL_MARKERS.has(t) && !QUESTION_STOPWORDS.has(t),
  );
  return core.length > 0 ? core : tokens;
}

export function scoreGroup(
  group: QueryGroup,
  mention: MentionResult,
  ctx: ScoringContext,
): GroupScores {
  const tokens = contentTokens(group.canonicalQuery);
  const profile = buildPageProfile(ctx.page, ctx.inputMeta);
  const notes: string[] = [];

  const commerciality = scoreCommerciality(tokens, ctx.config, notes);
  const topicalRelevance = scoreTopicalRelevance(tokens, profile, mention, ctx, notes);
  const intentMatch = scoreIntentMatch(tokens, profile, ctx, commerciality, notes);
  const { score: distinctTopic, unknownQualifier } = scoreDistinctTopic(
    tokens,
    profile,
    mention,
    ctx,
    notes,
  );
  const { risk: cannibalisationRisk, betterUrl } = scoreCannibalisation(
    group,
    tokens,
    profile,
    ctx,
    notes,
  );

  // Undeniable rephrasing of the page's own headline topic? (Modifiers like
  // services/company/uk aside, every topic word is already in title/H1.)
  const modifierFree = coreTokens(tokens).filter(
    (t) => !COMMERCIAL_MARKERS.has(t) && !GEO_MODIFIERS.has(t),
  );
  const headSynonym =
    modifierFree.length > 0 && modifierFree.every((t) => profile.headTokens.has(t));
  if (headSynonym) notes.push('Query is a modifier-variant of the page headline topic.');

  return {
    topicalRelevance,
    intentMatch,
    commerciality,
    distinctTopic,
    cannibalisationRisk,
    betterExistingUrl: betterUrl,
    unknownQualifier,
    headSynonym,
    scoreNotes: notes,
  };
}

// ---------------------------------------------------------------------------

function scoreCommerciality(tokens: string[], config: ToolConfig, notes: string[]): number {
  const strong = tokens.filter((t) => STRONG_COMMERCIAL.has(t));
  const commercial = tokens.filter((t) => COMMERCIAL_MARKERS.has(t));
  const informational = tokens.filter((t) => INFORMATIONAL_MARKERS.has(t));
  const hasTargetLocation = tokens.some((t) =>
    config.targetLocations.map((l) => l.toLowerCase()).includes(t),
  );

  if (strong.length > 0 && informational.length === 0) {
    notes.push(`Commerciality: strong transactional marker(s) [${strong.join(', ')}].`);
    return 5;
  }
  if (commercial.length > 0 && informational.length === 0) {
    notes.push(`Commerciality: commercial marker(s) [${commercial.join(', ')}].`);
    return 4;
  }
  if (commercial.length > 0 && informational.length > 0) {
    notes.push('Commerciality: mixed commercial and informational markers.');
    return 3;
  }
  if (informational.length > 0) {
    notes.push(`Commerciality: informational marker(s) [${informational.join(', ')}].`);
    return 2;
  }
  // No explicit markers: a bare "service + target location" query is
  // implicitly commercial for a local business.
  if (hasTargetLocation) {
    notes.push('Commerciality: no explicit markers, but includes a target location (implicit local-commercial).');
    return 4;
  }
  notes.push('Commerciality: no markers; treated as mixed.');
  return 3;
}

function scoreTopicalRelevance(
  tokens: string[],
  profile: PageProfile,
  mention: MentionResult,
  ctx: ScoringContext,
  notes: string[],
): number {
  const config = ctx.config;
  // A phrase present in a heading is by definition central to the page.
  if (
    (mention.type === 'exact' || mention.type === 'close_variant') &&
    (mention.location === 'title' || mention.location === 'h1' || mention.location === 'h2')
  ) {
    notes.push('Relevance: phrase already present in a heading.');
    return 5;
  }

  // Score on topic-carrying tokens only, so question phrasing ("how much
  // does...") doesn't drown out the actual subject.
  const scored = coreTokens(tokens);
  let weighted = 0;
  for (const t of scored) {
    if (profile.headTokens.has(t)) weighted += 3;
    else if (profile.h2Tokens.has(t)) weighted += 2;
    else if (profile.bodyTokens.has(t)) weighted += 1;
  }
  const ratio = scored.length > 0 ? weighted / (scored.length * 3) : 0;

  let score: number;
  if (ratio >= 0.85) score = 5;
  else if (ratio >= 0.6) score = 4;
  else if (ratio >= 0.4) score = 3;
  else if (ratio >= 0.2) score = 2;
  else if (ratio > 0) score = 1;
  else score = 0;

  // Location sanity: excluded locations kill relevance; a location that is
  // neither a target location nor on the page caps it.
  const excluded = config.excludedLocations.map((l) => l.toLowerCase());
  const targets = config.targetLocations.map((l) => l.toLowerCase());
  if (tokens.some((t) => excluded.includes(t))) {
    notes.push('Relevance capped: query targets an excluded location.');
    score = Math.min(score, 1);
  } else {
    const offPageLocations = targets.length
      ? tokens.filter((t) => !profile.allTokens.has(t) && !targets.includes(t) && looksLikeProperNoun(t))
      : [];
    if (offPageLocations.length > 0) {
      notes.push(`Relevance: token(s) [${offPageLocations.join(', ')}] not on page or in target locations.`);
    }
  }

  // Site awareness: a weakly/moderately relevant query is only worth acting
  // on if it shares at least one non-location topic token with the wider
  // site (inventory titles/H1s/topics or configured priority topics).
  // "cyber security services sheffield" survives on an IT site; "wedding
  // photographer sheffield" and "technology businesses sheffield" — whose
  // coverage comes only from a location and generic body words — do not.
  if (score === 2 || score === 3) {
    const siteTokens = buildSiteProfile(ctx);
    if (siteTokens.size > 0) {
      const targets = config.targetLocations.map((l) => l.toLowerCase());
      const topicTokens = scored.filter((t) => !targets.includes(t));
      if (topicTokens.length > 0 && !topicTokens.some((t) => siteTokens.has(t))) {
        notes.push('Relevance demoted: no topic-token overlap with the wider site inventory.');
        score = 1;
      }
    }
  }

  notes.push(`Relevance: ${(ratio * 100).toFixed(0)}% weighted token coverage → ${score}.`);
  return score;
}

function buildSiteProfile(ctx: ScoringContext): Set<string> {
  const tokens = new Set<string>();
  for (const page of ctx.inventory) {
    for (const t of contentTokens(page.titleTag)) tokens.add(t);
    for (const t of contentTokens(page.h1)) tokens.add(t);
    for (const t of contentTokens(page.primaryTopic)) tokens.add(t);
  }
  for (const topic of ctx.config.priorityTopics) {
    for (const t of contentTokens(topic)) tokens.add(t);
  }
  return tokens;
}

/** Crude proper-noun-ish check for tokens we cannot classify. */
function looksLikeProperNoun(token: string): boolean {
  return token.length > 3 && !COMMERCIAL_MARKERS.has(token) && !INFORMATIONAL_MARKERS.has(token);
}

function scoreIntentMatch(
  tokens: string[],
  profile: PageProfile,
  ctx: ScoringContext,
  commerciality: number,
  notes: string[],
): number {
  const queryIntent = classifyQueryIntent(tokens);
  const pageIntent = ctx.inputMeta?.targetIntent || 'commercial';

  // Recruitment/account-access intent is almost never what a marketing page
  // serves — unless the page itself is about that topic.
  const pageTopicTokens = contentTokens(ctx.inputMeta?.primaryTopic ?? '');
  const wrongIntent = tokens.filter(
    (t) => WRONG_INTENT_MARKERS.has(t) && !pageTopicTokens.includes(t),
  );
  if (wrongIntent.length > 0) {
    notes.push(`Intent: wrong-intent marker(s) [${wrongIntent.join(', ')}] → 1.`);
    return 1;
  }

  let score: number;
  if (pageIntent === 'commercial') {
    if (queryIntent === 'commercial' || commerciality >= 4) {
      score = 5;
    } else {
      // Informational or mixed query on a commercial page: a pre-conversion
      // question about this service ("how much does it support cost") still
      // matches well when most of the topic tokens are covered by the page.
      const topicTokens = coreTokens(tokens);
      const covered = topicTokens.filter((t) => profile.allTokens.has(t));
      const wellCovered =
        topicTokens.length > 0 && covered.length / topicTokens.length >= 2 / 3;
      if (queryIntent === 'ambiguous') score = wellCovered ? 4 : 3;
      else score = wellCovered ? 4 : 2;
    }
  } else if (pageIntent === 'informational') {
    if (queryIntent === 'informational') score = 5;
    else if (queryIntent === 'ambiguous') score = 3;
    else score = 2;
  } else {
    score = 3;
  }
  notes.push(`Intent: query=${queryIntent}, page=${pageIntent || 'unknown'} → ${score}.`);
  return score;
}

function scoreDistinctTopic(
  tokens: string[],
  profile: PageProfile,
  mention: MentionResult,
  ctx: ScoringContext,
  notes: string[],
): { score: number; unknownQualifier: string } {
  const config = ctx.config;
  if (mention.type === 'unknown') {
    notes.push('Distinct-topic: page content unavailable; defaulting to 3 (could be subsection or separate page).');
    return { score: 3, unknownQualifier: '' };
  }
  if (mention.type === 'exact' || mention.type === 'close_variant') {
    notes.push('Distinct-topic: phrase already on page → part of current page.');
    return { score: 1, unknownQualifier: '' };
  }
  if (mention.type === 'concept_covered') {
    notes.push('Distinct-topic: concept covered on page.');
    return { score: 2, unknownQualifier: '' };
  }

  // Novelty is judged on topic-carrying tokens only — question phrasing
  // ("how much does...") is not a new topic.
  const scored = coreTokens(tokens);
  const novel = scored.filter((t) => !profile.allTokens.has(t));
  const noveltyRatio = scored.length > 0 ? novel.length / scored.length : 0;
  const excluded = config.excludedLocations.map((l) => l.toLowerCase());
  const targets = config.targetLocations.map((l) => l.toLowerCase());

  // A different location entity is a strong separate-page signal.
  const differentLocation = novel.some(
    (t) => excluded.includes(t) || (targets.length > 0 && targets.includes(t)),
  );
  if (differentLocation) {
    notes.push('Distinct-topic: query targets a location not covered by this page.');
    return { score: 5, unknownQualifier: '' };
  }

  // If the only novelty is a commercial modifier (cost, price, reviews...)
  // or a country qualifier (uk...), the topic is the same — it belongs on or
  // near this page, not on a new one.
  if (
    novel.length > 0 &&
    novel.every(
      (t) => COMMERCIAL_MARKERS.has(t) || INFORMATIONAL_MARKERS.has(t) || GEO_MODIFIERS.has(t),
    )
  ) {
    notes.push(`Distinct-topic: only modifier tokens are new [${novel.join(', ')}].`);
    return { score: 2, unknownQualifier: '' };
  }

  // "{this page's topic} + one unrecognised token" — usually an untargeted
  // town/city or an unrecognised synonym. Not a new-page signal: it gets
  // flagged for the reviewer, who can add a location or a synonym rule.
  const siteTokens = buildSiteProfile(ctx);
  const unknown = novel.filter(
    (t) =>
      !COMMERCIAL_MARKERS.has(t) &&
      !INFORMATIONAL_MARKERS.has(t) &&
      !GEO_MODIFIERS.has(t) &&
      !siteTokens.has(t),
  );
  const rest = scored.filter((t) => !unknown.includes(t));
  if (
    unknown.length === 1 &&
    scored.length >= 2 &&
    rest.length > 0 &&
    rest.every((t) => profile.allTokens.has(t) || COMMERCIAL_MARKERS.has(t) || GEO_MODIFIERS.has(t))
  ) {
    notes.push(
      `Distinct-topic: page topic plus one unrecognised qualifier ("${unknown[0]}").`,
    );
    return { score: 3, unknownQualifier: unknown[0]! };
  }

  let score: number;
  if (noveltyRatio >= 0.5) score = 4;
  else if (noveltyRatio >= 0.25) score = 3;
  else score = 2;
  notes.push(`Distinct-topic: ${novel.length}/${tokens.length} tokens absent from page → ${score}.`);
  return { score, unknownQualifier: '' };
}

function scoreCannibalisation(
  group: QueryGroup,
  tokens: string[],
  profile: PageProfile,
  ctx: ScoringContext,
  notes: string[],
): { risk: number; betterUrl: string } {
  const others = ctx.inventory.filter(
    (p) => normUrl(p.url) !== normUrl(group.url) && p.url.trim() !== '',
  );
  if (others.length === 0) {
    notes.push('Cannibalisation: no site inventory available; risk unknown/none.');
    return { risk: 0, betterUrl: '' };
  }

  const currentCoverage = coverage(tokens, profile.headTokens);

  let bestUrl = '';
  let bestCoverage = 0;
  for (const other of others) {
    const otherTokens = new Set([
      ...contentTokens(other.titleTag),
      ...contentTokens(other.h1),
      ...contentTokens(other.primaryTopic),
    ]);
    const c = coverage(tokens, otherTokens);
    if (c > bestCoverage) {
      bestCoverage = c;
      bestUrl = other.url;
    }
  }

  if (bestCoverage >= 0.99 && bestCoverage > currentCoverage) {
    notes.push(`Cannibalisation: ${bestUrl} fully covers this query group in its title/H1.`);
    return { risk: 5, betterUrl: bestUrl };
  }
  if (bestCoverage >= 0.75 && bestCoverage > currentCoverage) {
    notes.push(`Cannibalisation: ${bestUrl} covers this query group more strongly than the current page.`);
    return { risk: 4, betterUrl: bestUrl };
  }
  if (bestCoverage >= 0.75 && bestCoverage <= currentCoverage) {
    notes.push(`Cannibalisation: ${bestUrl} also targets this topic; current page covers it at least as well.`);
    return { risk: 3, betterUrl: '' };
  }
  if (bestCoverage >= 0.5) {
    notes.push(`Cannibalisation: partial overlap with ${bestUrl}.`);
    return { risk: 2, betterUrl: '' };
  }
  notes.push('Cannibalisation: no meaningful overlap with other known pages.');
  return { risk: 1, betterUrl: '' };
}

function coverage(tokens: string[], against: Set<string>): number {
  if (tokens.length === 0) return 0;
  return tokens.filter((t) => against.has(t)).length / tokens.length;
}

function normUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}
