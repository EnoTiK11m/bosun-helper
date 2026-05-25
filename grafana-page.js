(() => {
  'use strict';

  const APPLY_MESSAGE = 'BOSUN_HELPER_APPLY_GRAFANA_QUERY';
  const RESULT_MESSAGE = 'BOSUN_HELPER_GRAFANA_QUERY_RESULT';

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
    const nodes = Array.from(document.querySelectorAll('.cm-editor, .cm-content, .cm-scroller'));

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

    if (promModels.length) return promModels[promModels.length - 1];
    return models[models.length - 1] || null;
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

  function getReactProps(node) {
    if (!node) return null;

    const keys = [];
    try {
      keys.push(...Object.keys(node));
    } catch (_) {}
    try {
      keys.push(...Object.getOwnPropertyNames(node));
    } catch (_) {}

    for (const key of keys) {
      if (key.startsWith('__reactProps$')) return node[key];
    }

    return null;
  }

  function getReactFiber(node) {
    if (!node) return null;

    const keys = [];
    try {
      keys.push(...Object.keys(node));
    } catch (_) {}
    try {
      keys.push(...Object.getOwnPropertyNames(node));
    } catch (_) {}

    for (const key of keys) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return node[key];
      }
    }

    return null;
  }

  function collectFiberProps(fiber, out, seen) {
    const stack = [fiber].filter(Boolean);

    while (stack.length && out.length < 250) {
      const item = stack.pop();
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);

      if (item.memoizedProps && typeof item.memoizedProps === 'object') {
        out.push(item.memoizedProps);
      }
      if (item.pendingProps && typeof item.pendingProps === 'object') {
        out.push(item.pendingProps);
      }

      if (item.return) stack.push(item.return);
      if (item.child) stack.push(item.child);
      if (item.sibling) stack.push(item.sibling);
    }
  }

  function createQueryCandidate(props, type, applyFns) {
    return {
      type,
      props,
      applyFns
    };
  }

  function collectGrafanaQueryReactBindings() {
    const nodes = Array.from(document.querySelectorAll('*'));
    const propObjects = [];
    const seenFibers = new Set();

    for (const node of nodes) {
      const props = getReactProps(node);
      if (props && typeof props === 'object') propObjects.push(props);

      collectFiberProps(getReactFiber(node), propObjects, seenFibers);
    }

    const bindings = [];
    const seenProps = new Set();

    for (const props of propObjects) {
      if (!props || typeof props !== 'object' || seenProps.has(props)) continue;
      seenProps.add(props);

      if (props.query?.expr && typeof props.onChange === 'function') {
        bindings.push(createQueryCandidate(props, 'query-onchange', [
          (query) => props.onChange({ ...props.query, expr: query }),
          (query) => props.onChange({ ...props.query, expr: query }, true)
        ]));
      }

      if (props.query && typeof props.query === 'object' && typeof props.onChange === 'function') {
        bindings.push(createQueryCandidate(props, 'query-object-onchange', [
          (query) => props.onChange({ ...props.query, expr: query }),
          (query) => props.onChange({ ...props.query, expression: query }),
          (query) => props.onChange({ ...props.query, query })
        ]));
      }

      if (props.data?.query?.expr && typeof props.onChange === 'function') {
        bindings.push(createQueryCandidate(props, 'data-query-onchange', [
          (query) => props.onChange({ ...props.data.query, expr: query })
        ]));
      }

      if (typeof props.onChangeQuery === 'function' && props.query) {
        bindings.push(createQueryCandidate(props, 'onchange-query', [
          (query) => props.onChangeQuery({ ...props.query, expr: query })
        ]));
      }
    }

    return bindings;
  }

  async function applyQueryViaReact(query) {
    const bindings = collectGrafanaQueryReactBindings();
    if (!bindings.length) {
      return { ok: false, reason: 'react-query-binding-not-found' };
    }

    const errors = [];

    for (const binding of bindings) {
      for (const applyFn of binding.applyFns) {
        try {
          applyFn(query);
          await wait(250);

          if (!isQueryVisible(query)) {
            errors.push({
              type: binding.type,
              message: 'handler-did-not-update-visible-editor'
            });
            continue;
          }

          findButtonByText('Run queries')?.click();

          return {
            ok: true,
            via: binding.type,
            candidates: bindings.length
          };
        } catch (err) {
          errors.push({
            type: binding.type,
            message: err?.message || String(err)
          });
        }
      }
    }

    return {
      ok: false,
      reason: 'react-query-apply-failed',
      candidates: bindings.length,
      errors: errors.slice(0, 5)
    };
  }

  async function applyQueryViaFocusedEditor(query) {
    const editor = findQueryEditorContent();
    if (!editor) return { ok: false, reason: 'query-editor-not-found' };

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
    const monacoResult = await applyQueryViaMonaco(query);
    if (monacoResult.ok) return monacoResult;

    const editorResult = await applyQueryViaFocusedEditor(query);
    if (editorResult.ok) return editorResult;

    const reactResult = await applyQueryViaReact(query);
    if (reactResult.ok) return reactResult;

    const view = findCodeMirrorView();
    if (!view) {
      return {
        ok: false,
        reason: 'editor-binding-not-found',
        monacoReason: monacoResult.reason,
        editorReason: editorResult.reason,
        editorVisibleText: editorResult.visibleText,
        reactReason: reactResult.reason,
        reactErrors: reactResult.errors
      };
    }

    const oldText = view.state.doc.toString();
    view.dispatch({
      changes: { from: 0, to: oldText.length, insert: query },
      selection: { anchor: query.length },
      scrollIntoView: true
    });

    const nextText = view.state.doc.toString();
    if (normalizeText(nextText) !== normalizeText(query)) {
      return {
        ok: false,
        reason: 'replace-not-applied',
        oldLength: oldText.length,
        nextLength: nextText.length
      };
    }

    setTimeout(() => {
      findButtonByText('Run queries')?.click();
    }, 150);

    return {
      ok: true,
      oldLength: oldText.length,
      nextLength: nextText.length
    };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.type !== APPLY_MESSAGE) return;

    const query = typeof event.data.query === 'string' ? event.data.query : '';
    const result = query
      ? await applyQuery(query)
      : { ok: false, reason: 'empty-query' };

    window.postMessage({
      type: RESULT_MESSAGE,
      requestId: event.data.requestId,
      result
    }, '*');
  });

  window.postMessage({ type: RESULT_MESSAGE, result: { ok: true, ready: true } }, '*');
})();
