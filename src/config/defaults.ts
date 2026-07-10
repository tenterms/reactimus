import type { ToolConfig } from '../types.js';

/**
 * Grammatical/function words treated as optional for grouping and mention
 * checks. Dropping one must never change meaning; anything that can act as a
 * modifier (e.g. "near", "best") is deliberately NOT here.
 */
export const FUNCTION_WORDS = new Set([
  'in',
  'for',
  'of',
  'to',
  'the',
  'a',
  'an',
  'and',
  'with',
]);

/**
 * Commercial modifiers. Presence of these tokens signals commercial or
 * transactional intent, and they are always preserved in signatures — two
 * queries differing by one of these are different query groups.
 */
export const COMMERCIAL_MARKERS = new Set([
  'company',
  'companies',
  'services',
  'service',
  'agency',
  'agencies',
  'consultant',
  'consultants',
  'consultancy',
  'consulting',
  'provider',
  'providers',
  'firm',
  'firms',
  'specialist',
  'specialists',
  'contractor',
  'contractors',
  'cost',
  'costs',
  'price',
  'prices',
  'pricing',
  'quote',
  'quotes',
  'best',
  'top',
  'cheap',
  'affordable',
  'reviews',
  'review',
  'hire',
  'buy',
  'near',
  'me',
]);

/**
 * Compound spellings normalised to their spaced form for token comparison.
 * These are spacing variants of the same words (like plural handling), NOT
 * synonyms — "pentest" is "pen test" written together, but "pen" is never
 * merged with "penetration" without an explicit rule.
 */
export const COMPOUND_SPLITS: Record<string, string[]> = {
  cybersecurity: ['cyber', 'security'],
  pentest: ['pen', 'test'],
  pentests: ['pen', 'tests'],
  pentesting: ['pen', 'testing'],
};

/**
 * Country/nation-level qualifiers. Adding one to a query does not make it a
 * new topic for a business serving that whole country ("penetration testing
 * services uk" is the same topic as "penetration testing services") — it is
 * treated like a commercial modifier, not a distinct location entity. City
 * and regional targeting still comes from the Config location lists.
 */
export const GEO_MODIFIERS = new Set([
  'uk',
  'england',
  'scotland',
  'wales',
  'britain',
  'british',
  'ireland',
]);

/** Tokens that signal question-led / informational intent. */
export const INFORMATIONAL_MARKERS = new Set([
  'how',
  'what',
  'why',
  'when',
  'where',
  'which',
  'who',
  'guide',
  'guides',
  'tutorial',
  'tips',
  'examples',
  'example',
  'meaning',
  'definition',
  'vs',
  'versus',
  'difference',
  'checklist',
  'template',
  'ideas',
  'diy',
  'free',
]);

/**
 * Question/filler words that carry no topical meaning. Ignored when scoring
 * topical relevance and intent (NOT when grouping or mention-matching, which
 * stay strict). "it" is deliberately absent — it usually means IT here.
 */
export const QUESTION_STOPWORDS = new Set([
  'how',
  'what',
  'why',
  'when',
  'where',
  'which',
  'who',
  'much',
  'many',
  'do',
  'doe', // singularised "does"
  'does',
  'can',
  'could',
  'should',
  'would',
  'will',
  'is',
  'are',
  'was',
  'be',
  'get',
  'need',
  'i',
  'you',
  'my',
  'your',
  'me',
  'we',
  'us',
  'our',
]);

/**
 * Tokens that signal an intent the page almost never serves (recruitment,
 * account access). Presence forces a very low intent-match score unless the
 * page's own topic contains the token.
 */
export const WRONG_INTENT_MARKERS = new Set([
  'job',
  'jobs',
  'career',
  'careers',
  'vacancy',
  'vacancies',
  'salary',
  'salaries',
  'apprenticeship',
  'apprenticeships',
  'recruitment',
  'intern',
  'internship',
  'login',
  'portal',
]);

/**
 * Tokens exempt from safe singularisation (would change meaning or produce
 * a non-word if the trailing "s" were stripped).
 */
export const SINGULARISE_EXCEPTIONS = new Set([
  'does',
  'goes',
  'gas',
  'sas',
  'saas',
  'ios',
  'aws',
  'gps',
  'sms',
  'dns',
  'vps',
  'cms',
  'plus',
  'lens',
  'news',
  'series',
  'species',
  'analysis',
  'basis',
  'diabetes',
  'physics',
  'mathematics',
  'logistics',
  'analytics',
  'plastics',
  'aerodynamics',
  'wales',
  'leeds',
  'st albans',
  'texas',
  'paris',
  'athens',
  'naples',
  'brussels',
]);

/** Thresholds for the default decision rules. All configurable. */
export interface DecisionThresholds {
  h2MinRelevance: number;
  h2MinIntent: number;
  h2MinCommerciality: number;
  h2MaxDistinct: number;
  h2MaxCannibalisation: number;
  bodyMinRelevance: number;
  bodyMinIntent: number;
  bodyMaxDistinct: number;
  bodyMaxCannibalisation: number;
  supportingMinRelevance: number;
  supportingMinDistinct: number;
  newPageMinCommerciality: number;
  newPageMinDistinct: number;
  newPageMaxCannibalisation: number;
  assignMinCannibalisation: number;
  rejectMaxRelevance: number;
  rejectMaxIntent: number;
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  h2MinRelevance: 4,
  h2MinIntent: 4,
  h2MinCommerciality: 4,
  h2MaxDistinct: 2,
  h2MaxCannibalisation: 2,
  bodyMinRelevance: 4,
  bodyMinIntent: 4,
  bodyMaxDistinct: 2,
  bodyMaxCannibalisation: 2,
  supportingMinRelevance: 3,
  supportingMinDistinct: 3,
  newPageMinCommerciality: 4,
  newPageMinDistinct: 3,
  newPageMaxCannibalisation: 2,
  assignMinCannibalisation: 4,
  rejectMaxRelevance: 2,
  rejectMaxIntent: 2,
};

export const DEFAULT_CONFIG: ToolConfig = {
  clientName: '',
  website: '',
  gscProperty: '',
  monthsBack: 3,
  countryFilter: undefined,
  deviceFilter: undefined,
  minImpressions: 10,
  minClicks: 0,
  maxRawQueriesPerUrl: 250,
  maxQueryGroupsPerUrl: 50,
  llmProvider: 'none',
  llmModel: 'claude-opus-4-8',
  clientContext: '',
  businessPriorities: '',
  priorityTopics: [],
  nonPriorityTopics: [],
  targetLocations: [],
  excludedLocations: [],
  targetAudiences: [],
  excludedAudiences: [],
  brandPositioning: '',
  approvedTerminology: [],
  terminologyToAvoid: [],
};

/**
 * Mention-window slack: how many extra content tokens may sit inside a
 * close-variant window ("professional IT support in Sheffield" matches
 * "IT Support Sheffield" with slack 2).
 */
export const MENTION_WINDOW_SLACK = 2;
