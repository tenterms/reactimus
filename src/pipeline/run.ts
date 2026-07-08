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
} from '../google/serialise.js';
import { loadConfigFromRows } from '../config/load.js';
import { groupQueries } from '../grouping/grouper.js';
import { detectMention } from '../mentions/detector.js';
import { scoreGroup } from '../scoring/heuristics.js';
import { analyseGroup } from '../classify/decisionRules.js';
import { buildNewPageIdea, buildRecommendation } from '../recommendations/generator.js';
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

  // --- Site inventory: read, and seed missing entries from analysed pages ---
  const inventory = (await store.readTab(TAB.siteInventory))
    .map(inventoryFromRow)
    .filter((i) => i.url);
  const inventoryUrls = new Set(inventory.map((i) => normUrl(i.url)));
  const inputByUrl = new Map(inputs.map((i) => [normUrl(i.url), i]));
  for (const page of pages.values()) {
    if (!inventoryUrls.has(normUrl(page.url))) {
      const meta = inputByUrl.get(normUrl(page.url));
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
    }
  }
  await store.writeTab(TAB.siteInventory, inventory.map(inventoryToRow));

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
    const mention = detectMention(group, page);
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

    analysed.push(analyseGroup(group, scores, mention, compiled));
  }
  log(`Analysed ${analysed.length} query group(s) from ${allRaw.length} raw queries.`);

  // --- Query Groups (computed tab; keep rows for URLs not in this run) ---
  const existingGroups = (await store.readTab(TAB.queryGroups)).filter(
    (r) => r['URL'] && !pulledUrls.has(normUrl(r['URL']!)),
  );
  await store.writeTab(TAB.queryGroups, [...existingGroups, ...analysed.map(analysedGroupToRow)]);

  // --- Recommendations: merge, preserving human review columns ---
  const actionable = analysed.filter((g) => g.category !== 'reject');
  const rejected = analysed.filter((g) => g.category === 'reject');
  const computedRecRows = analysed.map((g) => recommendationToRow(buildRecommendation(g)));
  const existingRecs = await store.readTab(TAB.recommendations);
  const keptOtherUrls = existingRecs.filter(
    (r) => r['URL'] && !pulledUrls.has(normUrl(r['URL']!)),
  );
  const mergedRecs = mergePreservingReviewColumns(
    existingRecs.filter((r) => r['URL'] && pulledUrls.has(normUrl(r['URL']!))),
    computedRecRows,
    groupKey,
    RECOMMENDATION_REVIEW_COLUMNS,
  );
  await store.writeTab(TAB.recommendations, [...keptOtherUrls, ...mergedRecs]);
  log(
    `Recommendations: ${actionable.length} actionable, ${rejected.length} rejected/no-action (review columns preserved).`,
  );

  // --- New Page Ideas ---
  const ideas = analysed
    .map((g) => buildNewPageIdea(g, config))
    .filter((idea): idea is NonNullable<typeof idea> => idea !== null);
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
  log(`New Page Ideas: ${ideas.length} suggestion(s).`);

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
  const recRows = await store.readTab(TAB.recommendations);

  const { rules, logs, processedMarkers } = processFeedback(recRows, {
    client: config.clientName,
    site: config.gscProperty || config.website,
    user,
  });

  if (rules.length === 0 && logs.length === 0) {
    log('No unprocessed reviewer corrections found.');
    return;
  }

  await store.appendRows(TAB.feedbackRules, rules.map(feedbackRuleToRow));
  await store.appendRows(TAB.reviewLog, logs.map(reviewLogToRow));

  // Mark processed rows. "Remember this rule?" is column S (19th) in the
  // Recommendations tab; data rows start at sheet row 2.
  const rememberColumn = 'S';
  for (const { rowIndex, marker } of processedMarkers) {
    await store.updateCell(TAB.recommendations, `${rememberColumn}${rowIndex + 2}`, marker);
  }

  log(`Created ${rules.length} feedback rule(s) and ${logs.length} review log entry(ies).`);
  if (rules.some((r) => r.status === 'draft')) {
    log('Note: global-scope rules were saved as drafts and need admin approval (set Status=active).');
  }
  log('Re-run `npm run analyse` to apply the new rules.');
}
