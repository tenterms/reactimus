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
import { applyLlmDrafts, buildSuggestedEdits } from '../recommendations/suggestedEdits.js';
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

  const allInputs = (await store.readTab(TAB.inputUrls)).map(inputUrlFromRow).filter((i) => i.url);
  if (allInputs.length === 0) {
    log('No URLs found in the Input URLs tab — nothing to do.');
    return;
  }
  // "Include in next run" selector: when any row is ticked, only ticked rows
  // run; when none are, everything runs. Unselected URLs keep all their
  // existing data untouched.
  const isTicked = (v: string) => ['yes', 'y', 'true', '1', 'x', '✓', '✔'].includes(v.trim().toLowerCase());
  const anyTicked = allInputs.some((i) => isTicked(i.include));
  const inputs = anyTicked ? allInputs.filter((i) => isTicked(i.include)) : allInputs;
  if (anyTicked) {
    log(`Selector active: ${inputs.length} of ${allInputs.length} URL(s) ticked "Include in next run".`);
  }
  if (inputs.length === 0) {
    log('No URLs selected — tick "Include in next run" on the rows to analyse.');
    return;
  }

  const rules = (await store.readTab(TAB.feedbackRules)).map(feedbackRuleFromRow);
  const compiled = compileRules(rules, {
    client: config.clientName,
    site: config.gscProperty || config.website,
  });
  const activeRuleCount = rules.filter((r) => r.status === 'active').length;
  log(`Loaded ${rules.length} feedback rule(s); ${activeRuleCount} active.`);

  // --- Pull GSC data (reusing recent pulls) + fetch page content per URL ---
  const priorRaw = (await store.readTab(TAB.gscRaw)).map(gscRawFromRow).filter((r) => r.url);
  const allRaw: GscRawRow[] = [];
  const pages = new Map<string, PageContentRow>();
  const statuses = new Map<string, string>();

  for (const input of inputs) {
    const cached = priorRaw.filter((r) => normUrl(r.url) === normUrl(input.url));
    const newestPull = cached.reduce((max, r) => (r.pulledAt > max ? r.pulledAt : max), '');
    const pullAgeDays = newestPull
      ? (Date.now() - new Date(newestPull).getTime()) / 86_400_000
      : Infinity;

    if (config.reusePullDays > 0 && pullAgeDays <= config.reusePullDays && cached.length > 0) {
      allRaw.push(...cached);
      statuses.set(input.url, `ok (reused GSC pull from ${newestPull.slice(0, 10)})`);
      log(
        `Reusing GSC pull for ${input.url} (pulled ${newestPull.slice(0, 10)}, ${cached.length} queries — under ${config.reusePullDays} days old).`,
      );
    } else {
      log(`Pulling GSC queries for ${input.url} ...`);
      const { rows, error } = await gsc.queriesForUrl(config, input.url);
      if (error) {
        statuses.set(input.url, `GSC error: ${error}`);
        log(`  GSC error: ${error}`);
      } else {
        allRaw.push(...rows);
        log(`  ${rows.length} queries (after thresholds).`);
      }
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
  const existingRaw = priorRaw.filter((r) => !pulledUrls.has(normUrl(r.url)));
  await store.writeTab(TAB.gscRaw, [...existingRaw, ...allRaw].map(gscRawToRow));
  log(`GSC Raw: wrote ${allRaw.length} rows for this run (kept ${existingRaw.length} rows for other URLs).`);

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
    // Write every row back (selection must not drop unselected URLs); stamp
    // only the ones analysed in this run.
    await store.writeTab(
      TAB.inputUrls,
      allInputs.map((i) =>
        pulledUrls.has(normUrl(i.url))
          ? inputUrlToRow({ ...i, lastAnalysed: stamp, status: statuses.get(i.url) ?? 'ok' })
          : inputUrlToRow(i),
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

  // --- Archive: previously-actioned rows move out of the working tabs and
  // suppress re-recommendation of the same item on future runs (delete the
  // Archive row to resurface it) ---
  const TERMINAL_STATUS = new Set([
    'approved',
    'done',
    'actioned',
    'implemented',
    'complete',
    'completed',
    'published',
    'fixed',
  ]);
  const isTerminal = (v: string | undefined) => TERMINAL_STATUS.has((v ?? '').trim().toLowerCase());
  const archivedAt = new Date().toISOString();
  const newArchiveRows: SheetRow[] = [];
  const archiveKey = (sourceTab: string, url: string, item: string) =>
    `${sourceTab}##${normUrl(url)}##${item.trim().toLowerCase()}`;
  const suppressedKeys = new Set(
    (await store.readTab(TAB.archive)).map((r) =>
      archiveKey(r['Source tab'] ?? '', r['URL'] ?? '', r['Item'] ?? ''),
    ),
  );

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

  let suppressedRecCount = 0;
  const writeSplitTab = async (tab: string, groups: AnalysedGroup[], archive: boolean) => {
    const existing = await store.readTab(tab);
    const keptOther = existing.filter((r) => r['URL'] && !pulledUrls.has(normUrl(r['URL']!)));
    let existingPulled = existing.filter((r) => r['URL'] && pulledUrls.has(normUrl(r['URL']!)));
    let rows = groups.map(toRow);

    if (archive) {
      // Move actioned rows to the Archive and remember their keys.
      for (const row of existingPulled) {
        if (!isTerminal(row['Review status'])) continue;
        const item = row['Canonical query group'] ?? '';
        suppressedKeys.add(archiveKey(tab, row['URL'] ?? '', item));
        newArchiveRows.push({
          'Archived at': archivedAt,
          'Source tab': tab,
          URL: row['URL'] ?? '',
          Item: item,
          Type: row['Recommendation type'] ?? '',
          'Review status': row['Review status'] ?? '',
          'Reviewer notes': row['Reviewer notes'] ?? '',
          'Search demand summary': row['Search demand summary'] ?? '',
          Details: row['Suggested content tweak'] ?? '',
        });
      }
      existingPulled = existingPulled.filter((r) => !isTerminal(r['Review status']));
      const before = rows.length;
      rows = rows.filter(
        (r) => !suppressedKeys.has(archiveKey(tab, r['URL'] ?? '', r['Canonical query group'] ?? '')),
      );
      suppressedRecCount += before - rows.length;
    }

    const merged = mergePreservingReviewColumns(existingPulled, rows, groupKey, RECOMMENDATION_REVIEW_COLUMNS);
    await store.writeTab(tab, [...keptOther, ...merged]);
  };
  await writeSplitTab(TAB.recommendations, actionable, true);
  await writeSplitTab(TAB.rejected, rejected, false);
  log(
    `Recommendations: ${actionable.length - suppressedRecCount} actionable; ${rejected.length} no-action rows in the Rejected tab` +
      (suppressedRecCount > 0
        ? `; ${suppressedRecCount} previously-actioned item(s) suppressed (see Archive).`
        : '.'),
  );

  // --- Suggested Edits: copy-and-paste improvements per page ---
  // Keyed by URL + edit type + first targeted keyword — stable across runs
  // even when the (possibly LLM-drafted) copy wording changes.
  const editItem = (row: SheetRow) =>
    `${row['Edit type'] ?? ''} :: ${(row['Keywords targeted'] ?? '').split(';')[0]!.trim().toLowerCase()}`;
  const editKey = (row: SheetRow) => `${normUrl(row['URL'] ?? '')}##${editItem(row)}`;

  const existingEdits = await store.readTab(TAB.suggestedEdits);
  const keptOtherEditUrls = existingEdits.filter(
    (r) => r['URL'] && !pulledUrls.has(normUrl(r['URL']!)),
  );
  let existingPulledEdits = existingEdits.filter(
    (r) => r['URL'] && pulledUrls.has(normUrl(r['URL']!)),
  );
  // Actioned edits move to the Archive and stay suppressed.
  for (const row of existingPulledEdits) {
    if (!isTerminal(row['Status'])) continue;
    suppressedKeys.add(archiveKey(TAB.suggestedEdits, row['URL'] ?? '', editItem(row)));
    newArchiveRows.push({
      'Archived at': archivedAt,
      'Source tab': TAB.suggestedEdits,
      URL: row['URL'] ?? '',
      Item: editItem(row),
      Type: row['Edit type'] ?? '',
      'Review status': row['Status'] ?? '',
      'Reviewer notes': row['Reviewer notes'] ?? '',
      'Search demand summary': row['Keywords targeted'] ?? '',
      Details: row['Suggested copy'] ?? '',
    });
  }
  existingPulledEdits = existingPulledEdits.filter((r) => !isTerminal(r['Status']));

  const suggestedEdits = buildSuggestedEdits(analysed, pages, config);
  const drafted = await applyLlmDrafts(suggestedEdits, pages, config, llm);
  if (drafted > 0) log(`LLM drafted publishable copy for ${drafted}/${suggestedEdits.length} edit(s).`);
  const allEditRows = suggestedEdits.map(suggestedEditToRow);
  const editRows = allEditRows.filter(
    (r) => !suppressedKeys.has(archiveKey(TAB.suggestedEdits, r['URL'] ?? '', editItem(r))),
  );
  const suppressedEditCount = allEditRows.length - editRows.length;

  const mergedEdits = mergePreservingReviewColumns(
    existingPulledEdits,
    editRows,
    editKey,
    SUGGESTED_EDIT_REVIEW_COLUMNS,
    'Status',
  );
  await store.writeTab(TAB.suggestedEdits, [...keptOtherEditUrls, ...mergedEdits]);
  log(
    `Suggested Edits: ${editRows.length} copy-and-paste edit(s)` +
      (suppressedEditCount > 0
        ? `; ${suppressedEditCount} previously-actioned edit(s) suppressed (see Archive).`
        : '.'),
  );

  if (newArchiveRows.length > 0) {
    await store.appendRows(TAB.archive, newArchiveRows);
    log(`Archive: moved ${newArchiveRows.length} actioned row(s) out of the working tabs.`);
  }

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
