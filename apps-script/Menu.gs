/**
 * SEO Tool menu — container-bound Apps Script.
 *
 * Install once in the TEMPLATE sheet (Extensions → Apps Script → paste this
 * file → save). Bound scripts are copied whenever a teammate makes a copy of
 * the sheet, so every client sheet gets the menu automatically.
 *
 * Fill in the three constants below before saving.
 */

const SERVICE_URL = 'https://YOUR-CLOUD-RUN-URL'; // e.g. https://gsc-recs-xxxx-ew.a.run.app
const SERVICE_TOKEN = 'CHANGE-ME'; // must match the server's SERVICE_TOKEN env var
const SERVICE_ACCOUNT_EMAIL = 'gsc-recs-bot@reactimus.iam.gserviceaccount.com';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('SEO Tool')
    .addItem('▶ Run analysis', 'runAnalysis')
    .addItem('⬇ Pull data only', 'runPull')
    .addItem('✔ Apply feedback', 'runApplyFeedback')
    .addSeparator()
    .addItem('🛠 Set up this sheet (new clients)', 'setupSheet')
    .addItem('ℹ Help', 'showHelp')
    .addToUi();
}

function runAnalysis() {
  callService_('analyse');
}
function runPull() {
  callService_('pull');
}
function runApplyFeedback() {
  callService_('apply-feedback');
}

/** One-click setup for a freshly copied sheet. */
function setupSheet() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 1. Give the tool's service account access to this sheet.
  try {
    ss.addEditor(SERVICE_ACCOUNT_EMAIL);
  } catch (e) {
    ui.alert('Could not share the sheet automatically: ' + e + '\nPlease share it manually (Editor) with:\n' + SERVICE_ACCOUNT_EMAIL);
  }
  // 2. Ask the service to create all tabs.
  callService_('setup');
  // 3. Remind about the one manual step the API cannot do.
  ui.alert(
    'Setup started',
    'Tabs are being created (refresh in ~30 seconds).\n\n' +
      'Then:\n' +
      '1. Fill the Config tab: Client name, Website, GSC property (e.g. sc-domain:example.co.uk).\n' +
      '2. IMPORTANT: in Google Search Console, add this user to the property (Settings → Users and permissions → Restricted):\n   ' +
      SERVICE_ACCOUNT_EMAIL +
      '\n3. Add pages to the Pages tab and tick "Include in next run".\n' +
      '4. SEO Tool → Run analysis.',
    ui.ButtonSet.OK,
  );
}

function showHelp() {
  SpreadsheetApp.getUi().alert(
    'SEO Tool',
    'Run analysis: pulls Search Console data for ticked pages, analyses them, and refreshes Recommendations / Suggested Edits / New Page Ideas.\n\n' +
      'Apply feedback: converts your corrections (Review status, Corrected…, Remember this rule?) into reusable rules, then run analysis again.\n\n' +
      'Mark rows done/approved once actioned — they move to the Archive and stop being suggested.\n\n' +
      'Progress appears in the Pages tab (Status + Last analysed columns).',
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

function callService_(action) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const response = UrlFetchApp.fetch(SERVICE_URL + '/run', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-service-token': SERVICE_TOKEN },
      payload: JSON.stringify({
        spreadsheetId: ss.getId(),
        action: action,
        user: Session.getActiveUser().getEmail() || 'sheet-user',
      }),
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    if (code === 202) {
      ss.toast('Run started — progress appears in the Pages tab. Refresh in a few minutes.', 'SEO Tool', 8);
    } else if (code === 409) {
      ss.toast('A run for this sheet is already in progress.', 'SEO Tool', 8);
    } else {
      SpreadsheetApp.getUi().alert('SEO Tool error (' + code + '): ' + response.getContentText());
    }
  } catch (e) {
    SpreadsheetApp.getUi().alert('Could not reach the SEO Tool service: ' + e);
  }
}
