'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runGrafanaEditorHandoffScenarios({ client, handoffSource, grafanaPageSource, legacyFixtures, stateExprFallbackResult, expectedMergeQueries }) {
  const grafanaEditorBindingResult = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/d/test?editPanel=1');
    const channelToken = 'browser-ambiguous-editor-token';
    const bridgeScript = document.createElement('script');
    bridgeScript.dataset.channelToken = channelToken;
    bridgeScript.textContent = ${grafanaPageSource};
    document.documentElement.appendChild(bridgeScript);

    async function applyQuery(operationId, query) {
      const requestId = 'browser-request-' + operationId;
      const response = new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          window.removeEventListener('message', onMessage);
          reject(new Error('Timed out waiting for Grafana operation ' + operationId));
        }, 4000);
        function onMessage(event) {
          if (
            event.source !== window ||
            event.origin !== window.location.origin ||
            event.data?.type !== 'BOSUN_HELPER_GRAFANA_QUERY_RESULT' ||
            event.data?.requestId !== requestId ||
            event.data?.operationId !== operationId
          ) return;
          clearTimeout(timeoutId);
          window.removeEventListener('message', onMessage);
          resolve(event.data.result);
        }
        window.addEventListener('message', onMessage);
      });
      window.postMessage({
        type: 'BOSUN_HELPER_APPLY_GRAFANA_QUERY',
        channelToken,
        requestId,
        operationId,
        query,
        run: true,
        targetIdentity: { origin: location.origin, pathname: '/d/test', editPanel: '1', orgId: null },
        deadlineAt: Date.now() + 5000
      }, window.location.origin);
      return response;
    }

    function createModel(initialText) {
      let text = initialText;
      let version = 1;
      return {
        model: {
          getValue: () => text,
          getVersionId: () => version,
          setValue(next) { text = next; version += 1; }
        },
        getText: () => text
      };
    }

    function mountMonacoEditor() {
      document.body.innerHTML =
        '<div class="query-row">' +
          '<button type="button">Code</button>' +
          '<div id="grafana-monaco-root" class="monaco-editor" style="display:block;width:320px;height:48px">' +
            '<textarea class="inputarea monaco-mouse-cursor-text" role="textbox" ' +
              'style="display:block;width:300px;height:32px"></textarea>' +
          '</div>' +
          '<button id="grafana-run" type="button">Run queries</button>' +
        '</div>';
      let runClicks = 0;
      document.getElementById('grafana-run').addEventListener('click', () => { runClicks += 1; });
      return {
        root: document.getElementById('grafana-monaco-root'),
        getRunClicks: () => runClicks
      };
    }

    const validDom = mountMonacoEditor();
    const visibleModel = createModel('up');
    const hiddenModel = createModel('rate(hidden_total[5m])');
    const visibleEditor = {
      getDomNode: () => validDom.root,
      getModel: () => visibleModel.model
    };
    window.monaco = {
      editor: {
        getEditors: () => [visibleEditor],
        getModels: () => [visibleModel.model, hiddenModel.model]
      }
    };
    const validResult = await applyQuery('browser-monaco-valid-binding', 'sum(new_metric)');
    const valid = {
      ok: validResult?.ok === true,
      visibleText: visibleModel.getText(),
      hiddenText: hiddenModel.getText(),
      runClicks: validDom.getRunClicks()
    };

    const routeDrift = [];
    for (const phase of ['before-mutation', 'after-verification', 'transient']) {
      history.replaceState({}, '', '/d/test?editPanel=1');
      const dom = mountMonacoEditor();
      const model = createModel('original');
      const editor = {
        getDomNode: () => dom.root, getModel: () => model.model
      };
      window.monaco = { editor: { getEditors: () => [editor] } };
      let commits = 0;
      dom.root.querySelector('textarea').addEventListener('change', () => {
        commits += 1;
        if (phase === 'after-verification' && commits === 2) {
          history.pushState({}, '', '/d/other?editPanel=2');
        } else if (phase === 'transient' && commits === 1) {
          history.pushState({}, '', '/d/test?from=now-1h&editPanel=1&to=now#query');
        }
      });
      if (phase === 'before-mutation') history.pushState({}, '', '/d/other?editPanel=2');
      const result = await applyQuery('browser-a18-' + phase, 'synthetic_metric');
      routeDrift.push({ phase, ok: result.ok, reason: result.reason || null,
        text: model.getText(), runClicks: dom.getRunClicks(), commits });
    }
    history.replaceState({}, '', '/d/test?editPanel=1');

    const mismatchDom = mountMonacoEditor();
    const mismatchModel = createModel('up');
    const unrelatedRoot = document.createElement('div');
    unrelatedRoot.style.cssText = 'display:block;width:320px;height:48px';
    document.body.appendChild(unrelatedRoot);
    window.monaco = {
      editor: {
        getEditors: () => [{
          getDomNode: () => unrelatedRoot,
          getModel: () => mismatchModel.model
        }],
        getModels: () => [mismatchModel.model]
      }
    };
    const mismatchResult = await applyQuery('browser-monaco-mismatched-dom', 'sum(new_metric)');
    const mismatched = {
      ok: mismatchResult?.ok === true,
      text: mismatchModel.getText(),
      runClicks: mismatchDom.getRunClicks()
    };

    const disconnectedDom = mountMonacoEditor();
    const disconnectedModel = createModel('up');
    const detachedRoot = document.createElement('div');
    window.monaco = {
      editor: {
        getEditors: () => [{
          getDomNode: () => detachedRoot,
          getModel: () => disconnectedModel.model
        }],
        getModels: () => [disconnectedModel.model]
      }
    };
    const disconnectedResult = await applyQuery('browser-monaco-disconnected-dom', 'sum(new_metric)');
    const disconnected = {
      ok: disconnectedResult?.ok === true,
      text: disconnectedModel.getText(),
      runClicks: disconnectedDom.getRunClicks()
    };

    document.body.innerHTML =
      '<div class="query-row">' +
        '<button id="grafana-code-toggle" type="button">Code</button>' +
        '<div id="grafana-editor-one" class="cm-editor" style="min-height:24px">' +
          '<div class="cm-content" contenteditable="true" style="min-height:20px">first query</div>' +
        '</div>' +
        '<div id="grafana-editor-two" class="cm-editor" style="min-height:24px">' +
          '<div class="cm-content" contenteditable="true" style="min-height:20px">second query</div>' +
        '</div>' +
        '<button id="grafana-run" type="button">Run queries</button>' +
      '</div>';

    function createView(initialText) {
      let text = initialText;
      let dispatchCount = 0;
      const view = {
        state: { doc: { toString: () => text } },
        dispatch(transaction) {
          dispatchCount += 1;
          text = transaction.changes.insert;
          this.state.doc = { toString: () => text };
        }
      };
      return {
        view,
        getText: () => text,
        getDispatchCount: () => dispatchCount
      };
    }

    const first = createView('first query');
    const second = createView('second query');
    document.getElementById('grafana-editor-one').cmView = first.view;
    document.getElementById('grafana-editor-two').cmView = second.view;
    const secondContent = document.querySelector('#grafana-editor-two .cm-content');
    secondContent.focus();
    window.monaco = undefined;

    let ambiguousRunClicks = 0;
    document.getElementById('grafana-run').addEventListener('click', () => {
      ambiguousRunClicks += 1;
    });
    const ambiguousResult = await applyQuery(
      'browser-ambiguous-editor-operation',
      'replacement query'
    );

    return {
      valid,
      routeDrift,
      mismatched,
      disconnected,
      ambiguous: {
        result: ambiguousResult,
        runClicks: ambiguousRunClicks,
        firstText: first.getText(),
        secondText: second.getText(),
        firstDispatches: first.getDispatchCount(),
        secondDispatches: second.getDispatchCount(),
        firstDomText: document.querySelector('#grafana-editor-one .cm-content').textContent,
        secondDomText: secondContent.textContent,
        activeEditorPreserved: document.activeElement === secondContent
      }
    };
  })()`);
  assert.deepStrictEqual(grafanaEditorBindingResult, {
    valid: {
      ok: true,
      visibleText: 'sum(new_metric)',
      hiddenText: 'rate(hidden_total[5m])',
      runClicks: 1
    },
    routeDrift: [
      { phase: 'before-mutation', ok: false, reason: 'target_changed', text: 'original', runClicks: 0, commits: 0 },
      { phase: 'after-verification', ok: false, reason: 'target_changed', text: 'synthetic_metric', runClicks: 0, commits: 2 },
      { phase: 'transient', ok: true, reason: null, text: 'synthetic_metric', runClicks: 1, commits: 2 }
    ],
    mismatched: { ok: false, text: 'up', runClicks: 0 },
    disconnected: { ok: false, text: 'up', runClicks: 0 },
    ambiguous: {
      result: { ok: false, reason: 'ambiguous-editor-dom', terminal: true },
      runClicks: 0,
      firstText: 'first query',
      secondText: 'second query',
      firstDispatches: 0,
      secondDispatches: 0,
      firstDomText: 'first query',
      secondDomText: 'second query',
      activeEditorPreserved: true
    }
  });

  const handoffResult = await evaluate(client, `(async () => {
    ${handoffSource}
    const saved = [];
    const navigated = [];
    const popup = { opener: window, location: { replace(value) { navigated.push(value); } }, close() {} };
    const storage = {
      set(values, callback) { saved.push(Object.values(values)[0]); callback(); },
      get(_keys, callback) { callback({}); },
      remove(_keys, callback) { callback?.(); }
    };
    const api = BosunHelperGrafanaHandoff.createGrafanaHandoff({
      config: {
        grafanaHost: 'grafana.example.test',
        grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
      },
      getStorage: () => storage,
      getLastError: () => null
    });
    const originalOpen = window.open;
    window.open = () => popup;
    const query = 'sum(rate(metric{label="<img src=x onerror=alert(1)>"}[5m]))';
    let previewSnapshot = null;
    setTimeout(() => {
      const dialog = document.querySelector('.bosun-grafana-preview-dialog');
      previewSnapshot = {
        text: dialog?.querySelector('pre')?.textContent || '',
        imageCount: dialog?.querySelectorAll('img').length || 0
      };
      Array.from(dialog?.querySelectorAll('button') || [])
        .find((button) => button.textContent === 'Вставить')?.click();
    }, 0);
    const inserted = await api.openQuery(query, document.body);
    setTimeout(() => {
      const dialog = document.querySelector('.bosun-grafana-preview-dialog');
      Array.from(dialog?.querySelectorAll('button') || [])
        .find((button) => button.textContent === 'Вставить и выполнить')?.click();
    }, 0);
    const executed = await api.openQuery('up', document.body);
    const legacyResults = [];
    const legacyQueries = ${JSON.stringify(stateExprFallbackResult.mergeActions.slice(-legacyFixtures.length).map(action => action.query))};
    for (let index = 0; index < legacyQueries.length; index += 1) {
      setTimeout(() => {
        const dialog = document.querySelector('.bosun-grafana-preview-dialog');
        const choice = index >= 9 ? 'Вставить и выполнить' : 'Вставить';
        Array.from(dialog?.querySelectorAll('button') || []).find(button => button.textContent === choice)?.click();
      }, 0);
      legacyResults.push(await api.openQuery(legacyQueries[index], document.body));
    }
    window.open = originalOpen;
    api.destroy();
    return { inserted, executed, previewSnapshot, saved, navigated, legacyResults, openerCleared: popup.opener === null };
  })()`);
  assert.strictEqual(handoffResult.inserted, true);
  assert.strictEqual(handoffResult.executed, true);
  assert.strictEqual(handoffResult.previewSnapshot.imageCount, 0);
  assert.ok(handoffResult.previewSnapshot.text.includes('<img src=x'));
  assert.strictEqual(handoffResult.saved[0].run, false);
  assert.strictEqual(handoffResult.saved[1].run, true);
  assert.strictEqual(handoffResult.navigated.length, 2 + legacyFixtures.length);
  assert.strictEqual(handoffResult.openerCleared, true);
  assert.ok(handoffResult.legacyResults.every(Boolean));
  assert.deepStrictEqual(handoffResult.saved.slice(2).map(({ query, run }) => ({ query, run })),
    expectedMergeQueries.slice(-legacyFixtures.length).map((query, index) => ({ query, run: index >= 9 })));

  const legacyEditorResult = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/d/test?editPanel=1');
    const payloads = ${JSON.stringify(handoffResult.saved.slice(2))};
    const results = [];
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index];
      document.body.innerHTML = '<div class="query-row"><button>Code</button>' +
        '<div class="monaco-editor" style="display:block;width:320px;height:48px">' +
        '<textarea class="inputarea monaco-mouse-cursor-text" role="textbox" style="display:block;width:300px;height:32px"></textarea></div>' +
        '<button id="legacy-run">Run queries</button></div>';
      const root = document.querySelector('.monaco-editor');
      let value = 'original';
      let revision = 1;
      let runClicks = 0;
      let verifiedRun = true;
      const model = { getValue: () => value, getVersionId: () => revision,
        setValue(next) { value = next; revision += 1; } };
      const editor = { getDomNode: () => root, getModel: () => model };
      window.monaco = { editor: { getEditors: () => [editor], getModels: () => [model] } };
      document.getElementById('legacy-run').addEventListener('click', () => {
        runClicks += 1;
        verifiedRun = verifiedRun && value === payload.query;
      });
      const requestId = 'legacy-browser-' + index;
      const operationId = 'legacy-operation-' + index;
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { window.removeEventListener('message', onResult); reject(new Error('Legacy editor timeout')); }, 4000);
        function onResult(event) {
          if (event.source !== window || event.origin !== location.origin ||
              event.data?.type !== 'BOSUN_HELPER_GRAFANA_QUERY_RESULT' ||
              event.data?.channelToken !== 'browser-ambiguous-editor-token' ||
              event.data?.requestId !== requestId || event.data?.operationId !== operationId) return;
          clearTimeout(timeout);
          window.removeEventListener('message', onResult);
          resolve(event.data.result);
        }
        window.addEventListener('message', onResult);
        window.postMessage({ type: 'BOSUN_HELPER_APPLY_GRAFANA_QUERY', channelToken: 'browser-ambiguous-editor-token',
          requestId, operationId, query: payload.query, run: payload.run,
          targetIdentity: { origin: location.origin, pathname: '/d/test', editPanel: '1', orgId: null },
          deadlineAt: Date.now() + 5000 }, location.origin);
      });
      results.push({ ok: result?.ok === true, query: value, runClicks, verifiedRun });
    }
    return results;
  })()`);
  assert.deepStrictEqual(legacyEditorResult, handoffResult.saved.slice(2).map(({ query, run }) =>
    ({ ok: true, query, runClicks: run ? 1 : 0, verifiedRun: true })));
};
