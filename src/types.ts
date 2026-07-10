/** Shared domain types. Each sheet tab has a matching row type. */

// ---------------------------------------------------------------------------
// Raw GSC data (tab: "GSC Raw")
// ---------------------------------------------------------------------------

export interface GscRawRow {
  url: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  avgPosition: number;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  country?: string;
  device?: string;
  pulledAt: string; // ISO timestamp
}

// ---------------------------------------------------------------------------
// Input URLs (tab: "Input URLs")
// ---------------------------------------------------------------------------

export type PageIntent = 'commercial' | 'informational' | 'navigational' | 'mixed' | '';

export interface InputUrlRow {
  url: string;
  pageType: string;
  primaryTopic: string;
  targetIntent: PageIntent;
  businessPriority: string;
  notes: string;
  lastAnalysed: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Page content (tab: "Page Content")
// ---------------------------------------------------------------------------

export interface PageContentRow {
  url: string;
  httpStatus: number;
  canonicalUrl: string;
  titleTag: string;
  metaDescription: string;
  h1: string;
  h2s: string[];
  bodyText: string;
  wordCount: number;
  lastFetched: string;
}

// ---------------------------------------------------------------------------
// Site inventory (tab: "Site URL Inventory")
// ---------------------------------------------------------------------------

export interface SiteInventoryRow {
  url: string;
  titleTag: string;
  h1: string;
  pageType: string;
  primaryTopic: string;
  targetIntent: PageIntent;
  canonicalUrl: string;
  notes: string;
}

// ---------------------------------------------------------------------------
// Query grouping
// ---------------------------------------------------------------------------

export interface QueryVariant {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  avgPosition: number;
}

export interface QueryGroup {
  url: string;
  /** Sorted content-token signature the group was keyed on. */
  signature: string;
  canonicalQuery: string;
  variants: QueryVariant[];
  totalClicks: number;
  totalImpressions: number;
  /** Impression-weighted average position. */
  weightedAvgPosition: number;
  /** Variant with the best (lowest) average position. */
  bestQuery: string;
  /** Variant with the highest impressions. */
  highestImpressionQuery: string;
  variantCount: number;
  groupingRationale: string;
}

// ---------------------------------------------------------------------------
// Mention detection
// ---------------------------------------------------------------------------

export type MentionType =
  | 'exact'
  | 'close_variant'
  | 'concept_covered'
  | 'not_covered'
  /** Page content could not be fetched — on-page checks were skipped. */
  | 'unknown';

export type MentionLocation = 'title' | 'meta_description' | 'h1' | 'h2' | 'body' | '';

export interface MentionResult {
  mentioned: boolean;
  type: MentionType;
  /** Snippet of page text supporting the match. */
  evidence: string;
  location: MentionLocation;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface GroupScores {
  topicalRelevance: number; // 0-5
  intentMatch: number; // 0-5
  commerciality: number; // 0-5
  distinctTopic: number; // 0-5
  cannibalisationRisk: number; // 0-5
  betterExistingUrl: string;
  /**
   * Set when the query is "{this page's topic} + one unrecognised qualifier"
   * (usually an untargeted town/city, or an unrecognised synonym like
   * "pen" for "penetration"). Such variants are rejected with an explanation
   * rather than spawning per-qualifier new-page ideas.
   */
  unknownQualifier: string;
  /**
   * True when the query's topic words (ignoring commercial/geo modifiers)
   * are all present in the page's title/H1/primary topic — i.e. the query is
   * an undeniable rephrasing of what the page is already about. Only these
   * (or phrases already sitting in body copy) may earn an H2 suggestion.
   */
  headSynonym: boolean;
  scoreNotes: string[];
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export type RecommendationCategory =
  | 'add_to_h2'
  | 'add_to_body'
  | 'add_to_faq'
  | 'new_commercial_page'
  | 'new_supporting_content'
  | 'assign_to_existing_page'
  | 'reject';

export interface AnalysedGroup extends QueryGroup {
  mention: MentionResult;
  scores: GroupScores;
  category: RecommendationCategory;
  rationale: string;
  confidence: number; // 0-1
}

export interface RecommendationRow {
  url: string;
  recommendationType: RecommendationCategory;
  canonicalQueryGroup: string;
  queryVariants: string;
  searchDemandSummary: string;
  suggestedPlacement: string;
  suggestedContentTweak: string;
  existingPageEvidence: string;
  cannibalisationNotes: string;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  // Human review columns — never overwritten by the tool.
  reviewStatus: string;
  reviewerNotes: string;
  correctedRecommendation: string;
  correctedCanonicalQuery: string;
  correctedGroup: string;
  betterUrl: string;
  feedbackReason: string;
  rememberRule: string;
  feedbackScope: string;
}

export interface NewPageIdeaRow {
  suggestedPageIdea: string;
  pageType: string;
  commercialOrInformational: 'commercial' | 'informational';
  sourceUrl: string;
  sourceQueryGroup: string;
  supportingQueryVariants: string;
  totalImpressions: number;
  totalClicks: number;
  suggestedTargetIntent: string;
  whySeparatePage: string;
  cannibalisationCheck: string;
  existingConflictingUrl: string;
  suggestedUrlSlug: string;
  internalLinkingOpportunity: string;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  reviewStatus: string;
  reviewerNotes: string;
}

// ---------------------------------------------------------------------------
// Suggested Edits (tab: "Suggested Edits") — copy-and-paste improvements
// ---------------------------------------------------------------------------

export type SuggestedEditType = 'New H2 section' | 'Body copy' | 'FAQ (H3 questions)';

export interface SuggestedEditRow {
  url: string;
  editType: SuggestedEditType;
  whereOnPage: string;
  suggestedCopy: string;
  keywordsTargeted: string;
  why: string;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  status: string;
  reviewerNotes: string;
}

// ---------------------------------------------------------------------------
// Feedback rules (tab: "Feedback Rules")
// ---------------------------------------------------------------------------

export type FeedbackScope =
  | 'current_recommendation_only'
  | 'current_url'
  | 'sitewide'
  | 'client'
  | 'global';

export type RuleType =
  | 'split_group'
  | 'merge_groups'
  | 'mark_as_distinct_intents'
  | 'mark_as_synonyms'
  | 'change_recommendation'
  | 'assign_to_existing_page'
  | 'mark_irrelevant'
  | 'business_priority_note';

export type RuleStatus = 'active' | 'draft' | 'ignored' | 'deprecated';

export interface FeedbackRule {
  ruleId: string;
  createdAt: string;
  createdBy: string;
  client: string;
  site: string; // site / GSC property
  scope: FeedbackScope;
  ruleType: RuleType;
  phraseA: string;
  phraseB: string;
  queryGroup: string;
  url: string;
  betterUrl: string;
  originalDecision: string;
  correctedDecision: string;
  reason: string;
  status: RuleStatus;
  confidence: number;
  appliesFrom: string;
  appliesUntil: string;
  notes: string;
}

export interface ReviewLogRow {
  timestamp: string;
  user: string;
  url: string;
  queryGroup: string;
  originalDecision: string;
  correctedDecision: string;
  feedbackType: string;
  feedbackReason: string;
  ruleCreated: boolean;
  ruleId: string;
}

// ---------------------------------------------------------------------------
// Config (tab: "Config") — merged with defaults at load time.
// ---------------------------------------------------------------------------

export interface ToolConfig {
  clientName: string;
  website: string;
  gscProperty: string;
  /** Number of months back from today; default 3. */
  monthsBack: number;
  /** Optional explicit range; overrides monthsBack when both set. */
  startDate?: string;
  endDate?: string;
  countryFilter?: string;
  deviceFilter?: string;
  minImpressions: number;
  minClicks: number;
  maxRawQueriesPerUrl: number;
  maxQueryGroupsPerUrl: number;
  llmProvider: 'none' | 'anthropic';
  llmModel: string;
  clientContext: string;
  businessPriorities: string;
  priorityTopics: string[];
  nonPriorityTopics: string[];
  targetLocations: string[];
  excludedLocations: string[];
  targetAudiences: string[];
  excludedAudiences: string[];
  brandPositioning: string;
  approvedTerminology: string[];
  terminologyToAvoid: string[];
}
