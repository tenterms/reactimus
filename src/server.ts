import 'dotenv/config';
import { createServer } from 'http';
import { SheetsClient } from './google/sheets.js';
import { GscClient } from './google/gsc.js';
import { fetchPageContent } from './content/fetcher.js';
import { runAnalyse, runApplyFeedback } from './pipeline/run.js';

/**
 * Minimal HTTP wrapper so the pipeline can be triggered from inside a Google
 * Sheet (via the bound Apps Script menu in apps-script/Menu.gs). Deploy to
 * Cloud Run (or any Node host) with the same service-account credentials as
 * the CLI.
 *
 *   POST /run  { "spreadsheetId": "...", "action": "analyse|pull|apply-feedback|setup", "user": "..." }
 *   Header: x-service-token: $SERVICE_TOKEN
 *
 * Runs are asynchronous: the server responds 202 immediately and the sheet's
 * Pages tab shows per-URL status/timestamps as the run progresses.
 */
const PORT = parseInt(process.env.PORT ?? '8080', 10);
const TOKEN = process.env.SERVICE_TOKEN ?? '';
const running = new Set<string>();

const ACTIONS = new Set(['analyse', 'analyze', 'pull', 'apply-feedback', 'setup']);

async function execute(action: string, spreadsheetId: string, user: string): Promise<void> {
  const store = new SheetsClient(spreadsheetId);
  const log = (msg: string) => console.log(`[${spreadsheetId.slice(0, 8)}…] ${msg}`);
  switch (action) {
    case 'setup':
      await store.ensureTabs();
      log('Tabs created/verified.');
      break;
    case 'apply-feedback':
      await runApplyFeedback({ store, log }, user || 'sheet-user');
      break;
    default:
      await runAnalyse(
        { store, gsc: new GscClient(), fetchPage: fetchPageContent, log },
        { pullOnly: action === 'pull' },
      );
  }
}

const server = createServer((req, res) => {
  const respond = (code: number, body: object) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/healthz') return respond(200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/run') return respond(404, { error: 'not found' });

  if (!TOKEN) return respond(500, { error: 'SERVICE_TOKEN is not configured on the server' });
  if (req.headers['x-service-token'] !== TOKEN) return respond(401, { error: 'bad token' });

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let body: { spreadsheetId?: string; action?: string; user?: string };
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return respond(400, { error: 'invalid JSON' });
    }
    const spreadsheetId = (body.spreadsheetId ?? '').trim();
    const action = (body.action ?? 'analyse').trim().toLowerCase();
    if (!/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) {
      return respond(400, { error: 'invalid spreadsheetId' });
    }
    if (!ACTIONS.has(action)) return respond(400, { error: `unknown action "${action}"` });
    if (running.has(spreadsheetId)) {
      return respond(409, { error: 'a run for this sheet is already in progress' });
    }

    running.add(spreadsheetId);
    respond(202, {
      status: 'started',
      action,
      note: 'Progress appears in the sheet (Pages tab status/timestamps). Refresh in a few minutes.',
    });

    execute(action, spreadsheetId, body.user ?? '')
      .then(() => console.log(`[${spreadsheetId.slice(0, 8)}…] ${action} complete.`))
      .catch((err) => console.error(`[${spreadsheetId.slice(0, 8)}…] ${action} FAILED:`, err))
      .finally(() => running.delete(spreadsheetId));
  });
});

server.listen(PORT, () => console.log(`gsc-content-recommendations service listening on :${PORT}`));
