import type { FeedbackRule, FeedbackScope, RecommendationCategory } from '../types.js';
import { contentSignature } from '../text/normalise.js';

/** Broader scopes apply first; more specific scopes override them. */
const SCOPE_SPECIFICITY: Record<FeedbackScope, number> = {
  global: 0,
  client: 1,
  sitewide: 2,
  current_url: 3,
  current_recommendation_only: 4,
};

export interface RuleContext {
  client: string;
  site: string; // website or GSC property
}

function pairKey(a: string, b: string): string {
  return [contentSignature(a), contentSignature(b)].sort().join('~~');
}

/** True if the rule is active, in scope, and inside its date window. */
export function ruleApplies(rule: FeedbackRule, ctx: RuleContext, now = new Date()): boolean {
  if (rule.status !== 'active') return false;
  if (rule.appliesFrom && new Date(rule.appliesFrom) > now) return false;
  if (rule.appliesUntil && new Date(rule.appliesUntil) < now) return false;
  switch (rule.scope) {
    case 'global':
      return true;
    case 'client':
      return !rule.client || eq(rule.client, ctx.client);
    case 'sitewide':
    case 'current_url':
    case 'current_recommendation_only':
      return !rule.site || eq(rule.site, ctx.site) || eq(rule.client, ctx.client);
    default:
      return false;
  }
}

function eq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface SynonymDirective {
  /** Signature to rewrite. */
  fromSignature: string;
  /** Signature it merges into. */
  toSignature: string;
  /** Preferred canonical wording, if given. */
  preferredWording: string;
  ruleId: string;
}

export interface CompiledRules {
  /** sig -> merge directive (after distinct-intent blocking). */
  synonymMap: Map<string, SynonymDirective>;
  /** Pair keys explicitly marked distinct (never merge). */
  distinctPairs: Set<string>;
  /** Normalised queries that must be split into their own group: query sig -> ruleId. */
  splitQueries: Map<string, string>;
  /** url + group sig -> better URL. */
  assignments: Map<string, { betterUrl: string; ruleId: string; reason: string }>;
  /** group sig (optionally scoped to url) -> irrelevant. */
  irrelevant: Map<string, { ruleId: string; reason: string }>;
  /** url + group sig -> corrected category. */
  categoryOverrides: Map<string, { category: RecommendationCategory; ruleId: string; reason: string }>;
  /** Free-text business priority notes, for scoring context / LLM prompts. */
  priorityNotes: FeedbackRule[];
}

function urlGroupKey(url: string, groupSig: string): string {
  return `${url.trim().toLowerCase()}##${groupSig}`;
}

export { urlGroupKey, pairKey };

/**
 * Compile applicable rules into fast lookups. Rules are processed from the
 * broadest scope to the most specific, so a more specific rule for the same
 * pair/group overwrites a broader one — e.g. a client-level synonym rule
 * beats a global distinct-intent default.
 */
export function compileRules(rules: FeedbackRule[], ctx: RuleContext, now = new Date()): CompiledRules {
  const applicable = rules
    .filter((r) => ruleApplies(r, ctx, now))
    .sort((a, b) => {
      const spec = SCOPE_SPECIFICITY[a.scope] - SCOPE_SPECIFICITY[b.scope];
      if (spec !== 0) return spec;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    });

  const compiled: CompiledRules = {
    synonymMap: new Map(),
    distinctPairs: new Set(),
    splitQueries: new Map(),
    assignments: new Map(),
    irrelevant: new Map(),
    categoryOverrides: new Map(),
    priorityNotes: [],
  };

  for (const rule of applicable) {
    switch (rule.ruleType) {
      case 'mark_as_synonyms':
      case 'merge_groups': {
        if (!rule.phraseA || !rule.phraseB) break;
        const key = pairKey(rule.phraseA, rule.phraseB);
        // A more specific (later) synonym rule re-allows a pair a broader
        // rule marked distinct.
        compiled.distinctPairs.delete(key);
        const sigA = contentSignature(rule.phraseA);
        const sigB = contentSignature(rule.phraseB);
        // Merge B into A; phraseA (or the rule's queryGroup field) is the
        // preferred wording.
        compiled.synonymMap.set(sigB, {
          fromSignature: sigB,
          toSignature: sigA,
          preferredWording: rule.queryGroup || rule.phraseA,
          ruleId: rule.ruleId,
        });
        break;
      }
      case 'mark_as_distinct_intents': {
        if (!rule.phraseA || !rule.phraseB) break;
        const key = pairKey(rule.phraseA, rule.phraseB);
        compiled.distinctPairs.add(key);
        // A more specific distinct rule removes a broader synonym mapping.
        const sigA = contentSignature(rule.phraseA);
        const sigB = contentSignature(rule.phraseB);
        for (const sig of [sigA, sigB]) {
          const existing = compiled.synonymMap.get(sig);
          if (
            existing &&
            [existing.fromSignature, existing.toSignature].sort().join('~~') === key
          ) {
            compiled.synonymMap.delete(sig);
          }
        }
        break;
      }
      case 'split_group': {
        // phraseB (or queryGroup) holds the query/queries to split out,
        // separated by ";".
        const queries = (rule.phraseB || rule.queryGroup || '')
          .split(';')
          .map((q) => q.trim())
          .filter(Boolean);
        for (const q of queries) {
          compiled.splitQueries.set(contentSignature(q) + '::' + normalisePlain(q), rule.ruleId);
        }
        break;
      }
      case 'assign_to_existing_page': {
        if (!rule.queryGroup || !rule.betterUrl) break;
        compiled.assignments.set(urlGroupKey(rule.url, contentSignature(rule.queryGroup)), {
          betterUrl: rule.betterUrl,
          ruleId: rule.ruleId,
          reason: rule.reason,
        });
        break;
      }
      case 'mark_irrelevant': {
        if (!rule.queryGroup) break;
        const sig = contentSignature(rule.queryGroup);
        const key = rule.url ? urlGroupKey(rule.url, sig) : sig;
        compiled.irrelevant.set(key, { ruleId: rule.ruleId, reason: rule.reason });
        break;
      }
      case 'change_recommendation': {
        if (!rule.queryGroup || !rule.correctedDecision) break;
        // Back-compat: the category was renamed from assign_to_existing_page.
        const corrected =
          rule.correctedDecision === 'assign_to_existing_page'
            ? 'link_to_existing_page'
            : rule.correctedDecision;
        compiled.categoryOverrides.set(urlGroupKey(rule.url, contentSignature(rule.queryGroup)), {
          category: corrected as RecommendationCategory,
          ruleId: rule.ruleId,
          reason: rule.reason,
        });
        break;
      }
      case 'business_priority_note':
        compiled.priorityNotes.push(rule);
        break;
    }
  }

  return compiled;
}

function normalisePlain(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Look up an irrelevance rule for a group, URL-scoped first then global. */
export function findIrrelevantRule(
  compiled: CompiledRules,
  url: string,
  groupSig: string,
): { ruleId: string; reason: string } | undefined {
  return compiled.irrelevant.get(urlGroupKey(url, groupSig)) ?? compiled.irrelevant.get(groupSig);
}
