import type { AnalysedGroup } from '../types.js';
import { contentTokens } from '../text/normalise.js';
import {
  COMMERCIAL_MARKERS,
  GEO_MODIFIERS,
  INFORMATIONAL_MARKERS,
  QUESTION_STOPWORDS,
} from '../config/defaults.js';

/**
 * A cluster of new-page query groups that would realistically live on the
 * same new page. The seed is the highest-demand group and names the page.
 */
export interface NewPageCluster {
  seed: AnalysedGroup;
  members: AnalysedGroup[]; // includes the seed
  totalImpressions: number;
  totalClicks: number;
}

/**
 * Theme tokens of a group: the topic words that define what a page about
 * this query would cover. Commercial modifiers (services/company/best...),
 * country qualifiers and question words are stripped; locations are kept,
 * because a Sheffield page and a Newcastle page are different pages.
 */
export function themeTokens(canonicalQuery: string): Set<string> {
  const tokens = contentTokens(canonicalQuery).filter(
    (t) =>
      !COMMERCIAL_MARKERS.has(t) &&
      !GEO_MODIFIERS.has(t) &&
      !QUESTION_STOPWORDS.has(t) &&
      !INFORMATIONAL_MARKERS.has(t),
  );
  return new Set(tokens.length > 0 ? tokens : contentTokens(canonicalQuery));
}

function similar(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  // Subset either way (e.g. {vciso} ⊆ {vciso, security}) or majority token
  // overlap. Strictly greater than 0.5, so "cyber security sheffield" vs
  // "cyber security newcastle" (Jaccard exactly 0.5) stay separate pages.
  if (shared === a.size || shared === b.size) return true;
  return shared / (a.size + b.size - shared) > 0.5;
}

/**
 * Consolidate new-page query groups into one page idea per real-world page.
 * Greedy: highest-demand group seeds a cluster; later groups join the first
 * cluster whose theme they share. Commercial and informational groups never
 * mix (they'd be different pages by definition).
 */
export function consolidateNewPageGroups(groups: AnalysedGroup[]): NewPageCluster[] {
  const sorted = [...groups].sort((a, b) => b.totalImpressions - a.totalImpressions);
  const clusters: Array<NewPageCluster & { theme: Set<string> }> = [];

  for (const group of sorted) {
    const theme = themeTokens(group.canonicalQuery);
    const home = clusters.find(
      (c) => c.seed.category === group.category && similar(c.theme, theme),
    );
    if (home) {
      home.members.push(group);
      home.totalImpressions += group.totalImpressions;
      home.totalClicks += group.totalClicks;
      // Widen the cluster theme so chains like {vciso} -> {vciso, security}
      // -> {vciso, security, healthcare} keep attracting related groups.
      for (const t of theme) home.theme.add(t);
    } else {
      clusters.push({
        seed: group,
        members: [group],
        totalImpressions: group.totalImpressions,
        totalClicks: group.totalClicks,
        theme,
      });
    }
  }

  return clusters.map(({ seed, members, totalImpressions, totalClicks }) => ({
    seed,
    members,
    totalImpressions,
    totalClicks,
  }));
}
