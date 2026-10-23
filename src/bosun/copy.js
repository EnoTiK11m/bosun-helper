(() => {
  'use strict';

  function createCopyEnhancements({
    window, document, navigator, setTimeout, clearTimeout,
    isFeatureEnabled, clearToolbarStatus,
    getGroupSubjectNode, getChildSubjectNode, isGroupPanel, getPanelTitle,
    getGroupCountNode, parseGroupAlertCount, getAcknowledgedPanels, getGroupPanels, getChildAlertPanels,
    copyButtonClass: COPY_BUTTON_CLASS, copyAllButtonClass: COPY_ALL_BUTTON_CLASS
  }) {
    let bosunSelectionDragState = null;

    function getExpandedChildPanelsForGroup(groupPanel) {
      if (!groupPanel) return [];

      return Array.from(
        groupPanel.querySelectorAll('[ng-bind="child.Subject || child.AlertKey"]')
      );
    }

    function getChildAlertText(nodeOrPanel) {
      const node =
        nodeOrPanel?.getAttribute?.('ng-bind') === 'child.Subject || child.AlertKey'
          ? nodeOrPanel
          : getChildSubjectNode(nodeOrPanel);

      return node?.textContent?.replace(/\s+/g, ' ').trim() || '';
    }

    function getAllChildAlertTextsForGroup(groupPanel) {
      const childNodes = getExpandedChildPanelsForGroup(groupPanel);
      if (!childNodes.length) return [];

      return childNodes
        .map((node) => getChildAlertText(node))
        .filter(Boolean);
    }

    function getAlertTextFromPanel(panel) {
      const groupNode = getGroupSubjectNode(panel);
      if (groupNode) {
        return groupNode.textContent?.replace(/\s+/g, ' ').trim() || '';
      }

      const childNode = getChildSubjectNode(panel);
      if (childNode) {
        return childNode.textContent?.replace(/\s+/g, ' ').trim() || '';
      }

      return '';
    }

    async function copyTextToClipboard(text) {
      if (!text) return false;

      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        // Запасной вариант для окружений без navigator.clipboard
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch (_) {
          return false;
        }
      }
    }

    function flashCopyButtonState(button, ok, errorText = 'Не удалось скопировать') {
      if (!button) return;
      if (button.dataset.flashTimer) {
        clearTimeout(Number(button.dataset.flashTimer));
      }
      const originalTitle = button.dataset.originalTitle || button.title || '';
      const originalText = button.dataset.originalText || button.textContent || '';
      button.dataset.originalTitle = originalTitle;
      button.dataset.originalText = originalText;
      const message = ok ? 'Скопировано' : errorText;
      button.title = message;
      button.textContent = ok ? 'Скопировано' : 'Не скопировано';
      button.dataset.copied = ok ? 'true' : 'false';
      clearToolbarStatus('action-feedback');
      const timerId = setTimeout(() => {
        button.title = originalTitle;
        button.textContent = originalText;
        delete button.dataset.copied;
        delete button.dataset.originalTitle;
        delete button.dataset.originalText;
        delete button.dataset.flashTimer;
      }, ok ? 1200 : 2500);
      button.dataset.flashTimer = String(timerId);
    }

    function ensureCopyButton(panel) {
      if (!isFeatureEnabled('copyButtons')) return;
      const subjectNode = getGroupSubjectNode(panel) || getChildSubjectNode(panel);
      if (!subjectNode) return;

      if (subjectNode.parentElement?.querySelector(`.${COPY_BUTTON_CLASS}`)) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = COPY_BUTTON_CLASS;
      btn.textContent = 'Копировать';
      btn.title = 'Скопировать текст алерта';
      btn.setAttribute('unselectable', 'on');

      btn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const text = getAlertTextFromPanel(panel);
        const ok = await copyTextToClipboard(text);
        flashCopyButtonState(btn, ok);
      });

      subjectNode.insertAdjacentElement('afterend', btn);
    }

    function ensureCopyAllButton(panel) {
      if (!isFeatureEnabled('copyButtons')) return;
      if (!isGroupPanel(panel)) return;

      const title = getPanelTitle(panel);
      const countNode = getGroupCountNode(panel);
      if (!title || !countNode) return;

      const totalCount = parseGroupAlertCount(panel);
      const shouldShow = totalCount >= 2;

      const existing = title.querySelector(`.${COPY_ALL_BUTTON_CLASS}`);
      if (!shouldShow) {
        existing?.remove();
        return;
      }

      if (existing) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = COPY_ALL_BUTTON_CLASS;
      btn.textContent = 'Копировать все';
      btn.title = 'Скопировать все вложенные алерты';
      btn.setAttribute('unselectable', 'on');

      btn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const texts = getAllChildAlertTextsForGroup(panel);
        const payload = texts.join('\n');
        const ok = payload ? await copyTextToClipboard(payload) : false;
        flashCopyButtonState(btn, ok, 'Внимание! Сначала раскрой и проверь!');
      });

      countNode.insertAdjacentElement('afterend', btn);
    }

    function ensureCopyButtons() {
      if (!isFeatureEnabled('copyButtons')) return;
      getAcknowledgedPanels().forEach((panel) => {
        ensureCopyButton(panel);
        ensureCopyAllButton(panel);
      });

      getGroupPanels().forEach((panel) => {
        ensureCopyButton(panel);
        ensureCopyAllButton(panel);
      });

      getChildAlertPanels().forEach((panel) => {
        ensureCopyButton(panel);
      });
    }

    function installSelectionGuard() {
      if (window.__bosunSelectionGuardInstalled) return;
      window.__bosunSelectionGuardInstalled = true;

      document.addEventListener(
        'mousedown',
        (event) => {
          const heading = event.target?.closest?.('.panel-heading');
          if (!heading) return;

          bosunSelectionDragState = {
            x: event.clientX,
            y: event.clientY,
            moved: false,
            heading,
          };
        },
        true
      );

      document.addEventListener(
        'mousemove',
        (event) => {
          if (!bosunSelectionDragState) return;

          const dx = Math.abs(event.clientX - bosunSelectionDragState.x);
          const dy = Math.abs(event.clientY - bosunSelectionDragState.y);
          if (dx > 4 || dy > 4) {
            bosunSelectionDragState.moved = true;
          }
        },
        true
      );

      document.addEventListener(
        'mouseup',
        () => {
          setTimeout(() => {
            bosunSelectionDragState = null;
          }, 0);
        },
        true
      );

      document.addEventListener(
        'click',
        (event) => {
          const heading = event.target?.closest?.('.panel-heading');
          if (!heading) return;

          const selectionText = window.getSelection?.()?.toString?.().trim?.() || '';
          const wasDragSelection =
            bosunSelectionDragState &&
            bosunSelectionDragState.heading === heading &&
            bosunSelectionDragState.moved &&
            selectionText.length > 0;

          if (!wasDragSelection) return;

          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        },
        true
      );
    }

    function getClosestElementFromNode(node) {
      if (!node) return null;
      if (node.nodeType === 1) return node;
      return node.parentElement || null;
    }

    function selectionIsInsideAlertHeading(selection) {
      if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return false;

      const anchorEl = getClosestElementFromNode(selection.anchorNode);
      const focusEl = getClosestElementFromNode(selection.focusNode);
      const anchorHeading = anchorEl?.closest?.('.panel-heading') || null;
      const focusHeading = focusEl?.closest?.('.panel-heading') || null;
      if (anchorHeading || focusHeading) return true;

      for (let i = 0; i < selection.rangeCount; i += 1) {
        const range = selection.getRangeAt(i);
        const commonEl = getClosestElementFromNode(range?.commonAncestorContainer);
        if (!commonEl) continue;
        if (commonEl.closest?.('.panel-heading, .panel-title')) return true;
        if (commonEl.querySelector?.('.panel-heading, .panel-title')) return true;
      }

      return false;
    }

    function normalizeSelectedAlertText(text) {
      return String(text || '')
        .replace(/\u00a0/g, ' ')
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s+/, '').replace(/\s+$/, ''))
        .join('\n')
        .trim();
    }

    function installSelectionCopySanitizer() {
      if (window.__bosunSelectionCopySanitizerInstalled) return;
      window.__bosunSelectionCopySanitizerInstalled = true;

      document.addEventListener(
        'copy',
        (event) => {
          const selection = window.getSelection?.();
          if (!selectionIsInsideAlertHeading(selection)) return;

          const rawText = selection?.toString?.() || '';
          const normalizedText = normalizeSelectedAlertText(rawText);
          if (!normalizedText) return;

          if (event.clipboardData?.setData) {
            event.clipboardData.setData('text/plain', normalizedText);
            event.preventDefault();
            return;
          }

          if (navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(normalizedText).catch(() => {});
          }
        },
        true
      );
    }

    return { copyTextToClipboard, flashCopyButtonState, ensureCopyButtons, installSelectionGuard, installSelectionCopySanitizer };
  }

  globalThis.BosunHelperCopy = { createCopyEnhancements };
})();
