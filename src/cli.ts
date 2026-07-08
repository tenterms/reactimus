import 'dotenv/config';
import { SheetsClient } from './google/sheets.js';
import { GscClient } from './google/gsc.js';
import { fetchPageContent } from './content/fetcher.js';
import { fetchSitemapUrls } from './inventory/sitemap.js';
import { runAnalyse, runApplyFeedback } from './pipeline/run.js';
import { TAB } from './google/schema.js';
import { inventoryToRow } from './google/serialise.js';
import { MemoryStore } from './mocks/memoryStore.js';
import { DEMO_SEED, MockGscClient, mockFetchPage } from './mocks/fixtures.js';

const USAGE = `Usage:
  npm run analyse         Full pipeline: pull GSC data, fetch pages, group, score, write recommendations
  npm run pull            Pull GSC raw data + page content only (no analysis)
  npm run inventory -- <sitemap-url>   Import site URLs from a sitemap into Site URL Inventory
  npm run apply-feedback  Convert reviewer corrections into Feedback Rules + Review Log
  npm run demo            Run the full pipeline offline against mock data (no credentials needed)

Environment (see .env.example):
  SPREADSHEET_ID, GOOGLE_APPLICATION_CREDENTIALS (or inline service-account vars),
  optionally GSC_PROPERTY, LLM_PROVIDER/ANTHROPIC_API_KEY.`;

function requireSpreadsheet(): SheetsClient {
  const id = process.env.SPREADSHEET_ID;
  if (!id) {
    console.error('SPREADSHEET_ID is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  return new SheetsClient(id);
}

async function main() {
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case 'analyse':
    case 'analyze': {
      await runAnalyse({ store: requireSpreadsheet(), gsc: new GscClient(), fetchPage: fetchPageContent });
      break;
    }

    case 'pull': {
      await runAnalyse(
        { store: requireSpreadsheet(), gsc: new GscClient(), fetchPage: fetchPageContent },
        { pullOnly: true },
      );
      break;
    }

    case 'inventory': {
      if (!arg) {
        console.error('Provide a sitemap URL: npm run inventory -- https://example.com/sitemap.xml');
        process.exit(1);
      }
      const store = requireSpreadsheet();
      await store.ensureTabs();
      const urls = await fetchSitemapUrls(arg);
      console.log(`Sitemap yielded ${urls.length} URLs. Fetching titles/H1s (this can take a while)...`);
      const existing = await store.readTab(TAB.siteInventory);
      const known = new Set(existing.map((r) => (r['URL'] ?? '').trim().toLowerCase().replace(/\/+$/, '')));
      const fresh = [];
      for (const url of urls) {
        if (known.has(url.trim().toLowerCase().replace(/\/+$/, ''))) continue;
        const page = await fetchPageContent(url);
        fresh.push(
          inventoryToRow({
            url,
            titleTag: page.titleTag,
            h1: page.h1,
            pageType: '',
            primaryTopic: '',
            targetIntent: '',
            canonicalUrl: page.canonicalUrl,
            notes: 'imported from sitemap',
          }),
        );
        process.stdout.write('.');
      }
      console.log('');
      await store.appendRows(TAB.siteInventory, fresh);
      console.log(`Added ${fresh.length} new URLs to Site URL Inventory.`);
      break;
    }

    case 'apply-feedback': {
      const user = process.env.FEEDBACK_USER || process.env.USER || 'unknown';
      await runApplyFeedback({ store: requireSpreadsheet() }, user);
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
