import type {
  AnalysedGroup,
  GscRawRow,
  PageContentRow,
  SiteInventoryRow,
  ToolConfig,
} from '../types.js';
import type { SheetRow } from '../google/sheets.js';
import { mergePreservingReviewColumns } from '../google/sheets.js';
import {
  NEW_PAGE_REVIEW_COLUMNS,
  RECOMMENDATION_REVIEW_COLUMNS,
  SUGGESTED_EDIT_REVIEW_COLUMNS,
  TAB,
} from '../google/schema.js';
import {
  analysedGroupToRow,
  feedbackRuleFromRow,
  feedbackRuleToRow,
  gscRawFromRow,
  gscRawToRow,
  inputUrlFromRow,
  inputUrlToRow,
  inventoryFromRow,
  inventoryToRow,
  newPageIdeaToRow,
  pageContentFromRow,
  pageContentToRow,
  recommendationToRow,
  reviewLogToRow,
  suggestedEditToRow,
} from '../google/serialise.js';
import { loadConfigFromRows } from '../config/load.js';
import { groupQueries } from '../grouping/grouper.js';
import { detectMention } from '../mentions/detector.js';
import { scoreGroup } from '../scoring/heuristics.js';
import { analyseGroup } from '../classify/decisionRules.js';
import { buildNewPageIdea, buildRecommendation } from '../recommendations/generator.js';
import { consolidateNewPageGroups } from '../recommendations/consolidate.js';
import { buildSuggestedEdits } from '../recommendations/suggestedEdits.js';
import { compileRules } from '../rules/engine.js';
import { processFeedback } from '../rules/feedback.js';
import { createLlmAdapter } from '../llm/adapter.js';

/** Storage interface — satisfied by SheetsClient and the in-memory mock. */
export interface DataStore {
  ensureTabs(): Promise<void>;
  readTab(tab: string): Promise<SheetRow[]>;
  writeTab(tab: string, rows: SheetRow[]): Promise<void>;
  appendRows(tab: string, rows: SheetRow[]): Promise<void>;
  updateCell(tab: string, a1: string, value: string): Promise<void>;
}

export interface QuerySource {
  queriesForUrl(config: ToolConfig, url: string): Promise<{ rows: GscRawRow[]; error?: string }>;
}

export type PageFetcher = (url: string) => Promise<PageContentRow>;

export interface PipelineDeps {
  store: DataStore;
  gsc: QuerySource;
  fetchPage: PageFetcher;
  log?: (message: string) => void;
}

const normUrl = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '');
const groupKey = (row: SheetRow) =>
  `${normUrl(row['URL'] ?? '')}##${(row['Canonical query group'] ?? '').trim().toLowerCase()}`;
const ideaKey = (row: SheetRow) =>
  `${normUrl(row['Source URL'] ?? '')}##${(row['Source query group'] ?? '').trim().toLowerCase()}`;

/**
 * Full MVP pipeline: pull GSC data, fetch pages, group, score, classify and
 * write everything back — preserving all human review columns.
 */
export async function runAnalyse(deps: PipelineDeps, options: { pullOnly?: boolean } = {}) {
  const log = deps.log ?? console.log;
  const { store, gsc, fetchPage } = deps;

  await store.ensureTabs();

  const config = loadConfigFromRows(await store.readTab(TAB.config));
  if (!config.gscProperty) {
    log('WARNING: no GSC property configured (Config tab "GSC property" or GSC_PROPERTY env var).');
  }
  log(
    `Client: ${config.clientName || '(unnamed)'} | property: ${config.gscProperty || '(none)'} | window: last ${config.monthsBack} months`,
  );

  const inputs = (await store.readTab(TAB.inputUrls)).map(inputUrlFromRow).filter((i) => i.url);
  if (inputs.length === 0) {
    log('No URLs found in the Input URLs tab — nothing to do.');
    return;
  }

  const rules = (await store.readTab(TAB.feedbackRules)).map(feedbackRuleFromRow);
  const compiled = compileRules(rules, {
    client: config.clientName,
    site: config.gscProperty || config.website,
  });
  const activeRuleCount = rules.filter((r) => r.status === 'active').length;
  log(`Loaded ${rules.length} feedback rule(s); ${activeRuleCount} active.`);

  // --- Pull GSC data + fetch page content per URL ---
  const allRaw: GscRawRow[] = [];
  const pages = new Map<string, PageContentRow>();
  const statuses = new Map<string, string>();

  for (const input of inputs) {
    log(`Pulling GSC queries for ${input.url} ...`);
    const { rows, error } = await gsc.queriesForUrl(config, input.url);
    if (error) {
      statuses.set(input.url, `GSC error: ${error}`);
      log(`  GSC error: ${error}`);
    } else {
      allRaw.push(...rows);
      log(`  ${rows.length} queries (after thresholds).`);
    }

    const page = await fetchPage(input.url);
    pages.set(normUrl(input.url), page);
    if (page.httpStatus !== 200) {
      statuses.set(
        input.url,
        [statuses.get(input.url), `fetch status ${page.httpStatus}`].filter(Boolean).join('; '),
      );
    }
    if (!statuses.has(input.url)) statuses.set(input.url, 'ok');
  }

  // --- GSC Raw: replace rows for pulled URLs, keep other URLs' history ---
  const pulledUrls = new Set(inputs.map((i) => normUrl(i.url)));
  const existingRaw = (await store.readTab(TAB.gscRaw))
    .map(gscRawFromRow)
    .filter((r) => r.url && !pulledUrls.has(normUrl(r.url)));
  await store.writeTab(TAB.gscRaw, [...existingRaw, ...allRaw].map(gscRawToRow));
  log(`GSC Raw: wrote ${allRaw.length} fresh rows (kept ${existingRaw.length} rows for other URLs).`);

  // --- Page Content: upsert by URL ---
  const existingContent = (await store.readTab(TAB.pageContent))
    .map(pageContentFromRow)
    .filter((p) => p.url && !pulledUrls.has(normUrl(p.url)));
  await store.writeTab(
    TAB.pageContent,
    [...existingContent, ...pages.values()].map(pageContentToRow),
  );

  // --- Site inventory: read, seed/refresh entries from successfully
  // fetched pages (failed fetches must not pollute the inventory) ---
  const inventory = (await store.readTab(TAB.siteInventory))
    .map(inventoryFromRow)
    .filter((i) => i.url);
  const inventoryByUrl = new Map(inventory.map((i) => [normUrl(i.url), i]));
  const inputByUrl = new Map(inputs.map((i) => [normUrl(i.url), i]));
  for (const page of pages.values()) {
    if (page.httpStatus !== 200) continue;
    const meta = inputByUrl.get(normUrl(page.url));
    const existing = inventoryByUrl.get(normUrl(page.url));
    if (!existing) {
      inventory.push({
        url: page.url,
        titleTag: page.titleTag,
        h1: page.h1,
        pageType: meta?.pageType ?? '',
        primaryTopic: meta?.primaryTopic ?? '',
        targetIntent: meta?.targetIntent ?? '',
        canonicalUrl: page.canonicalUrl,
        notes: 'auto-added from analysed pages',
      });
    } else if (!existing.titleTag && !existing.h1) {
      existing.titleTag = page.titleTag;
      existing.h1 = page.h1;
      existing.canonicalUrl = existing.canonicalUrl || page.canonicalUrl;
    }
  }
  await store.writeTab(TAB.siteInventory, inventory.map(inventoryToRow));

  const failedPages = [...pages.values()].filter((p) => p.httpStatus !== 200);
  if (failedPages.length > 0) {
    log(
      `WARNING: ${failedPages.length} of ${pages.size} page(s) could not be fetched ` +
        `(${failedPages.map((p) => `${p.url} → HTTP ${p.httpStatus}`).join('; ')}). ` +
        `On-page mention checks are skipped for those URLs and their recommendations are ` +
        `flagged low-confidence. Fix page access before trusting on-page judgements.`,
    );
  }

  const finishInputs = async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await store.writeTab(
      TAB.inputUrls,
      inputs.map((i) =>
        inputUrlToRow({ ...i, lastAnalysed: stamp, status: statuses.get(i.url) ?? 'ok' }),
      ),
    );
  };

  if (options.pullOnly) {
    await finishInputs();
    log('Pull complete (raw data + page content only).');
    return;
  }

  // --- Group, score, classify ---
  const llm = await createLlmAdapter(config);
  if (llm.name !== 'none') log(`LLM adapter enabled: ${llm.name} (${config.llmModel})`);

  const groups = groupQueries(allRaw, compiled);
  const analysed: AnalysedGroup[] = [];

  const perUrlCount = new Map<string, number>();
  for (const group of groups) {
    const key = normUrl(group.url);
    const count = perUrlCount.get(key) ?? 0;
    if (count >= config.maxQueryGroupsPerUrl) continue; // groups are impression-sorted
    perUrlCount.set(key, count + 1);

    const page = pages.get(key);
    if (!page) continue;
    const inputMeta = inputByUrl.get(key);
    const pageUnavailable = page.httpStatus !== 200;
    const mention = pageUnavailable
      ? ({
          mentioned: false,
          type: 'unknown',
          evidence: `page not fetched (HTTP ${page.httpStatus}) — on-page checks skipped`,
          location: '',
        } as const)
      : detectMention(group, page);
    const scores = scoreGroup(group, mention, {
      page,
      inputMeta,
      inventory: inventory as SiteInventoryRow[],
      config,
    });

    const review = await llm.reviewScores({ group, heuristicScores: scores, page, inputMeta, config });
    if (review) {
      scores.topicalRelevance = review.topicalRelevance ?? scores.topicalRelevance;
      scores.intentMatch = review.intentMatch ?? scores.intentMatch;
      scores.commerciality = review.commerciality ?? scores.commerciality;
      scores.distinctTopic = review.distinctTopic ?? scores.distinctTopic;
      scores.cannibalisationRisk = review.cannibalisationRisk ?? scores.cannibalisationRisk;
      if (review.rationale) scores.scoreNotes.push(`LLM: ${review.rationale}`);
    }

    let result = analyseGroup(group, scores, mention, compiled);
    if (pageUnavailable) {
      // Never claim confident on-page judgements about a page we never saw.
      result = {
        ...result,
        confidence: Math.min(result.confidence, 0.4),
        rationale:
          `PAGE CONTENT UNAVAILABLE (HTTP ${page.httpStatus}) — scored from declared topic and ` +
          `site inventory only; verify against the live page. ` +
          result.rationale,
      };
    }
    analysed.push(result);
  }
  log(`Analysed ${analysed.length} query group(s) from ${allRaw.length} raw queries.`);

  // --- Query Groups (computed tab; keep rows for URLs not in this run) ---
  const existingGroups = (await store.readTab(TAB.queryGroups)).filter(
    (r) => r['URL'] && !pulledUrls.has(normUrl(r['URL']!)),
  );
  await store.writeTab(TAB.queryGroups, [...existingGroups, ...analysed.map(analysedGroupToRow)]);

  // --- Consolidate new-page groups into one idea per real-world page ---
  const newPageGroups = analysed.filter(
    (g) => g.category === 'new_commercial_page' || g.category === 'new_supporting_content',
  );
  const clusters = consolidateNewPageGroups(newPageGroups);
  const clusterBySeedlessMember = new Map<string, string>(); // member key -> seed page title
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      clusterBySeedlessMember.set(
        `${normUrl(member.url)}##${member.canonicalQuery.toLowerCase()}`,
        cluster.seed.canonicalQuery,
      );
    }
  }

  // --- Recommendations (actionable) and Rejected (no-action) tabs ---
  const actionable = analysed.filter((g) => g.category !== 'reject');
  const rejected = analysed.filter((g) => g.category === 'reject');

  const toRow = (g: AnalysedGroup) => {
    const rec = buildRecommendation(g);
    const clusterTitle = clusterBySeedlessMember.get(
      `${normUrl(g.url)}##${g.canonicalQuery.toLowerCase()}`,
    );
    if (clusterTitle && clusterTitle !== g.canonicalQuery) {
      rec.suggestedPlacement = `Consolidated into new page idea "${clusterTitle}" (see New Page Ideas)`;
    }
    return recommendationToRow(rec);
  };

  const writeSplitTab = async (tab: string, groups: AnalysedGroup[]) => {
    const existing = await store.readTab(tab);
    const keptOther = existing.filter((r) => r['URL'] && !pulledUrls.has(normUrl(r['URL']!)));
    const merged = mergePreservingReviewColumns(
      existing.filter((r) => r['URL'] && pulledUrls.has(normUrl(r['URL']!))),
      groups.map(toRow),
      groupKey,
      RECOMMENDATION_REVIEW_COLUMNS,
    );
    await store.writeTab(tab, [...keptOther, ...merged]);
  };
  await writeSplitTab(TAB.recommendations, actionable);
  await writeSplitTab(TAB.rejected, rejected);
  log(
    `Recommendations: ${actionable.length} actionable; ${rejected.length} no-action rows moved to the Rejected tab (review columns preserved).`,
  );

  // --- Suggested Edits: copy-and-paste improvements per page ---
  const editKey = (row: SheetRow) =>
    `${normUrl(row['URL'] ?? '')}##${row['Edit type'] ?? ''}##${(row['Suggested copy'] ?? '')
      .split('\n')[0]!
      .trim()
      .toLowerCase()}`;
  const editRows = buildSuggestedEdits(analysed, pages, config).map(suggestedEditToRow);
  const existingEdits = await store.readTab(TAB.suggestedEdits);
  const keptOtherEditUrls = existingEdits.filter(
    (r) => r['URL'] && !pulledUrls.has(normUrl(r['URL']!)),
  );
  const mergedEdits = mergePreservingReviewColumns(
    existingEdits.filter((r) => r['URL'] && pulledUrls.has(normUrl(r['URL']!))),
    editRows,
    editKey,
    SUGGESTED_EDIT_REVIEW_COLUMNS,
    'Status',
  );
  await store.writeTab(TAB.suggestedEdits, [...keptOtherEditUrls, ...mergedEdits]);
  log(`Suggested Edits: ${editRows.length} copy-and-paste edit(s).`);

  // --- New Page Ideas: one row per consolidated cluster ---
  const ideas = clusters.map((c) => buildNewPageIdea(c, config));
  const existingIdeas = await store.readTab(TAB.newPageIdeas);
  const keptOtherIdeaUrls = existingIdeas.filter(
    (r) => r['Source URL'] && !pulledUrls.has(normUrl(r['Source URL']!)),
  );
  const mergedIdeas = mergePreservingReviewColumns(
    existingIdeas.filter((r) => r['Source URL'] && pulledUrls.has(normUrl(r['Source URL']!))),
    ideas.map(newPageIdeaToRow),
    ideaKey,
    NEW_PAGE_REVIEW_COLUMNS,
  );
  await store.writeTab(TAB.newPageIdeas, [...keptOtherIdeaUrls, ...mergedIdeas]);
  log(
    `New Page Ideas: ${ideas.length} consolidated idea(s) from ${newPageGroups.length} query group(s).`,
  );

  await finishInputs();
  log('Analysis complete.');
}

/**
 * Convert reviewer corrections in the Recommendations tab into Feedback
 * Rules + Review Log entries, and mark the rows processed.
 */
export async function runApplyFeedback(deps: Pick<PipelineDeps, 'store' | 'log'>, user: string) {
  const log = deps.log ?? console.log;
  const { store } = deps;

  await store.ensureTabs();
  const config = loadConfigFromRows(await store.readTab(TAB.config));

  // Reviewers can correct rows in both the actionable and rejected tabs
  // (e.g. resurrecting a rejected group with a corrected category).
  let totalRules = 0;
  let totalLogs = 0;
  let hasDrafts = false;
  for (const tab of [TAB.recommendations, TAB.rejected]) {
    const rows = await store.readTab(tab);
    const { rules, logs, processedMarkers } = processFeedback(rows, {
      client: config.clientName,
      site: config.gscProperty || config.website,
      user,
    });
    if (rules.length === 0 && logs.length === 0) continue;

    await store.appendRows(TAB.feedbackRules, rules.map(feedbackRuleToRow));
    await store.appendRows(TAB.reviewLog, logs.map(reviewLogToRow));

    // Mark processed rows. "Remember this rule?" is column S (19th) in both
    // tabs; data rows start at sheet row 2.
    for (const { rowIndex, marker } of processedMarkers) {
      await store.updateCell(tab, `S${rowIndex + 2}`, marker);
    }
    totalRules += rules.length;
    totalLogs += logs.length;
    hasDrafts = hasDrafts || rules.some((r) => r.status === 'draft');
  }

  if (totalRules === 0 && totalLogs === 0) {
    log('No unprocessed reviewer corrections found.');
    return;
  }
  log(`Created ${totalRules} feedback rule(s) and ${totalLogs} review log entry(ies).`);
  if (hasDrafts) {
    log('Note: global-scope rules were saved as drafts and need admin approval (set Status=active).');
  }
  log('Re-run `npm run analyse` to apply the new rules.');
}
