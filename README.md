# GSC Content Recommendations

Turns Google Search Console data into conservative, page-level content recommendations, reviewed collaboratively in Google Sheets.

The pipeline pulls per-URL query data from GSC (last 3 months by default), groups near-identical query variants, fetches each live page, checks what's already covered, scores each query group for relevance / intent / commerciality / distinctness / cannibalisation risk, and writes one recommendation row per query group back to the sheet. Reviewers correct outputs in the sheet; corrections become explicit, scoped, auditable rules that shape every future run.

## Design principles

- **Conservative by default.** Queries group only when they are near-identical phrase variants (same content words, differing only in word order or function words like *in/for/of/the*). Synonym-like queries — `IT Support Sheffield` vs `IT Services Sheffield` — stay separate unless an explicit feedback rule merges them. The core editorial question the classifier asks: *"Is this something someone would search when looking for this specific page?"*
- **One row per query group, not per raw query.** Raw data lives in a hidden `GSC Raw` tab for auditability; humans review at group level.
- **No invisible learning.** Every correction is stored as a visible, editable rule in the `Feedback Rules` tab with scope, reason, author, and status. Originals are preserved in the `Review Log`. Global-scope rules are created as drafts requiring admin activation.
- **Human review columns are never overwritten.** Re-running the pipeline upserts computed columns and keeps reviewer edits; rows that vanish from a run but carry review data are kept and flagged stale.

## Quick start (no credentials needed)

```bash
npm install
npm test        # 64 unit + end-to-end tests
npm run demo    # full pipeline offline against mock data
```

The demo seeds an in-memory workbook with a fictional Sheffield IT-support client and prints the resulting recommendations — useful for understanding the output before wiring up real APIs.

## Real setup

1. **Google Cloud**: create a service account, enable the *Google Sheets API* and *Search Console API*, and download a JSON key.
2. **Search Console**: add the service account's email as a (restricted) user on the GSC property.
3. **Google Sheet**: create a spreadsheet and share it with the service account email (editor). The tool creates all tabs and headers automatically on first run.
4. **Environment**: `cp .env.example .env` and fill in `SPREADSHEET_ID` and `GOOGLE_APPLICATION_CREDENTIALS`. Never hardcode credentials.
5. In the sheet, fill in the `Config` tab (Setting/Value pairs — e.g. `GSC property` = `sc-domain:example.co.uk`, `Target locations` = `Sheffield, Rotherham`) and add pages to `Input URLs`.

```bash
npm run analyse                                    # full pipeline
npm run pull                                       # GSC raw data + page content only
npm run inventory -- https://example.com/sitemap.xml   # seed Site URL Inventory
npm run apply-feedback                             # turn reviewer corrections into rules
```

## Google Sheets tabs

| Tab | Role |
|---|---|
| `Config` | Client, GSC property, date window (default: last 3 months), thresholds, locations, terminology, LLM settings |
| `Pages` | The site's known URLs in one place (title/H1 auto-filled), with an "Include in next run" checkbox next to each URL — only ticked pages are pulled and analysed; every row feeds the cannibalisation checks. Seed via sitemap import (`npm run inventory`) or paste URLs. Legacy Input URLs / Site URL Inventory tabs migrate automatically |
| `GSC Raw` | Hidden backend tab; one row per raw URL/query pair with full metrics |
| `Page Content` | Extracted title, meta, H1, H2s, body text per analysed URL |
| `Query Groups` | The analysis layer: one row per query group with metrics, mention detection, and all five scores |
| `Recommendations` | The editorial review layer: one row per actionable recommendation + human review columns |
| `Suggested Edits` | Copy-and-paste improvements: what to add, where on the page, which keywords it covers (H2s, body sentences, and one consolidated H3 FAQ set per page) |
| `Rejected` | No-action rows with reasons, kept out of the main review list (same review columns, so a rejection can be overturned) |
| `Archive` | History: rows marked approved/done/implemented move here on the next run and stay suppressed from future output — delete an Archive row to resurface its item |
| `New Page Ideas` | Suggested new commercial pages and supporting content, consolidated one row per real-world page |
| `Feedback Rules` | Reusable rules created from corrections (visible, editable, scoped) |
| `Client Brief` | Business context and priorities |
| `Review Log` | Immutable audit trail of every correction |

## Recommendation categories

`add_to_h2` · `add_to_body` · `add_to_faq` · `link_to_existing_page` (internal link to the page that should own the query) · `reject` — plus `new_commercial_page` / `new_supporting_content`, which appear only in New Page Ideas, keeping Recommendations focused on existing pages

Default decision rules (thresholds configurable in `src/config/defaults.ts`):

- `add_to_h2` is reserved for undeniable cases only: the phrase already sits in body copy and deserves promotion to a heading, or it is a modifier-variant of the page's own headline topic with ≥100 impressions — everything else relevant and commercial goes to `add_to_body`
- relevance ≥4, intent ≥4, commerciality <4, distinct ≤2 → `add_to_body`, or `add_to_faq` when question-led (FAQs are output as H3 question sets)
- long conversational queries (AI-assistant/voice-style) never become headings or pages: relevant ones → `add_to_faq`, weak-fit ones → rejected as demand signals
- commerciality ≥4, distinct ≥3, cannibalisation ≤2 → `new_commercial_page`
- relevance ≥3, informational, distinct ≥3 → `new_supporting_content`
- cannibalisation ≥4 with a better URL → `link_to_existing_page` (add an internal link with the query as anchor text)
- relevance ≤2 or intent ≤2 → `reject` (a weakly-related distinct commercial group may still surface as a low-confidence new-page idea when it overlaps the wider site's topics)
- phrase already prominent in a heading → no action; already covered naturally in body copy → no action unless it qualifies for a prominence upgrade

## Monthly re-runs

Re-running is designed to be cheap and non-destructive:

- **Selector**: tick "Include in next run" on the `Input URLs` rows you want this month; unticked URLs keep all their existing rows untouched.
- **Pull reuse**: a URL's raw GSC data is reused if pulled within the last 7 days (Config: `Reuse GSC pulls newer than (days)`; set 0 to always pull fresh). Pages are always re-fetched and re-analysed.
- **Archive**: mark a recommendation or edit `approved`/`done`/`implemented` once you've actioned it — the next run moves it to the `Archive` tab and won't suggest it again (mention detection usually confirms the change too, since the phrase is now on the page).

## Giving feedback in the sheet

Edit the review columns on any `Recommendations` row, then run `npm run apply-feedback`:

| You want to… | Do this |
|---|---|
| Reject a recommendation | `Review status` = `rejected`, add a `Feedback reason` |
| Change the category | Fill `Corrected recommendation` (e.g. `new_commercial_page`) |
| Send the group to another page | Fill `Better URL` |
| Split a group | `Corrected group` = `split: query one; query two` |
| Merge two groups (synonyms) | `Corrected group` = `merge: phrase a \| phrase b`, optional `Corrected canonical query` |
| Mark two phrases as distinct intents | `Corrected group` = `distinct: phrase a \| phrase b` |

Set `Remember this rule?` = `yes` to create a reusable rule, and pick a `Feedback scope`: `current_recommendation_only`, `current_url`, `sitewide`, `client`, or `global` (global rules are saved as drafts pending admin approval). Rules apply in scope order — global → client → sitewide → URL — with more specific rules overriding broader ones. The processed row is marked (`saved:<rule id>`) so re-running never duplicates rules. Then re-run `npm run analyse` to apply the new rules: groups are re-split/merged, metrics recalculated, mentions re-checked, and recommendations regenerated.

## Running from inside the sheet (team deployment)

Non-technical teammates never need a terminal. Deploy the engine once as a small web service, and every sheet gets an **SEO Tool menu** (Run analysis / Pull data only / Apply feedback / Set up this sheet):

1. **Deploy the service** (once, by whoever owns the Google Cloud project):
   ```bash
   gcloud run deploy gsc-recs --source . --region europe-west1 --no-allow-unauthenticated=false \
     --set-env-vars GOOGLE_SERVICE_ACCOUNT_EMAIL=...,SERVICE_TOKEN=<random-secret> \
     --set-secrets GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=gsc-recs-key:latest
   ```
   (Any Node host works — `npm run serve` runs the same server. Endpoints: `GET /healthz`, `POST /run` guarded by the `x-service-token` header.)
2. **Install the menu in a template sheet**: Extensions → Apps Script → paste `apps-script/Menu.gs` → fill in `SERVICE_URL`, `SERVICE_TOKEN` and the service-account email → save. Add the standard Config rows and share the template with the service account.
3. **New client = copy the template.** Bound scripts copy with the sheet, so the copy already has the menu. The teammate clicks **SEO Tool → Set up this sheet**, which shares the sheet with the service account, creates all tabs, and shows the remaining checklist (fill Config; add the service account as a Restricted user on the client's GSC property; tick pages). Then **Run analysis**.

Runs are asynchronous — the menu shows a toast and progress lands in the Pages tab (Status / Last analysed). The service refuses concurrent runs for the same sheet and rejects requests without the shared token.

## Deploying for a new client (CLI alternative)

One deployment serves any number of clients — one Google Sheet each, no code changes:

1. Create a blank Google Sheet; share it (Editor) with the same service account email.
2. In Search Console, add the service account as a Restricted user on the client's property.
3. Add the client to a `clients.json` next to package.json (gitignored): `{ "acme": "<spreadsheet-id>" }`.
4. `npm run analyse -- acme` — tabs are created; fill the `Config` tab (Client name, Website, GSC property) and tick pages in `Pages`, then run again.

All client-specific settings live in that sheet's Config tab; nothing in the codebase changes per client. (`SPREADSHEET_ID`/`GSC_PROPERTY` env vars are fallbacks for single-client use only.)

## Optional LLM scoring

Heuristic scoring is the default and the pipeline is fully functional without any LLM. To let Claude review scores (relevance, intent, commerciality, distinctness, cannibalisation) with the client brief as context, set in `.env`:

```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# LLM_MODEL=claude-opus-4-8   (default)
```

The adapter only refines the heuristic scores; grouping and mention detection stay deterministic, and every LLM adjustment is noted in the score notes.

## Project structure

```
src/
  types.ts                 # domain types (mirror the sheet tabs 1:1)
  config/                  # defaults, thresholds, marker word lists, Config-tab loader
  text/normalise.ts        # normalisation, tokenising, safe singularisation
  grouping/grouper.ts      # content-token signatures, conservative grouping, canonical selection
  mentions/detector.ts     # flexible phrase matching (exact / close variant / concept / not covered)
  scoring/heuristics.ts    # the five 0-5 scores + site-awareness checks
  classify/decisionRules.ts# decision rules → one category per group
  recommendations/         # recommendation rows + new page ideas
  rules/                   # feedback rule engine (scoping, precedence) + correction processor
  google/                  # Sheets client, GSC client, tab schemas, serialisers, auth
  content/fetcher.ts       # live page fetch + cheerio HTML extraction
  inventory/sitemap.ts     # sitemap importer
  llm/                     # optional adapter (noop default, Anthropic optional)
  pipeline/run.ts          # orchestrator (dependency-injected: real APIs or mocks)
  mocks/                   # in-memory store + fixtures for offline dev
  cli.ts                   # analyse | pull | inventory | apply-feedback | demo
```

## Testing

```bash
npm test            # vitest: grouping, mentions, scoring, classification, rules, e2e pipeline
npm run typecheck
```

The end-to-end tests in `src/pipeline/run.test.ts` exercise the complete loop against mocks: analyse → reviewer correction → rule creation → re-run applies the rule, including the spec's canonical scenario (splitting/merging `IT Support` vs `IT Services` style groups).

## Notes on the original Apps Script

This project replaces the proof-of-concept Apps Script. All of its improvement points are implemented here: the window defaults to the last 3 months (ending 2 days ago to respect GSC data lag), clicks/impressions/CTR/position are preserved per raw row, raw data is stored structurally, queries are grouped before any human-facing output, thresholds and sheet names and the GSC property are configurable, runs are idempotent (re-running upserts rather than duplicates), review columns are never overwritten, and GSC API errors are recorded per-URL in the `Input URLs` status column instead of aborting the run.
