import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { SheetsClient } from './google/sheets.js';
import { GscClient } from './google/gsc.js';
import { fetchPageContent } from './content/fetcher.js';
import { fetchSitemapUrls } from './inventory/sitemap.js';
import { runAnalyse, runApplyFeedback } from './pipeline/run.js';
import { TAB } from './google/schema.js';
import { pageToRow } from './google/serialise.js';
import { MemoryStore } from './mocks/memoryStore.js';
import { DEMO_SEED, MockGscClient, mockFetchPage } from './mocks/fixtures.js';

const USAGE = `Usage:
  npm run analyse [-- <client|sheet-id>]   Full pipeline (client names resolve via clients.json)
  npm run pull [-- <client|sheet-id>]      Pull GSC raw data + page content only
  npm run inventory -- <sitemap-url> [client|sheet-id]   Import site URLs into the Pages tab (unticked)
  npm run apply-feedback [-- <client|sheet-id>]  Convert reviewer corrections into rules
  npm run demo            Run the full pipeline offline against mock data (no credentials needed)

Environment (see .env.example):
  SPREADSHEET_ID, GOOGLE_APPLICATION_CREDENTIALS (or inline service-account vars),
  optionally GSC_PROPERTY, LLM_PROVIDER/ANTHROPIC_API_KEY.`;

/**
 * Resolve the target spreadsheet, enabling one deployment for many clients:
 *   npm run analyse -- <client-name>   (looked up in clients.json)
 *   npm run analyse -- <spreadsheet-id>
 *   npm run analyse                    (SPREADSHEET_ID env var)
 * clients.json (gitignored) maps names to sheet IDs:
 *   { "cyberalchemy": "1qNL...", "acme": "1AbC..." }
 */
function requireSpreadsheet(sheetOrClient?: string): SheetsClient {
  let id = sheetOrClient?.trim() || process.env.SPREADSHEET_ID || '';
  if (sheetOrClient && existsSync('clients.json')) {
    try {
      const clients = JSON.parse(readFileSync('clients.json', 'utf8')) as Record<string, string>;
      const match = Object.entries(clients).find(
        ([name]) => name.toLowerCase() === sheetOrClient.trim().toLowerCase(),
      );
      if (match) {
        id = match[1]!;
        console.log(`Client "${match[0]}" -> spreadsheet ${id}`);
      }
    } catch (err) {
      console.error(`Could not parse clients.json: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  if (!id) {
    console.error(
      'No spreadsheet: pass a client name / spreadsheet ID (npm run analyse -- <name|id>) or set SPREADSHEET_ID.',
    );
    process.exit(1);
  }
  return new SheetsClient(id);
}

async function main() {
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case 'analyse':
    case 'analyze': {
      await runAnalyse({ store: requireSpreadsheet(arg), gsc: new GscClient(), fetchPage: fetchPageContent });
      break;
    }

    case 'pull': {
      await runAnalyse(
        { store: requireSpreadsheet(arg), gsc: new GscClient(), fetchPage: fetchPageContent },
        { pullOnly: true },
      );
      break;
    }

    case 'inventory': {
      if (!arg) {
        console.error('Provide a sitemap URL: npm run inventory -- https://example.com/sitemap.xml');
        process.exit(1);
      }
      const store = requireSpreadsheet(process.argv[4]);
      await store.ensureTabs();
      const urls = await fetchSitemapUrls(arg);
      console.log(`Sitemap yielded ${urls.length} URLs. Fetching titles/H1s (this can take a while)...`);
      const existing = await store.readTab(TAB.pages);
      const known = new Set(existing.map((r) => (r['URL'] ?? '').trim().toLowerCase().replace(/\/+$/, '')));
      const fresh = [];
      for (const url of urls) {
        if (known.has(url.trim().toLowerCase().replace(/\/+$/, ''))) continue;
        const page = await fetchPageContent(url);
        fresh.push(
          pageToRow({
            url,
            include: '',
            titleTag: page.titleTag,
            h1: page.h1,
            pageType: '',
            primaryTopic: '',
            targetIntent: '',
            canonicalUrl: page.canonicalUrl,
            businessPriority: '',
            notes: 'imported from sitemap',
            lastAnalysed: '',
            status: '',
          }),
        );
        process.stdout.write('.');
      }
      console.log('');
      await store.appendRows(TAB.pages, fresh);
      console.log(`Added ${fresh.length} new URLs to the Pages tab (unticked).`);
      break;
    }

    case 'apply-feedback': {
      const user = process.env.FEEDBACK_USER || process.env.USER || 'unknown';
      await runApplyFeedback({ store: requireSpreadsheet(arg) }, user);
      break;
    }

    case 'demo': {
      const store = new MemoryStore(DEMO_SEED);
      await runAnalyse({ store, gsc: new MockGscClient(), fetchPage: mockFetchPage });

      console.log('\n=== Recommendations (offline demo output) ===');
      for (const row of await store.readTab(TAB.recommendations)) {
        console.log(
          `\n[${row['Recommendation type']}] ${row['Canonical query group']}  (priority: ${row['Priority']}, confidence: ${row['Confidence']})`,
        );
        console.log(`  demand:   ${row['Search demand summary']}`);
        console.log(`  action:   ${row['Suggested content tweak']}`);
        if (row['Existing page evidence']) console.log(`  evidence: ${row['Existing page evidence']}`);
        if (row['Cannibalisation notes']) console.log(`  cannibal: ${row['Cannibalisation notes']}`);
      }

      const ideas = await store.readTab(TAB.newPageIdeas);
      if (ideas.length) {
        console.log('\n=== New Page Ideas ===');
        for (const idea of ideas) {
          console.log(
            `\n${idea['Suggested page idea']} (${idea['Commercial or informational']}, slug ${idea['Suggested URL slug']})`,
          );
          console.log(`  why: ${idea['Why this should be a separate page']}`);
        }
      }
      break;
    }

    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
