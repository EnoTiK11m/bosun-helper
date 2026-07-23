(() => {
  'use strict';

  const APPLY_MESSAGE = 'BOSUN_HELPER_APPLY_GRAFANA_QUERY';
  const RESULT_MESSAGE = 'BOSUN_HELPER_GRAFANA_QUERY_RESULT';
  const CHANNEL_TOKEN = document.currentScript?.dataset?.channelToken || '';
  const INSTALL_FLAG = '__bosunHelperGrafanaBridgeInstalledV2';
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

    const textarea = document.querySelector('.monaco-editor textarea, textarea');
    if (textarea) return textarea.value || '';

    const textbox = document.querySelector('[role="textbox"]');
    return textbox?.innerText || textbox?.textContent || '';
  }

  function findQueryEditorContent() {
    const codeToggle = Array.from(document.querySelectorAll('button')).find((button) => {
      return button.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() === 'code';
    });
    const queryRow = codeToggle?.closest?.('[class*="query"], [data-testid*="query"], div') || null;
    const queryArea = queryRow?.parentElement || document;

    const editors = Array.from(queryArea.querySelectorAll('.cm-editor .cm-content[contenteditable="true"], .cm-content[contenteditable="true"]'));
    if (editors.length) return editors[editors.length - 1];

    const allEditors = Array.from(document.querySelectorAll('.cm-editor .cm-content[contenteditable="true"], .cm-content[contenteditable="true"]'));
    return allEditors[allEditors.length - 1] || null;
  }

  function isQueryVisible(query) {
    return normalizeText(getVisibleEditorText()) === normalizeText(query);
  }

  function getCodeMirrorViewFromObject(value) {
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
    ].filter(Boolean);

    while (queue.length) {
      const item = queue.shift();
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);

      if (item.state?.doc && typeof item.dispatch === 'function') return item;

      const keys = [];
      try {
        keys.push(...Object.keys(item));
      } catch (_) {}
      try {
        keys.push(...Object.getOwnPropertyNames(item));
      } catch (_) {}

      for (const key of keys.slice(0, 80)) {
        if (/parent|dom|contentDOM/i.test(key)) continue;
        try {
          const next = item[key];
          if (next && typeof next === 'object' && !seen.has(next)) queue.push(next);
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

    for (const node of nodes) {
      const keys = [];
      try {
        keys.push(...Object.keys(node));
      } catch (_) {}
      try {
        keys.push(...Object.getOwnPropertyNames(node));
      } catch (_) {}

      const direct = getCodeMirrorViewFromObject(node) || getCodeMirrorViewFromObject(node.cmView);
      if (direct) return direct;

      for (const key of keys) {
        const view = getCodeMirrorViewFromObject(node[key]);
        if (view) return view;
      }
    }

    return null;
  }

  function findButtonByText(text) {
    const needle = text.toLowerCase();
    return Array.from(document.querySelectorAll('button')).find((button) => {
      const label = button.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() || '';
      return label === needle || label.includes(needle);
    }) || null;
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

  async function applyQueryViaMonaco(query) {
    const model = findPrometheusMonacoModel();
    if (!model?.setValue || !model?.getValue) {
      return { ok: false, reason: 'monaco-model-not-found' };
    }

    const oldText = model.getValue();
    model.setValue(query);
    commitMonacoTextarea();
    await wait(500);

    const nextText = model.getValue();
    if (normalizeText(nextText) !== normalizeText(query)) {
      return {
        ok: false,
        reason: 'monaco-setvalue-not-applied',
        oldLength: oldText.length,
        nextLength: nextText.length
      };
    }

    commitMonacoTextarea();
    await wait(500);
    findButtonByText('Run queries')?.click();

    return {
      ok: true,
      via: 'monaco-model',
      oldLength: oldText.length,
      nextLength: nextText.length
    };
  }

  async function applyQueryViaFocusedEditor(query) {
    const editor = findQueryEditorContent();
    if (!editor) return { ok: false, reason: 'query-editor-not-found' };
    const originalText = getVisibleEditorText();

    editor.focus();
    editor.click();
    await wait(50);

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand('delete', false, null);
    await wait(100);

    if (normalizeText(getVisibleEditorText())) {
      return {
        ok: false,
        reason: 'query-editor-delete-failed',
        visibleText: normalizeText(getVisibleEditorText()).slice(0, 120)
      };
    }

    document.execCommand('insertText', false, query);
    await wait(150);

    if (!isQueryVisible(query)) {
      const rollbackSelection = window.getSelection();
      const rollbackRange = document.createRange();
      rollbackRange.selectNodeContents(editor);
      rollbackSelection.removeAllRanges();
      rollbackSelection.addRange(rollbackRange);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, originalText);
      return {
        ok: false,
        reason: 'query-editor-insert-failed',
        visibleText: normalizeText(getVisibleEditorText()).slice(0, 120)
      };
    }

    findButtonByText('Run queries')?.click();
    return { ok: true, via: 'focused-query-editor' };
  }

  async function applyQuery(query) {
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
        setTimeout(() => {
          findButtonByText('Run queries')?.click();
        }, 150);
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

    const monacoResult = await applyQueryViaMonaco(query);
    if (monacoResult.ok) return monacoResult;

    const editorResult = await applyQueryViaFocusedEditor(query);
    if (editorResult.ok) return editorResult;

    return {
      ok: false,
      reason: 'editor-binding-not-found',
      monacoReason: monacoResult.reason,
      editorReason: editorResult.reason,
      editorVisibleText: editorResult.visibleText
    };
  }

  window.addEventListener('message', async (event) => {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      event.data?.type !== APPLY_MESSAGE ||
      event.data?.channelToken !== CHANNEL_TOKEN
    ) return;

    const query = typeof event.data.query === 'string' ? event.data.query : '';
    let result;
    try {
      result = query
        ? await applyQuery(query)
        : { ok: false, reason: 'empty-query' };
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
      result
    }, window.location.origin);
  });

  window.postMessage({
    type: RESULT_MESSAGE,
    channelToken: CHANNEL_TOKEN,
    result: { ok: true, ready: true }
  }, window.location.origin);
})();
