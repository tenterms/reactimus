import { COMPOUND_SPLITS, FUNCTION_WORDS, SINGULARISE_EXCEPTIONS } from '../config/defaults.js';

/**
 * Normalise a raw query or text fragment:
 * lowercase, strip punctuation, collapse whitespace.
 */
export function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[‘’']/g, '') // drop apostrophes: sheffield's -> sheffields (singularised later)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // any other punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Safe singularisation of regular English plurals only. Conservative by
 * design: irregular plurals and exception-list tokens pass through
 * unchanged. Grouping "IT service" with "IT services" is safe; grouping
 * "support" with "supports" is handled the same way.
 */
export function singularise(token: string): string {
  if (SINGULARISE_EXCEPTIONS.has(token)) return token;
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) {
    return token.slice(0, -3) + 'y'; // agencies -> agency
  }
  if (/(?:ses|xes|zes|ches|shes)$/.test(token)) {
    return token.slice(0, -2); // boxes -> box, churches -> church
  }
  if (token.endsWith('ss') || token.endsWith('us') || token.endsWith('is')) {
    return token; // business, status, analysis
  }
  if (token.endsWith('s')) {
    return token.slice(0, -1); // services -> service
  }
  return token;
}

/** Tokenise normalised text into words, splitting known compound spellings. */
export function tokenise(text: string): string[] {
  const normalised = normaliseText(text);
  if (!normalised) return [];
  return normalised.split(' ').flatMap((t) => COMPOUND_SPLITS[t] ?? [t]);
}

export interface TokenOptions {
  /** Drop grammatical function words (in/for/of/...). Default true. */
  dropFunctionWords?: boolean;
  /** Apply safe singularisation. Default true. */
  singularise?: boolean;
}

/**
 * Content tokens of a phrase: normalised, function words removed,
 * safely singularised. These are the atoms used for grouping signatures
 * and mention matching.
 */
export function contentTokens(text: string, options: TokenOptions = {}): string[] {
  const { dropFunctionWords = true, singularise: doSingularise = true } = options;
  let tokens = tokenise(text);
  if (dropFunctionWords) {
    const kept = tokens.filter((t) => !FUNCTION_WORDS.has(t));
    // Never reduce a phrase to nothing: if the query is all function words,
    // keep it verbatim.
    if (kept.length > 0) tokens = kept;
  }
  if (doSingularise) {
    tokens = tokens.map(singularise);
  }
  return tokens;
}

/**
 * Content-token signature: the sorted multiset of content tokens joined
 * with "|". Two queries group together iff their signatures are identical.
 */
export function contentSignature(text: string, options: TokenOptions = {}): string {
  return [...contentTokens(text, options)].sort().join('|');
}
