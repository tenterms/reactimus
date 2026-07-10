import type {
  AnalysedGroup,
  FeedbackRule,
  GscRawRow,
  InputUrlRow,
  NewPageIdeaRow,
  PageContentRow,
  PageIntent,
  RecommendationRow,
  ReviewLogRow,
  SiteInventoryRow,
} from '../types.js';
import type { SheetRow } from './sheets.js';

const num = (v: string | undefined): number => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
};

// --- Input URLs ---

export function inputUrlFromRow(row: SheetRow): InputUrlRow {
  return {
    url: (row['URL'] ?? '').trim(),
    pageType: row['Page type'] ?? '',
    primaryTopic: row['Primary topic'] ?? '',
    targetIntent: ((row['Target intent'] ?? '').toLowerCase() as PageIntent) || '',
    businessPriority: row['Business priority'] ?? '',
    notes: row['Notes'] ?? '',
    lastAnalysed: row['Last analysed'] ?? '',
    status: row['Status'] ?? '',
  };
}

export function inputUrlToRow(input: InputUrlRow): SheetRow {
  return {
    URL: input.url,
    'Page type': input.pageType,
    'Primary topic': input.primaryTopic,
    'Target intent': input.targetIntent,
    'Business priority': input.businessPriority,
    Notes: input.notes,
    'Last analysed': input.lastAnalysed,
    Status: input.status,
  };
}

// --- GSC Raw ---

export function gscRawToRow(r: GscRawRow): SheetRow {
  return {
    URL: r.url,
    Query: r.query,
    Clicks: String(r.clicks),
    Impressions: String(r.impressions),
    CTR: String(r.ctr),
    'Average position': String(r.avgPosition),
    'Start date': r.startDate,
    'End date': r.endDate,
    Country: r.country ?? '',
    Device: r.device ?? '',
    'Pulled at': r.pulledAt,
  };
}

export function gscRawFromRow(row: SheetRow): GscRawRow {
  return {
    url: row['URL'] ?? '',
    query: row['Query'] ?? '',
    clicks: num(row['Clicks']),
    impressions: num(row['Impressions']),
    ctr: num(row['CTR']),
    avgPosition: num(row['Average position']),
    startDate: row['Start date'] ?? '',
    endDate: row['End date'] ?? '',
    country: row['Country'] || undefined,
    device: row['Device'] || undefined,
    pulledAt: row['Pulled at'] ?? '',
  };
}

// --- Page Content ---

export function pageContentToRow(p: PageContentRow): SheetRow {
  return {
    URL: p.url,
    'HTTP status': String(p.httpStatus),
    'Canonical URL': p.canonicalUrl,
    'Title tag': p.titleTag,
    'Meta description': p.metaDescription,
    H1: p.h1,
    H2s: p.h2s.join(' | '),
    // Sheets cells cap at 50k chars; body text is for auditing, not full archival.
    'Body text': p.bodyText.slice(0, 45000),
    'Word count': String(p.wordCount),
    'Last fetched': p.lastFetched,
  };
}

export function pageContentFromRow(row: SheetRow): PageContentRow {
  return {
    url: row['URL'] ?? '',
    httpStatus: num(row['HTTP status']),
    canonicalUrl: row['Canonical URL'] ?? '',
    titleTag: row['Title tag'] ?? '',
    metaDescription: row['Meta description'] ?? '',
    h1: row['H1'] ?? '',
    h2s: (row['H2s'] ?? '').split(' | ').filter(Boolean),
    bodyText: row['Body text'] ?? '',
    wordCount: num(row['Word count']),
    lastFetched: row['Last fetched'] ?? '',
  };
}

// --- Site URL Inventory ---

export function inventoryFromRow(row: SheetRow): SiteInventoryRow {
  return {
    url: (row['URL'] ?? '').trim(),
    titleTag: row['Title tag'] ?? '',
    h1: row['H1'] ?? '',
    pageType: row['Page type'] ?? '',
    primaryTopic: row['Primary topic'] ?? '',
    targetIntent: ((row['Target intent'] ?? '').toLowerCase() as PageIntent) || '',
    canonicalUrl: row['Canonical URL'] ?? '',
    notes: row['Notes'] ?? '',
  };
}

export function inventoryToRow(inv: SiteInventoryRow): SheetRow {
  return {
    URL: inv.url,
    'Title tag': inv.titleTag,
    H1: inv.h1,
    'Page type': inv.pageType,
    'Primary topic': inv.primaryTopic,
    'Target intent': inv.targetIntent,
    'Canonical URL': inv.canonicalUrl,
    Notes: inv.notes,
  };
}

// --- Query Groups ---

export function analysedGroupToRow(g: AnalysedGroup): SheetRow {
  return {
    URL: g.url,
    'Canonical query group': g.canonicalQuery,
    'Query variants': g.variants.map((v) => v.query).join('; '),
    'Total clicks': String(g.totalClicks),
    'Total impressions': String(g.totalImpressions),
    'Weighted average position': String(g.weightedAvgPosition),
    'Best query variant': g.bestQuery,
    'Highest-impression query variant': g.highestImpressionQuery,
    'Variant count': String(g.variantCount),
    'Grouping rationale': g.groupingRationale,
    'Already mentioned on page?': g.mention.mentioned ? 'yes' : 'no',
    'Mention type': g.mention.type,
    'Mention evidence': g.mention.evidence,
    'Mention location': g.mention.location,
    'Topical relevance score': String(g.scores.topicalRelevance),
    'Intent match score': String(g.scores.intentMatch),
    'Commerciality score': String(g.scores.commerciality),
    'Distinct-topic score': String(g.scores.distinctTopic),
    'Cannibalisation risk score': String(g.scores.cannibalisationRisk),
    'Better existing URL': g.scores.betterExistingUrl,
    'Recommendation category': g.category,
    Rationale: g.rationale,
    Confidence: g.confidence.toFixed(2),
  };
}

// --- Recommendations ---

export function recommendationToRow(r: RecommendationRow): SheetRow {
  return {
    URL: r.url,
    'Recommendation type': r.recommendationType,
    'Canonical query group': r.canonicalQueryGroup,
    'Query variants': r.queryVariants,
    'Search demand summary': r.searchDemandSummary,
    'Suggested placement': r.suggestedPlacement,
    'Suggested content tweak': r.suggestedContentTweak,
    'Existing page evidence': r.existingPageEvidence,
    'Cannibalisation notes': r.cannibalisationNotes,
    Priority: r.priority,
    Confidence: r.confidence.toFixed(2),
    'Review status': r.reviewStatus,
    'Reviewer notes': r.reviewerNotes,
    'Corrected recommendation': r.correctedRecommendation,
    'Corrected canonical query': r.correctedCanonicalQuery,
    'Corrected group': r.correctedGroup,
    'Better URL': r.betterUrl,
    'Feedback reason': r.feedbackReason,
    'Remember this rule?': r.rememberRule,
    'Feedback scope': r.feedbackScope,
  };
}

// --- New Page Ideas ---

export function newPageIdeaToRow(n: NewPageIdeaRow): SheetRow {
  return {
    'Suggested page idea': n.suggestedPageIdea,
    'Page type': n.pageType,
    'Commercial or informational': n.commercialOrInformational,
    'Source URL': n.sourceUrl,
    'Source query group': n.sourceQueryGroup,
    'Supporting query variants': n.supportingQueryVariants,
    'Total impressions': String(n.totalImpressions),
    'Total clicks': String(n.totalClicks),
    'Suggested target intent': n.suggestedTargetIntent,
    'Why this should be a separate page': n.whySeparatePage,
    'Cannibalisation check': n.cannibalisationCheck,
    'Existing conflicting URL': n.existingConflictingUrl,
    'Suggested URL slug': n.suggestedUrlSlug,
    'Internal linking opportunity': n.internalLinkingOpportunity,
    Priority: n.priority,
    Confidence: n.confidence.toFixed(2),
    'Review status': n.reviewStatus,
    'Reviewer notes': n.reviewerNotes,
  };
}

// --- Suggested Edits ---

export function suggestedEditToRow(e: import('../types.js').SuggestedEditRow): SheetRow {
  return {
    URL: e.url,
    'Edit type': e.editType,
    'Where on the page': e.whereOnPage,
    'Suggested copy': e.suggestedCopy,
    'Keywords targeted': e.keywordsTargeted,
    Why: e.why,
    Priority: e.priority,
    Confidence: e.confidence.toFixed(2),
    Status: e.status,
    'Reviewer notes': e.reviewerNotes,
  };
}

// --- Feedback Rules ---

export function feedbackRuleFromRow(row: SheetRow): FeedbackRule {
  return {
    ruleId: row['Rule ID'] ?? '',
    createdAt: row['Created at'] ?? '',
    createdBy: row['Created by'] ?? '',
    client: row['Client'] ?? '',
    site: row['Site / GSC property'] ?? '',
    scope: ((row['Scope'] ?? 'sitewide').trim() as FeedbackRule['scope']) || 'sitewide',
    ruleType: (row['Rule type'] ?? '').trim() as FeedbackRule['ruleType'],
    phraseA: row['Phrase A'] ?? '',
    phraseB: row['Phrase B'] ?? '',
    queryGroup: row['Query group'] ?? '',
    url: row['URL'] ?? '',
    betterUrl: row['Better URL'] ?? '',
    originalDecision: row['Original decision'] ?? '',
    correctedDecision: row['Corrected decision'] ?? '',
    reason: row['Reason'] ?? '',
    status: ((row['Status'] ?? 'active').trim().toLowerCase() as FeedbackRule['status']) || 'active',
    confidence: num(row['Confidence']) || 1,
    appliesFrom: row['Applies from'] ?? '',
    appliesUntil: row['Applies until'] ?? '',
    notes: row['Notes'] ?? '',
  };
}

export function feedbackRuleToRow(rule: FeedbackRule): SheetRow {
  return {
    'Rule ID': rule.ruleId,
    'Created at': rule.createdAt,
    'Created by': rule.createdBy,
    Client: rule.client,
    'Site / GSC property': rule.site,
    Scope: rule.scope,
    'Rule type': rule.ruleType,
    'Phrase A': rule.phraseA,
    'Phrase B': rule.phraseB,
    'Query group': rule.queryGroup,
    URL: rule.url,
    'Better URL': rule.betterUrl,
    'Original decision': rule.originalDecision,
    'Corrected decision': rule.correctedDecision,
    Reason: rule.reason,
    Status: rule.status,
    Confidence: String(rule.confidence),
    'Applies from': rule.appliesFrom,
    'Applies until': rule.appliesUntil,
    Notes: rule.notes,
  };
}

// --- Review Log ---

export function reviewLogToRow(log: ReviewLogRow): SheetRow {
  return {
    Timestamp: log.timestamp,
    User: log.user,
    URL: log.url,
    'Query group': log.queryGroup,
    'Original decision': log.originalDecision,
    'Corrected decision': log.correctedDecision,
    'Feedback type': log.feedbackType,
    'Feedback reason': log.feedbackReason,
    'Rule created?': log.ruleCreated ? 'yes' : 'no',
    'Rule ID': log.ruleId,
  };
}
