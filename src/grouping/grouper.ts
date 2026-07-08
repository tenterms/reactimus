import type { GscRawRow, QueryGroup, QueryVariant } from '../types.js';
import { contentSignature, tokenise } from '../text/normalise.js';
import { FUNCTION_WORDS } from '../config/defaults.js';
import type { CompiledRules } from '../rules/engine.js';

/**
 * Group raw GSC queries into conservative query groups.
 *
 * Queries group ONLY when their content-token signatures are identical —
 * i.e. the same content words after removing grammatical function words and
 * safe singularisation. Semantic similarity is never enough: "it support
 * sheffield" and "it services sheffield" have different signatures and stay
 * separate unless an explicit synonym rule merges them.
 */
export function groupQueries(
  rows: GscRawRow[],
  compiledRules?: CompiledRules,
): QueryGroup[] {
  const byUrl = new Map<string, GscRawRow[]>();
  for (const row of rows) {
    const list = byUrl.get(row.url) ?? [];
    list.push(row);
    byUrl.set(row.url, list);
  }

  const groups: QueryGroup[] = [];
  for (const [url, urlRows] of byUrl) {
    groups.push(...groupForUrl(url, urlRows, compiledRules));
  }
  return groups;
}

interface Bucket {
  signature: string;
  variants: QueryVariant[];
  rationaleParts: Set<string>;
}

function groupForUrl(
  url: string,
  rows: GscRawRow[],
  compiledRules?: CompiledRules,
): QueryGroup[] {
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    let signature = contentSignature(row.query);
    const rationale: string[] = [];

    // split_group rules force specific queries into their own bucket.
    const plain = row.query.toLowerCase().replace(/\s+/g, ' ').trim();
    const splitRuleId = compiledRules?.splitQueries.get(signature + '::' + plain);
    if (splitRuleId) {
      signature = signature + '::split::' + plain;
      rationale.push(`Split into its own group by rule ${splitRuleId}.`);
    } else {
      // Synonym/merge rules rewrite the signature (chains resolved one hop
      // at a time, cycle-guarded).
      const seen = new Set<string>([signature]);
      let directive = compiledRules?.synonymMap.get(signature);
      while (directive) {
        signature = directive.toSignature;
        rationale.push(`Merged by synonym rule ${directive.ruleId}.`);
        if (seen.has(signature)) break;
        seen.add(signature);
        directive = compiledRules?.synonymMap.get(signature);
      }
    }

    const bucket = buckets.get(signature) ?? {
      signature,
      variants: [],
      rationaleParts: new Set<string>(),
    };
    bucket.variants.push({
      query: row.query,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      avgPosition: row.avgPosition,
    });
    for (const r of rationale) bucket.rationaleParts.add(r);
    buckets.set(signature, bucket);
  }

  const groups: QueryGroup[] = [];
  for (const bucket of buckets.values()) {
    groups.push(finaliseGroup(url, bucket, compiledRules));
  }
  // Highest-demand groups first.
  groups.sort((a, b) => b.totalImpressions - a.totalImpressions);
  return groups;
}

function finaliseGroup(url: string, bucket: Bucket, compiledRules?: CompiledRules): QueryGroup {
  const { variants, signature } = bucket;
  const totalClicks = sum(variants.map((v) => v.clicks));
  const totalImpressions = sum(variants.map((v) => v.impressions));
  const weightedAvgPosition =
    totalImpressions > 0
      ? round2(sum(variants.map((v) => v.avgPosition * v.impressions)) / totalImpressions)
      : round2(sum(variants.map((v) => v.avgPosition)) / Math.max(variants.length, 1));

  const best = [...variants].sort((a, b) => a.avgPosition - b.avgPosition)[0]!;
  const highestImpressions = [...variants].sort((a, b) => b.impressions - a.impressions)[0]!;

  const canonical = pickCanonical(variants, compiledRules, signature);

  const rationale =
    variants.length === 1
      ? 'Single query; no near-identical variants found.'
      : `Grouped ${variants.length} near-identical variants sharing content words [${signature
          .split('::')[0]!
          .split('|')
          .join(', ')}]; differences are word order or function words only.`;

  return {
    url,
    signature,
    canonicalQuery: canonical,
    variants: [...variants].sort((a, b) => b.impressions - a.impressions),
    totalClicks,
    totalImpressions,
    weightedAvgPosition,
    bestQuery: best.query,
    highestImpressionQuery: highestImpressions.query,
    variantCount: variants.length,
    groupingRationale: [rationale, ...bucket.rationaleParts].join(' '),
  };
}

/**
 * Canonical query selection priority:
 * 1. highest impressions, 2. highest clicks, 3. cleanest natural wording
 * (fewest function words), 4. shortest phrase. A synonym rule's preferred
 * wording wins outright if one applies to this signature.
 */
export function pickCanonical(
  variants: QueryVariant[],
  compiledRules?: CompiledRules,
  signature?: string,
): string {
  if (compiledRules && signature) {
    for (const directive of compiledRules.synonymMap.values()) {
      if (directive.toSignature === signature && directive.preferredWording) {
        return directive.preferredWording;
      }
    }
  }

  const ranked = [...variants].sort((a, b) => {
    if (b.impressions !== a.impressions) return b.impressions - a.impressions;
    if (b.clicks !== a.clicks) return b.clicks - a.clicks;
    const fnA = functionWordCount(a.query);
    const fnB = functionWordCount(b.query);
    if (fnA !== fnB) return fnA - fnB;
    if (a.query.length !== b.query.length) return a.query.length - b.query.length;
    return a.query.localeCompare(b.query);
  });
  return ranked[0]!.query;
}

function functionWordCount(query: string): number {
  return tokenise(query).filter((t) => FUNCTION_WORDS.has(t)).length;
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
