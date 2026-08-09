(() => {
  'use strict';

  const APPLY_MESSAGE = 'BOSUN_HELPER_APPLY_GRAFANA_QUERY';
  const RESULT_MESSAGE = 'BOSUN_HELPER_GRAFANA_QUERY_RESULT';
  const CHANNEL_TOKEN = document.currentScript?.dataset?.channelToken || '';
  const INSTALL_FLAG = '__bosunHelperGrafanaBridgeInstalledV2';
  const MAX_TRAVERSAL_OBJECTS = 250;
  const MAX_TRAVERSAL_DEPTH = 6;
  const MAX_TRAVERSAL_MS = 12;
  const MAX_OPERATION_CACHE = 20;
  const OPERATION_CACHE_TTL_MS = 30000;
  const MAX_QUERY_LENGTH = 100000;
  const operations = new Map();
  let operationQueue = Promise.resolve();
  document.currentScript?.removeAttribute?.('data-channel-token');

  if (!CHANNEL_TOKEN || window[INSTALL_FLAG]) return;
  Object.defineProperty(window, INSTALL_FLAG, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  function normalizeText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getVisibleEditorText() {
    const activeEditor = findQueryEditorContent();
    if (activeEditor) {
      return activeEditor.innerText || activeEditor.textContent || '';
    }

    const textareas = Array.from(document.querySelectorAll('.monaco-editor textarea, textarea'));
    if (textareas.length === 1) return textareas[0].value || '';

    const textboxes = Array.from(document.querySelectorAll('[role="textbox"]'));
    if (textboxes.length === 1) {
      return textboxes[0].innerText || textboxes[0].textContent || '';
    }
    return '';
  }

  function findQueryEditorContent() {
    const codeToggle = Array.from(document.querySelectorAll('button')).find((button) => {
      return button.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() === 'code';
    });
    const queryRow = codeToggle?.closest?.('[class*="query"], [data-testid*="query"], div') || null;
    const queryArea = queryRow?.parentElement || document;

    const editors = Array.from(queryArea.querySelectorAll('.cm-editor .cm-content[contenteditable="true"], .cm-content[contenteditable="true"]'));
    if (editors.length === 1) return editors[0];

    const allEditors = Array.from(document.querySelectorAll('.cm-editor .cm-content[contenteditable="true"], .cm-content[contenteditable="true"]'));
    return allEditors.length === 1 ? allEditors[0] : null;
  }

  function isQueryVisible(query) {
    return normalizeText(getVisibleEditorText()) === normalizeText(query);
  }

  function getCodeMirrorViewFromObject(value, budget) {
    if (!value || typeof value !== 'object') return null;

    if (value.state?.doc && typeof value.dispatch === 'function') {
      return value;
    }

    const seen = new Set();
    const queue = [
      value.view,
      value.editorView,
      value.rootView,
      value.rootView?.view,
      value.cmView,
      value.cmView?.view,
      value.cmView?.rootView,
      value.cmView?.rootView?.view
    ].filter(Boolean).map((item) => ({ item, depth: 0 }));

    while (
      queue.length &&
      budget.visited < MAX_TRAVERSAL_OBJECTS &&
      Date.now() <= budget.deadline
    ) {
      const { item, depth } = queue.shift();
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      budget.visited += 1;

      if (item.state?.doc && typeof item.dispatch === 'function') return item;
      if (depth >= MAX_TRAVERSAL_DEPTH) continue;

      const keys = [];
      try {
        keys.push(...Object.keys(item));
      } catch (_) {}
      try {
        keys.push(...Object.getOwnPropertyNames(item));
      } catch (_) {}

      for (const key of Array.from(new Set(keys)).slice(0, 80)) {
        if (/parent|dom|contentDOM/i.test(key)) continue;
        try {
          const next = item[key];
          if (next && typeof next === 'object' && !seen.has(next)) {
            queue.push({ item: next, depth: depth + 1 });
          }
        } catch (_) {}
      }
    }

    return null;
  }

  function findCodeMirrorView() {
    const content = findQueryEditorContent();
    const editorRoot = content?.closest?.('.cm-editor') || null;
    const nodes = editorRoot
      ? [editorRoot, ...Array.from(editorRoot.querySelectorAll('.cm-content, .cm-scroller'))]
      : [];

    const budget = {
      visited: 0,
      deadline: Date.now() + MAX_TRAVERSAL_MS
    };

    for (const node of nodes.slice(0, 20)) {
      if (budget.visited >= MAX_TRAVERSAL_OBJECTS || Date.now() > budget.deadline) break;
      const keys = [];
      try {
        keys.push(...Object.keys(node));
      } catch (_) {}
      try {
        keys.push(...Object.getOwnPropertyNames(node));
      } catch (_) {}

      const direct = getCodeMirrorViewFromObject(node, budget) ||
        getCodeMirrorViewFromObject(node.cmView, budget);
      if (direct) return direct;

      for (const key of Array.from(new Set(keys)).slice(0, 80)) {
        if (budget.visited >= MAX_TRAVERSAL_OBJECTS || Date.now() > budget.deadline) break;
        let value;
        try {
          value = node[key];
        } catch (_) {
          continue;
        }
        const view = getCodeMirrorViewFromObject(value, budget);
        if (view) return view;
      }
    }

    return null;
  }

  function findButtonByText(text) {
    const needle = text.toLowerCase();
    const matches = Array.from(document.querySelectorAll('button')).filter((button) => {
      const label = button.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() || '';
      return label === needle || label.includes(needle);
    });
    const exact = matches.filter((button) => {
      return button.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() === needle;
    });
    if (exact.length === 1) return exact[0];
    return matches.length === 1 ? matches[0] : null;
  }

  function findPrometheusMonacoModel() {
    const monacoApi = window.monaco;
    const models = monacoApi?.editor?.getModels?.();
    if (!Array.isArray(models) || !models.length) return null;

    const textarea = document.querySelector('textarea.inputarea.monaco-mouse-cursor-text[role="textbox"]');
    const visibleText = textarea?.value || '';

    if (visibleText) {
      const exact = models.find((model) => model?.getValue?.() === visibleText);
      if (exact) return exact;

      const prefix = visibleText.slice(0, 40);
      const partial = models.find((model) => {
        const value = model?.getValue?.() || '';
        return prefix && value.includes(prefix);
      });
      if (partial) return partial;
    }

    const promModels = models.filter((model) => {
      const value = model?.getValue?.() || '';
      return /\b(sum|rate|avg|min|max|count|histogram_quantile)\s*(by|without)?\s*\(/.test(value) ||
        /[a-zA-Z_:][a-zA-Z0-9_:]*\s*\{/.test(value);
    });

    if (promModels.length === 1) return promModels[0];
    if (models.length === 1) return models[0];
    return null;
  }

  function commitMonacoTextarea() {
    const textarea = document.querySelector('textarea.inputarea.monaco-mouse-cursor-text[role="textbox"]');
    if (!textarea) return false;

    textarea.focus();
    textarea.click();
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.blur();

    return true;
  }

  function rollbackMonacoIfUnchanged(model, oldText, writtenText, writtenVersion) {
    let currentText;
    let currentVersion;
    try {
      currentText = model.getValue();
      currentVersion = model.getVersionId?.();
    } catch (_) {
      return false;
    }

    if (currentText !== writtenText) return false;
    if (
      Number.isFinite(writtenVersion) &&
      Number.isFinite(currentVersion) &&
      currentVersion !== writtenVersion
    ) return false;

    try {
      model.setValue(oldText);
      commitMonacoTextarea();
      return true;
    } catch (_) {
      return false;
    }
  }

  function rollbackMonacoIfOwnedVersion(model, oldText, writtenVersion) {
    if (!Number.isFinite(writtenVersion)) return false;
    try {
      if (model.getVersionId?.() !== writtenVersion) return false;
      model.setValue(oldText);
      commitMonacoTextarea();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function applyQueryViaMonaco(query, run) {
    const model = findPrometheusMonacoModel();
    if (!model?.setValue || !model?.getValue) {
      return { ok: false, reason: 'monaco-model-not-found' };
    }

    const oldText = model.getValue();
    let writtenVersion;
    try {
      model.setValue(query);
      writtenVersion = model.getVersionId?.();
      commitMonacoTextarea();
      await wait(500);
      const nextText = model.getValue();
      if (normalizeText(nextText) !== normalizeText(query)) {
        const rolledBack = rollbackMonacoIfOwnedVersion(model, oldText, writtenVersion);
        return {
          ok: false,
          reason: 'monaco-setvalue-not-applied',
          rolledBack,
          terminal: !rolledBack,
          oldLength: oldText.length,
          nextLength: nextText.length
        };
      }

      if (!run) {
        return {
          ok: true,
          via: 'monaco-model',
          oldLength: oldText.length,
          nextLength: nextText.length
        };
      }
      commitMonacoTextarea();
      await wait(500);
      const beforeRunText = model.getValue();
      const beforeRunVersion = model.getVersionId?.();
      if (
        normalizeText(beforeRunText) !== normalizeText(query) ||
        (Number.isFinite(writtenVersion) && Number.isFinite(beforeRunVersion) && beforeRunVersion !== writtenVersion)
      ) {
        return { ok: false, reason: 'monaco-concurrent-change-before-run', terminal: true };
      }
      findButtonByText('Run queries')?.click();

      return {
        ok: true,
        via: 'monaco-model',
        oldLength: oldText.length,
        nextLength: nextText.length
      };
    } catch (err) {
      let currentText = oldText;
      try {
        currentText = model.getValue();
      } catch (_) {}
      const rolledBack = rollbackMonacoIfUnchanged(
        model,
        oldText,
        query,
        writtenVersion
      );
      return {
        ok: false,
        reason: 'monaco-transaction-error',
        rolledBack,
        terminal: currentText !== oldText && !rolledBack,
        message: err?.message || String(err)
      };
    }
  }

  function getEditorText(editor) {
    if (!editor) return '';
    if (typeof editor.innerText === 'string') return editor.innerText;
    return editor.textContent || '';
  }

  function selectEditorContents(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function replaceEditorTextIfUnchanged(editor, expectedText, replacementText) {
    if (getEditorText(editor) !== expectedText) return false;

    try {
      selectEditorContents(editor);
      document.execCommand('delete', false, null);
      if (normalizeText(getEditorText(editor))) return false;
      if (replacementText) {
        document.execCommand('insertText', false, replacementText);
      }
      return normalizeText(getEditorText(editor)) === normalizeText(replacementText);
    } catch (_) {
      return false;
    }
  }

  async function applyQueryViaFocusedEditor(query, run) {
    const editor = findQueryEditorContent();
    if (!editor) return { ok: false, reason: 'query-editor-not-found' };
    const originalText = getEditorText(editor);

    editor.focus();
    editor.click();
    await wait(50);

    try {
      selectEditorContents(editor);
      document.execCommand('delete', false, null);
    } catch (err) {
      const currentText = getEditorText(editor);
      const rolledBack = currentText === originalText || (
        currentText === '' &&
        replaceEditorTextIfUnchanged(editor, currentText, originalText)
      );
      return {
        ok: false,
        reason: 'query-editor-delete-error',
        rolledBack,
        message: err?.message || String(err)
      };
    }
    const immediateTextAfterDelete = getEditorText(editor);
    if (normalizeText(immediateTextAfterDelete)) {
      const rolledBack = immediateTextAfterDelete === originalText;
      return {
        ok: false,
        reason: 'query-editor-delete-failed',
        rolledBack,
        visibleText: normalizeText(getEditorText(editor)).slice(0, 120)
      };
    }
    await wait(100);

    const textAfterDelete = getEditorText(editor);
    if (normalizeText(textAfterDelete)) {
      return {
        ok: false,
        reason: 'query-editor-changed-after-delete',
        rolledBack: false,
        visibleText: normalizeText(textAfterDelete).slice(0, 120)
      };
    }

    try {
      document.execCommand('insertText', false, query);
    } catch (err) {
      const currentText = getEditorText(editor);
      const rolledBack = currentText === originalText || (
        (currentText === '' || currentText === query) &&
        replaceEditorTextIfUnchanged(editor, currentText, originalText)
      );
      return {
        ok: false,
        reason: 'query-editor-insert-error',
        rolledBack,
        message: err?.message || String(err)
      };
    }
    await wait(150);

    const textAfterInsert = getEditorText(editor);
    if (normalizeText(textAfterInsert) !== normalizeText(query)) {
      const rolledBack = textAfterInsert === originalText || (
        textAfterInsert === '' &&
        replaceEditorTextIfUnchanged(editor, textAfterInsert, originalText)
      );
      return {
        ok: false,
        reason: 'query-editor-insert-failed',
        rolledBack,
        visibleText: normalizeText(getEditorText(editor)).slice(0, 120)
      };
    }

    if (!run) return { ok: true, via: 'focused-query-editor' };

    try {
      findButtonByText('Run queries')?.click();
      return { ok: true, via: 'focused-query-editor' };
    } catch (err) {
      const currentText = getEditorText(editor);
      const rolledBack = currentText === originalText || (
        currentText === query &&
        replaceEditorTextIfUnchanged(editor, currentText, originalText)
      );
      return {
        ok: false,
        reason: 'query-editor-run-error',
        rolledBack,
        message: err?.message || String(err)
      };
    }
  }

  async function applyQuery(query, run) {
    const view = findCodeMirrorView();
    if (view) {
      const oldText = view.state.doc.toString();
      view.dispatch({
        changes: { from: 0, to: oldText.length, insert: query },
        selection: { anchor: query.length },
        scrollIntoView: true
      });

      const nextText = view.state.doc.toString();
      if (normalizeText(nextText) === normalizeText(query)) {
        if (run) {
          await wait(150);
          if (normalizeText(view.state.doc.toString()) !== normalizeText(query)) {
            return { ok: false, reason: 'codemirror-concurrent-change-before-run', terminal: true };
          }
          findButtonByText('Run queries')?.click();
        }
        return {
          ok: true,
          via: 'codemirror-view',
          oldLength: oldText.length,
          nextLength: nextText.length
        };
      }

      view.dispatch({
        changes: { from: 0, to: nextText.length, insert: oldText },
        selection: { anchor: oldText.length }
      });
    }

    const monacoResult = await applyQueryViaMonaco(query, run);
    if (monacoResult.ok) return monacoResult;
    if (monacoResult.terminal) return monacoResult;

    const editorResult = await applyQueryViaFocusedEditor(query, run);
    if (editorResult.ok) return editorResult;

    return {
      ok: false,
      reason: 'editor-binding-not-found',
      monacoReason: monacoResult.reason,
      editorReason: editorResult.reason,
      editorVisibleText: editorResult.visibleText
    };
  }

  function pruneOperations() {
    const now = Date.now();
    for (const [operationId, operation] of operations) {
      if (operation.finishedAt && now - operation.finishedAt > OPERATION_CACHE_TTL_MS) {
        operations.delete(operationId);
      }
    }
    while (operations.size > MAX_OPERATION_CACHE) {
      const oldestCompleted = Array.from(operations.entries()).find(([, operation]) => {
        return Boolean(operation.finishedAt);
      });
      if (!oldestCompleted) break;
      operations.delete(oldestCompleted[0]);
    }
  }

  function getOperation(operationId, query, run) {
    pruneOperations();
    const existing = operations.get(operationId);
    if (existing) {
      if (existing.query !== query || existing.run !== run) {
        return Promise.resolve({ ok: false, reason: 'operation-id-collision' });
      }
      return existing.promise;
    }
    if (operations.size >= MAX_OPERATION_CACHE) {
      return Promise.resolve({ ok: false, reason: 'bridge-busy' });
    }

    const operation = { query, run, promise: null, finishedAt: 0 };
    operation.promise = operationQueue
      .catch(() => undefined)
      .then(() => applyQuery(query, run))
      .catch((err) => ({
        ok: false,
        reason: 'unexpected-apply-error',
        message: err?.message || String(err)
      }))
      .finally(() => {
        operation.finishedAt = Date.now();
        pruneOperations();
      });
    operationQueue = operation.promise.then(() => undefined, () => undefined);
    operations.set(operationId, operation);
    return operation.promise;
  }

  window.addEventListener('message', async (event) => {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      event.data?.type !== APPLY_MESSAGE ||
      event.data?.channelToken !== CHANNEL_TOKEN
    ) return;

    const query = typeof event.data.query === 'string' ? event.data.query : '';
    const operationId = typeof event.data.operationId === 'string'
      ? event.data.operationId
      : '';
    const run = event.data.run === true;
    let result;
    try {
      result = !query
        ? { ok: false, reason: 'empty-query' }
        : query.length > MAX_QUERY_LENGTH
          ? { ok: false, reason: 'query-too-large' }
        : !operationId || operationId.length > 200
          ? { ok: false, reason: 'invalid-operation-id' }
          : await getOperation(operationId, query, run);
    } catch (err) {
      result = {
        ok: false,
        reason: 'unexpected-apply-error',
        message: err?.message || String(err)
      };
    }

    window.postMessage({
      type: RESULT_MESSAGE,
      channelToken: CHANNEL_TOKEN,
      requestId: event.data.requestId,
      operationId,
      result
    }, window.location.origin);
  });

  window.postMessage({
    type: RESULT_MESSAGE,
    channelToken: CHANNEL_TOKEN,
    result: { ok: true, ready: true }
  }, window.location.origin);
})();
