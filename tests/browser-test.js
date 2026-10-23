'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const runAcknowledgedCompactAssertions = require('./acknowledged-browser-regression');
const { selection, writeBrowserReport } = require('../scripts/check-context');
const { evaluate } = require('./browser/harness/cdp-client');
const { withBrowserSession, removeTemporaryProfile } = require('./browser/harness/chromium');
const { createScriptLoader } = require('./browser/harness/script-loader');
const runSettingsPanelScenarios = require('./browser/settings-panel');
const runSettingsLayoutScenarios = require('./browser/settings-layout');
const runActionTemplateScenarios = require('./browser/action-templates');
const runSingleAlertAgeLayoutScenarios = require('./browser/single-alert-age-layout');
const runSingleAlertAgeLifecycleScenarios = require('./browser/single-alert-age-lifecycle');
const runAlertIdentityScenarios = require('./browser/alert-identity');
const runPriorityActionScenarios = require('./browser/priority-actions');
const runMarkerLifecycleScenarios = require('./browser/marker-lifecycle');
const runPriorityRenderingScenarios = require('./browser/priority-rendering');
const runPromqlResolutionScenarios = require('./browser/promql-resolution');
const runSettingsNotificationScenarios = require('./browser/settings-notifications');
const runSettingsRecoveryScenarios = require('./browser/settings-recovery');
const runAccessibilityCopyScenarios = require('./browser/accessibility-copy');
const runCopyAssertions = require('./browser/copy');
const runToolbarAssertions = require('./browser/toolbar');
const runGrafanaEditorHandoffScenarios = require('./browser/grafana-editor-handoff');

selection('test:browser', process.env, process.argv.slice(2));

const root = path.resolve(__dirname, '..');
const { readTestScript, instrumentContentSource } = createScriptLoader(root);



if (typeof WebSocket !== 'function') {
  throw new Error('Browser tests require Node.js with global WebSocket support (Node.js 22+ recommended).');
}

async function testTemporaryProfileCleanupRetry() {
  const attemptedDelays = [];
  let removeAttempts = 0;
  await removeTemporaryProfile(
    path.join(os.tmpdir(), 'bosun-helper-browser-cleanup-test'),
    {
      maxAttempts: 4,
      async remove() {
        removeAttempts += 1;
        if (removeAttempts < 3) {
          const error = new Error('simulated Windows profile lock');
          error.code = 'EPERM';
          throw error;
        }
      },
      async wait(milliseconds) { attemptedDelays.push(milliseconds); }
    }
  );
  assert.strictEqual(removeAttempts, 3, 'Temporary profile cleanup did not retry EPERM');
  assert.deepStrictEqual(attemptedDelays, [100, 200]);
}

const runAngularGroupIdentityAssertions = require('./browser/group-identity')({ readTestScript, instrumentContentSource });

const runPrimeMarkerStartupAssertions = require('./browser/marker-startup')({ readTestScript, instrumentContentSource });

async function runBrowserAssertions(client) {
  await runAcknowledgedCompactAssertions({ client, evaluate, instrumentContentSource, root });
  await runPrimeMarkerStartupAssertions(client);
  await runAngularGroupIdentityAssertions(client);
  await runAngularGroupIdentityAssertions(client, true);
  await runAngularGroupIdentityAssertions(client, false, true);
  await runAngularGroupIdentityAssertions(client, false, false, true);
  await runAngularGroupIdentityAssertions(client, false, false, false, true);
  await runAngularGroupIdentityAssertions(client, false, false, false, true, true);
  const focusedAuditCase = process.env.BOSUN_HELPER_BROWSER_CASE || '';
  const settingsSource = readTestScript('src/settings/settings.js');
  const settingsUiSource = readTestScript('src/settings/settings-ui.js');
  const actionSource = readTestScript('src/bosun/action-templates.js');
  const needAckBaselineSource = readTestScript('src/bosun/needack-baseline.js');
  const newAlertTrackerSource = readTestScript('src/bosun/new-alert-tracker.js');
  const singleAlertAgeSource = readTestScript('src/bosun/single-alert-age.js');
  const alertsDataSource = readTestScript('src/bosun/alerts-data.js');
  const needAckSeveritySource = readTestScript('src/bosun/needack-severity.js');
  const prioritySource = readTestScript('src/bosun/priority-alerts.js');
  const pageUtilsSource = readTestScript('src/bosun/page-utils.js');
  const lastActionSource = readTestScript('src/bosun/last-action.js');
  const stylesSource = readTestScript('src/shared/styles.js');
  const handoffSource = readTestScript('src/grafana/grafana-handoff.js');
  const grafanaPageSource = JSON.stringify(
    readTestScript('src/grafana/grafana-page.js')
  );
  const promqlSource = readTestScript('src/grafana/promql.js');
  const ruleGraphSource = readTestScript('src/grafana/bosun-rule-graph.js');
  const contentSource = instrumentContentSource(
    readTestScript('src/bosun/content.js')
  );

  await runSettingsPanelScenarios({ client, focusedAuditCase, settingsSource, settingsUiSource, stylesSource, contentSource });
  if (focusedAuditCase === 'A04') return;

  await runSettingsLayoutScenarios({ client, contentSource });

  await runActionTemplateScenarios({ client, focusedAuditCase, actionSource });
  if (focusedAuditCase === 'A12') return;

  await runSingleAlertAgeLayoutScenarios({ client, singleAlertAgeSource, pageUtilsSource, stylesSource });

  await runSingleAlertAgeLifecycleScenarios({ client, singleAlertAgeSource, contentSource });

  await runAlertIdentityScenarios({ client, singleAlertAgeSource, alertsDataSource, promqlSource, contentSource });

  const { priorityRowActions } = await runPriorityActionScenarios({ client, settingsSource, settingsUiSource, singleAlertAgeSource, alertsDataSource, needAckSeveritySource, prioritySource, stylesSource, contentSource });
  await runMarkerLifecycleScenarios({ client, settingsSource, singleAlertAgeSource, alertsDataSource, needAckSeveritySource, prioritySource, stylesSource, contentSource, priorityRowActions });
  await runPriorityRenderingScenarios({ client, settingsSource, alertsDataSource, needAckSeveritySource, prioritySource, stylesSource, contentSource });

  const { legacyFixtures, stateExprFallbackResult, expectedMergeQueries } = await runPromqlResolutionScenarios({ client, promqlSource, ruleGraphSource, contentSource });

  await runSettingsNotificationScenarios({ client, focusedAuditCase, needAckBaselineSource, newAlertTrackerSource, alertsDataSource, pageUtilsSource, contentSource });
  if (focusedAuditCase === 'A06') return;

  await runSettingsRecoveryScenarios({ client, contentSource });

  await runAccessibilityCopyScenarios({ client, contentSource, lastActionSource });
  await runCopyAssertions({ client, copySource: readTestScript('src/bosun/copy.js') });
  await runToolbarAssertions({ client, contentSource });

  await runGrafanaEditorHandoffScenarios({ client, handoffSource, grafanaPageSource, legacyFixtures, stateExprFallbackResult, expectedMergeQueries });
}

async function main() {
  await testTemporaryProfileCleanupRetry();
  await withBrowserSession(async ({ client, executable, browserVersion, context }) => {
    if (process.argv.includes('--acknowledged-compact-regression')) await runAcknowledgedCompactAssertions({ client, evaluate, instrumentContentSource, root });
    else if (process.argv.includes('--single-alert-age-expand-identity-regression') || process.argv.includes('--single-alert-age-inherited-child-regression') || process.argv.includes('--single-alert-age-visible-id-format-regression')) await runAngularGroupIdentityAssertions(client, false, false, false, true);
    else if (process.argv.includes('--single-alert-age-empty-section-regression')) await runAngularGroupIdentityAssertions(client, false, false, true);
    else if (process.argv.includes('--single-alert-age-source-regression')) await runAngularGroupIdentityAssertions(client, false, true);
    else if (process.argv.includes('--single-alert-age-subject-regression')) await runAngularGroupIdentityAssertions(client, true);
    else await runBrowserAssertions(client);
    writeBrowserReport(context, browserVersion.Browser);
    console.log(`Browser test passed (${path.basename(executable)}, ${browserVersion.Browser}, ${context.scope})`);
  });
}

main().catch((error) => {
  console.error(`Browser test failed: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
