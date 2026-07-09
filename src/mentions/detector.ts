import type { MentionLocation, MentionResult, PageContentRow, QueryGroup } from '../types.js';
import { contentTokens, normaliseText, singularise } from '../text/normalise.js';
import { COMPOUND_SPLITS, FUNCTION_WORDS, MENTION_WINDOW_SLACK } from '../config/defaults.js';

/**
 * Flexible phrase matching. A query group counts as mentioned when the page
 * contains:
 *  - exact:          a variant's content words, in that variant's order,
 *                    contiguous apart from function words
 *                    ("IT support in Sheffield" matches "IT Support Sheffield")
 *  - close_variant:  all content words in any order within a small window
 *                    ("our Sheffield IT support team")
 *  - concept_covered: all content words present in the same region but spread
 *                    out — the concept is covered without the phrase
 *
 * Meaningful modifiers are never ignored, so "IT Services Sheffield" cannot
 * match "IT Support Sheffield": the content token "service" != "support".
 */
export function detectMention(group: QueryGroup, page: PageContentRow): MentionResult {
  const regions: Array<{ location: MentionLocation; text: string }> = [
    { location: 'title', text: page.titleTag },
    { location: 'h1', text: page.h1 },
    ...page.h2s.map((h2) => ({ location: 'h2' as MentionLocation, text: h2 })),
    { location: 'meta_description', text: page.metaDescription },
    { location: 'body', text: page.bodyText },
  ];

  const target = contentTokens(group.canonicalQuery);
  if (target.length === 0) {
    return { mentioned: false, type: 'not_covered', evidence: '', location: '' };
  }
  const variantSequences = group.variants.map((v) => contentTokens(v.query));
  variantSequences.push(target);

  let best: MentionResult = { mentioned: false, type: 'not_covered', evidence: '', location: '' };

  for (const region of regions) {
    if (!region.text) continue;
    const result = matchRegion(region.text, target, variantSequences);
    if (result && rank(result) > rank(best)) {
      best = { ...result, location: region.location };
      if (best.type === 'exact') return best; // regions are pre-ordered by priority
    }
  }
  return best;
}

function rank(r: MentionResult | { type: string }): number {
  switch (r.type) {
    case 'exact':
      return 3;
    case 'close_variant':
      return 2;
    case 'concept_covered':
      return 1;
    default:
      return 0;
  }
}

interface RegionMatch {
  mentioned: boolean;
  type: MentionResult['type'];
  evidence: string;
  location: MentionLocation;
}

function matchRegion(
  text: string,
  target: string[],
  variantSequences: string[][],
): RegionMatch | null {
  const rawWords = text.split(/\s+/).filter(Boolean);
  // One raw word can yield multiple tokens ("cybersecurity" -> cyber,
  // security); expanded tokens share the raw index for evidence/adjacency.
  const norm = rawWords.map((w) => {
    const n = normaliseText(w);
    const parts = n ? (COMPOUND_SPLITS[n] ?? [n]).map(singularise) : [];
    return { raw: w, tokens: parts, isFunction: FUNCTION_WORDS.has(n) };
  });

  // Content tokens (non-function, non-empty) with their raw-word indices.
  const contentIdx: number[] = [];
  const contentWords: string[] = [];
  for (let i = 0; i < norm.length; i++) {
    const t = norm[i]!;
    if (t.isFunction) continue;
    for (const token of t.tokens) {
      if (!token) continue;
      contentIdx.push(i);
      contentWords.push(token);
    }
  }

  // --- exact: a variant's content-word sequence, contiguous apart from
  // function words ---
  for (const seq of variantSequences) {
    if (seq.length === 0) continue;
    for (let i = 0; i + seq.length <= contentWords.length; i++) {
      let match = true;
      for (let j = 0; j < seq.length; j++) {
        if (contentWords[i + j] !== seq[j]) {
          match = false;
          break;
        }
      }
      if (match && contiguousApartFromFunctionWords(norm, contentIdx, i, seq.length)) {
        return {
          mentioned: true,
          type: 'exact',
          evidence: snippet(rawWords, contentIdx[i]!, contentIdx[i + seq.length - 1]!),
          location: '',
        };
      }
    }
  }

  // --- close_variant: all target tokens, any order, within a small window ---
  const targetCounts = countTokens(target);
  const maxWindow = target.length + MENTION_WINDOW_SLACK;
  for (let windowLen = target.length; windowLen <= maxWindow; windowLen++) {
    for (let i = 0; i + windowLen <= contentWords.length; i++) {
      const windowCounts = countTokens(contentWords.slice(i, i + windowLen));
      if (containsAll(windowCounts, targetCounts)) {
        return {
          mentioned: true,
          type: 'close_variant',
          evidence: snippet(rawWords, contentIdx[i]!, contentIdx[i + windowLen - 1]!),
          location: '',
        };
      }
    }
  }

  // --- concept_covered: all target tokens somewhere in this region ---
  const regionCounts = countTokens(contentWords);
  if (containsAll(regionCounts, targetCounts)) {
    const firstIdx = contentIdx[contentWords.indexOf(target[0]!)] ?? 0;
    return {
      mentioned: true,
      type: 'concept_covered',
      evidence: snippet(rawWords, firstIdx, Math.min(firstIdx + 12, rawWords.length - 1)),
      location: '',
    };
  }

  return null;
}

/**
 * True when raw indices between the matched content words contain only
 * function words (so "IT support in Sheffield" is contiguous, but
 * "IT support for growing businesses in Sheffield" is not).
 */
function contiguousApartFromFunctionWords(
  norm: Array<{ isFunction: boolean; tokens: string[] }>,
  contentIdx: number[],
  start: number,
  length: number,
): boolean {
  for (let j = 0; j < length - 1; j++) {
    const from = contentIdx[start + j]!;
    const until = contentIdx[start + j + 1]!;
    for (let k = from + 1; k < until; k++) {
      const t = norm[k]!;
      if (t.tokens.length > 0 && !t.isFunction) return false;
    }
  }
  return true;
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

function containsAll(haystack: Map<string, number>, needle: Map<string, number>): boolean {
  for (const [token, count] of needle) {
    if ((haystack.get(token) ?? 0) < count) return false;
  }
  return true;
}

function snippet(rawWords: string[], fromIdx: number, toIdx: number): string {
  const start = Math.max(0, fromIdx - 3);
  const end = Math.min(rawWords.length, toIdx + 4);
  const text = rawWords.slice(start, end).join(' ');
  return (start > 0 ? '…' : '') + text + (end < rawWords.length ? '…' : '');
}
