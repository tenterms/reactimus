import type { FeedbackRule, FeedbackScope, ReviewLogRow, RuleType } from '../types.js';
import type { SheetRow } from '../google/sheets.js';

export interface FeedbackContext {
  client: string;
  site: string;
  user: string;
  now?: Date;
}

export interface ProcessedFeedback {
  rules: FeedbackRule[];
  logs: ReviewLogRow[];
  /** 0-based index into the data rows → new "Remember this rule?" cell value. */
  processedMarkers: Array<{ rowIndex: number; marker: string }>;
}

const SCOPE_ALIASES: Record<string, FeedbackScope> = {
  current_recommendation_only: 'current_recommendation_only',
  'current recommendation only': 'current_recommendation_only',
  'this recommendation': 'current_recommendation_only',
  current_url: 'current_url',
  'current url': 'current_url',
  url: 'current_url',
  sitewide: 'sitewide',
  site: 'sitewide',
  client: 'client',
  global: 'global',
};

function parseScope(value: string): FeedbackScope {
  return SCOPE_ALIASES[value.trim().toLowerCase()] ?? 'sitewide';
}

function truthy(value: string): boolean {
  return ['yes', 'y', 'true', '1'].includes(value.trim().toLowerCase());
}

/**
 * Turn reviewer edits in the Recommendations tab into feedback rules and
 * review-log entries.
 *
 * A row is actionable when the reviewer filled any correction column. The
 * "Corrected group" column supports three directives for grouping feedback:
 *   split: query one; query two        → split_group
 *   merge: phrase a | phrase b         → mark_as_synonyms (preferred wording =
 *                                        Corrected canonical query or phrase a)
 *   distinct: phrase a | phrase b      → mark_as_distinct_intents
 *
 * Rules are only created when "Remember this rule?" is yes; otherwise the
 * correction is logged for the audit trail but applies to nothing else.
 * Processed rows are marked (saved:<ruleId> / logged) so a re-run never
 * duplicates rules. Original decisions are always preserved in the log.
 */
export function processFeedback(rows: SheetRow[], ctx: FeedbackContext): ProcessedFeedback {
  const now = ctx.now ?? new Date();
  const timestamp = now.toISOString();
  const result: ProcessedFeedback = { rules: [], logs: [], processedMarkers: [] };
  let counter = 0;

  const nextRuleId = () =>
    `R-${now.getTime().toString(36).toUpperCase()}-${(++counter).toString().padStart(2, '0')}`;

  rows.forEach((row, rowIndex) => {
    const remember = row['Remember this rule?'] ?? '';
    // Already processed on a previous run.
    if (/^(saved:|logged)/i.test(remember.trim())) return;

    const correctedRec = (row['Corrected recommendation'] ?? '').trim();
    const correctedGroup = (row['Corrected group'] ?? '').trim();
    const correctedCanonical = (row['Corrected canonical query'] ?? '').trim();
    const betterUrl = (row['Better URL'] ?? '').trim();
    const reviewStatus = (row['Review status'] ?? '').trim().toLowerCase();
    const reason = (row['Feedback reason'] ?? '').trim();
    const scope = parseScope(row['Feedback scope'] ?? '');
    const url = (row['URL'] ?? '').trim();
    const queryGroup = (row['Canonical query group'] ?? '').trim();
    const original = (row['Recommendation type'] ?? '').trim();

    const rejected = reviewStatus === 'rejected' || correctedRec.toLowerCase() === 'reject';
    const hasCorrection = !!(correctedRec || correctedGroup || betterUrl || rejected);
    if (!hasCorrection) return;

    const shouldRemember = truthy(remember);

    // Derive the rule from the most specific correction present.
    let ruleType: RuleType;
    let phraseA = '';
    let phraseB = '';
    let correctedDecision = correctedRec;

    const directive = correctedGroup.match(/^(split|merge|distinct)\s*:\s*(.+)$/i);
    if (directive) {
      const [, kind, payload] = directive;
      const parts = payload!.split('|').map((s) => s.trim()).filter(Boolean);
      switch (kind!.toLowerCase()) {
        case 'split':
          ruleType = 'split_group';
          phraseB = payload!.trim(); // semicolon-separated queries to split out
          break;
        case 'merge':
          ruleType = 'mark_as_synonyms';
          phraseA = correctedCanonical || parts[0] || '';
          phraseB = parts[1] ?? parts[0] ?? '';
          break;
        default:
          ruleType = 'mark_as_distinct_intents';
          phraseA = parts[0] ?? '';
          phraseB = parts[1] ?? '';
      }
    } else if (betterUrl) {
      ruleType = 'assign_to_existing_page';
      correctedDecision = 'link_to_existing_page';
    } else if (rejected) {
      ruleType = 'mark_irrelevant';
      correctedDecision = 'reject';
    } else {
      ruleType = 'change_recommendation';
    }

    let ruleId = '';
    if (shouldRemember) {
      ruleId = nextRuleId();
      result.rules.push({
        ruleId,
        createdAt: timestamp,
        createdBy: ctx.user,
        client: ctx.client,
        site: ctx.site,
        scope,
        ruleType,
        phraseA,
        phraseB,
        queryGroup: correctedCanonical || queryGroup,
        url: scope === 'current_url' || scope === 'current_recommendation_only' ? url : url,
        betterUrl,
        originalDecision: original,
        correctedDecision,
        reason,
        status: scope === 'global' ? 'draft' : 'active', // global rules need admin approval
        confidence: 1,
        appliesFrom: '',
        appliesUntil: '',
        notes:
          scope === 'global'
            ? 'Created as draft: global scope requires admin approval before activation.'
            : '',
      });
    }

    result.logs.push({
      timestamp,
      user: ctx.user,
      url,
      queryGroup,
      originalDecision: original,
      correctedDecision: correctedDecision || (betterUrl ? `assign to ${betterUrl}` : ''),
      feedbackType: ruleType,
      feedbackReason: reason,
      ruleCreated: shouldRemember,
      ruleId,
    });

    result.processedMarkers.push({
      rowIndex,
      marker: shouldRemember ? `saved:${ruleId}` : 'logged',
    });
  });

  return result;
}
