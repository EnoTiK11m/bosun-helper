'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runSingleAlertAgeLayoutScenarios({ client, singleAlertAgeSource, pageUtilsSource, stylesSource }) {
  const singleAlertAgeResult = await evaluate(client, `(() => {
    ${singleAlertAgeSource}
    const fixedNow = Date.parse('2026-08-20T12:00:00Z');
    document.body.innerHTML =
      '<div id="need">' +
        '<div class="panel" data-key="need-single" data-subject="single"><span class="count">1 alerts</span><span class="child-age">43m-ago</span><input type="checkbox" checked></div>' +
        '<div class="panel" data-key="need-multi" data-subject="multi"><span class="count">2 alerts</span></div>' +
        '<div class="panel" data-key="need-unknown" data-subject="unknown"><span class="count">1 alerts</span></div>' +
      '</div>' +
      '<div id="ack"><div class="panel" data-key="ack-single" data-subject="ack single"><span class="count">1 alerts</span></div></div>';
    let countClicks = 0;
    const singleCountNode = document.querySelector('[data-key="need-single"] .count');
    singleCountNode.addEventListener('click', () => { countClicks += 1; });
    const api = BosunHelperSingleAlertAge.createSingleAlertAge({
      now: () => fixedNow,
      normalizeChildren: (value) => Array.isArray(value) ? value : [],
      buildGroupKeyFromData: (group) => group.Key,
      buildGroupKeyFromDom: (panel) => panel.dataset.key,
      getRoots: () => [
        { type: 'NeedAck', root: document.querySelector('#need') },
        { type: 'Acknowledged', root: document.querySelector('#ack') }
      ],
      getGroupPanels: (root) => root.querySelectorAll('.panel'),
      getGroupSubject: (panel) => panel.dataset.subject,
      getGroupCountNode: (panel) => panel.querySelector('.count'),
      getRenderedChildAge: (panel) => panel.querySelector('.child-age')?.textContent
    });
    api.update({ Groups: {
      NeedAck: [
        { Key: 'need-single', Subject: 'single', Children: [{ Ago: '2026-08-20T11:17:00Z' }] },
        { Key: 'need-multi', Subject: 'multi', Children: [{ Ago: '2026-08-20T11:00:00Z' }, { Ago: '2026-08-20T10:00:00Z' }] },
        { Key: 'need-unknown', Subject: 'unknown', Children: [{ Ago: 'not-a-time' }] }
      ],
      Acknowledged: [
        { Key: 'ack-single', Subject: 'ack single', Children: [{ Ago: '2026-08-20T10:00:00Z' }] }
      ]
    }});
    api.refresh();
    const first = {
      single: singleCountNode.textContent,
      multi: document.querySelector('[data-key="need-multi"] .count').textContent,
      unknown: document.querySelector('[data-key="need-unknown"] .count').textContent,
      acknowledged: document.querySelector('[data-key="ack-single"] .count').textContent
    };
    singleCountNode.click();
    api.update({ Groups: {
      NeedAck: [{ Key: 'need-single', Subject: 'single', Children: [{ Ago: '2026-08-18T12:00:00Z' }] }],
      Acknowledged: [{ Key: 'ack-single', Subject: 'ack single', Children: [{ Ago: 'invalid' }] }]
    }});
    document.querySelector('[data-key="need-single"] .child-age').remove();
    api.refresh();
    return {
      first,
      updated: singleCountNode.textContent,
      acknowledgedFallback: document.querySelector('[data-key="ack-single"] .count').textContent,
      sameNodeAndHandler: countClicks === 1,
      checkboxPreserved: document.querySelector('[data-key="need-single"] input').checked
    };
  })()`);
  assert.deepStrictEqual(singleAlertAgeResult.first, {
    single: '43m-ago',
    multi: '2 alerts',
    unknown: '1 alerts',
    acknowledged: '2h-ago'
  });
  assert.strictEqual(singleAlertAgeResult.updated, '2d-ago');
  assert.strictEqual(singleAlertAgeResult.acknowledgedFallback, '1 alerts');
  assert.strictEqual(singleAlertAgeResult.sameNodeAndHandler, true);
  assert.strictEqual(singleAlertAgeResult.checkboxPreserved, true);

  let narrowGroupLayout;
  let wideGroupLayout;
  let checkboxBehavior;
  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false
    });
    narrowGroupLayout = await evaluate(client, `(() => {
      ${stylesSource}
      BosunSilenceHiderStyles.injectStyles({
        hiddenClass: 'test-hidden',
        userCommentFilterHiddenClass: 'test-user-hidden',
        acknowledgedCollapsedClass: 'test-ack-collapsed',
        copyButtonClass: 'bosun-copy-alert-btn',
        copyAllButtonClass: 'bosun-copy-all-alerts-btn',
        copyLastActionButtonClass: 'test-copy-last-action',
        grafanaQueryButtonClass: 'test-grafana-query',
        noSelectClass: 'test-no-select',
        silencedBadgeClass: 'test-silenced',
        oldNoNoteIconClass: 'test-old-note',
        hasNoteIconClass: 'test-has-note',
        topBarId: 'test-top-bar',
        topBarStatusId: 'test-top-status',
        toggleId: 'test-toggle',
        toggleCounterId: 'test-toggle-counter',
        autoRefreshToggleId: 'test-auto-toggle',
        autoRefreshInputId: 'test-auto-input',
        autoRefreshCountdownId: 'test-auto-countdown',
        soundAlertsToggleId: 'test-sound-toggle',
        diagnosticsModalId: 'test-diagnostics-modal',
        diagnosticsLogListId: 'test-diagnostics-list'
      });
      document.body.innerHTML =
        '<style>' +
          'body{margin:8px;font:14px Arial,sans-serif}' +
          '.layout-root{width:calc(100vw - 16px)}' +
          '.panel-heading{padding:10px 15px;border:1px solid #ddd}' +
          '.panel-title{font-size:16px;line-height:1.2}' +
          '.panel-title>a{color:#333;text-decoration:none}' +
        '</style>' +
        '<button id="select-all-layout" type="button">Select all</button>' +
        '<div class="layout-root" ts-ack-group="schedule.Groups.Acknowledged">' +
          '<div class="panel-group"><div class="panel"><div class="panel-heading" id="age-heading"><div class="panel-title" id="age-title">' +
            '<label id="age-checkbox-label" class="pull-right select"><input id="age-checkbox" type="checkbox" aria-label="Select age group"></label>' +
            '<a href="#age"><span id="age-severity" class="fa fa-exclamation-circle" aria-hidden="true">!</span><span class="fa" aria-hidden="true"></span><span id="age-subject" ng-bind="group.Subject">warning: very long alert name with many descriptive words and identifiers that must be shortened on a narrow screen</span>' +
            '<button id="age-copy" class="bosun-copy-alert-btn">Копировать</button><span id="age-value" class="pull-right ng-binding">14h-ago</span></a>' +
          '</div></div></div></div>' +
        '</div>' +
        '<div class="layout-root" ts-ack-group="schedule.Groups.NeedAck">' +
          '<div class="panel-group"><div class="panel"><div class="panel-heading" id="count-heading"><div class="panel-title" id="count-title">' +
            '<label id="count-checkbox-label" class="pull-right select"><input id="count-checkbox" type="checkbox" aria-label="Select count group"></label>' +
            '<a href="#count"><span id="count-subject" ng-bind="group.Subject">critical: another extremely long grouped alert name with enough detail to require truncation at narrow widths</span>' +
            '<button id="count-copy" class="bosun-copy-alert-btn">Копировать</button><span id="count-value" class="pull-right ng-binding">6 alerts</span><button id="copy-all-layout" class="bosun-copy-all-alerts-btn">Копировать все</button></a>' +
          '</div></div></div></div>' +
        '</div>';

      globalThis.__measureBosunGroupLayout = () => {
        function measure(id) {
          const node = document.getElementById(id);
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const range = document.createRange();
          range.selectNodeContents(node);
          return {
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            fragmentCount: node.getClientRects().length,
            textRangeWidth: range.getBoundingClientRect().width,
            whiteSpace: style.whiteSpace,
            overflow: style.overflow,
            textOverflow: style.textOverflow,
            flexShrink: style.flexShrink,
            outlineWidth: style.outlineWidth,
            backgroundColor: style.backgroundColor
          };
        }
        return {
          ageHeading: measure('age-heading'),
          ageTitle: measure('age-title'),
          ageSeverity: measure('age-severity'),
          ageSubject: measure('age-subject'),
          ageCopy: measure('age-copy'),
          ageValue: measure('age-value'),
          ageCheckboxLabel: measure('age-checkbox-label'),
          ageCheckbox: measure('age-checkbox'),
          countHeading: measure('count-heading'),
          countTitle: measure('count-title'),
          countSubject: measure('count-subject'),
          countCopy: measure('count-copy'),
          countValue: measure('count-value'),
          countCheckboxLabel: measure('count-checkbox-label'),
          countCheckbox: measure('count-checkbox'),
          copyAll: measure('copy-all-layout')
        };
      };
      const originalAgeCheckbox = document.getElementById('age-checkbox');
      const originalCountCheckbox = document.getElementById('count-checkbox');
      ${pageUtilsSource}
      const checkboxPageUtils = BosunSilenceHiderPageUtils.createPageUtils();
      checkboxPageUtils.ensureDashboardGroupCheckboxHitAreaGuards();
      checkboxPageUtils.ensureDashboardGroupCheckboxHitAreaGuards();
      let headingClicks = 0;
      document.querySelectorAll('.panel-heading').forEach((heading) => {
        heading.addEventListener('click', () => { headingClicks += 1; });
      });
      document.querySelector('#age-title > a').addEventListener('click', (event) => event.preventDefault());
      for (const checkbox of [originalAgeCheckbox, originalCountCheckbox]) {
        checkbox.addEventListener('click', (event) => event.stopPropagation());
      }
      function hasCheckboxHoverRule(rules, insideHoverMedia = false) {
        for (const rule of Array.from(rules || [])) {
          const isHoverMedia = insideHoverMedia ||
            String(rule.media?.mediaText || '').includes('(hover: hover)');
          if (
            isHoverMedia &&
            rule.selectorText?.includes('label.pull-right.select:hover') &&
            Boolean(rule.style?.backgroundColor) &&
            rule.style.backgroundColor !== 'transparent'
          ) return true;
          if (rule.cssRules && hasCheckboxHoverRule(rule.cssRules, isHoverMedia)) return true;
        }
        return false;
      }
      const checkboxHoverRulePresent = hasCheckboxHoverRule(
        document.getElementById('bosun-silence-hider-styles')?.sheet?.cssRules
      );
      globalThis.__getBosunCheckboxState = () => {
        const ageCheckbox = document.getElementById('age-checkbox');
        const countCheckbox = document.getElementById('count-checkbox');
        const ageLabel = document.getElementById('age-checkbox-label');
        const headingStyle = getComputedStyle(document.querySelector('#age-title').parentElement);
        return {
          originalInputsPreserved: ageCheckbox === originalAgeCheckbox && countCheckbox === originalCountCheckbox,
          ageLabelSize: { width: ageLabel.getBoundingClientRect().width, height: ageLabel.getBoundingClientRect().height },
          ageInputSize: { width: ageCheckbox.getBoundingClientRect().width, height: ageCheckbox.getBoundingClientRect().height },
          ageChecked: ageCheckbox.checked,
          countChecked: countCheckbox.checked,
          outlineWidth: headingStyle.outlineWidth,
          outlineStyle: headingStyle.outlineStyle,
          labelBackground: getComputedStyle(ageLabel).backgroundColor,
          labelBoxShadow: getComputedStyle(ageLabel).boxShadow,
          hoverSupported: matchMedia('(hover: hover)').matches,
          hoverRulePresent: checkboxHoverRulePresent,
          headingClicks
        };
      };
      document.getElementById('select-all-layout').addEventListener('click', (event) => {
        const checked = event.currentTarget.dataset.checked !== 'true';
        event.currentTarget.dataset.checked = String(checked);
        for (const checkbox of [originalAgeCheckbox, originalCountCheckbox]) {
          checkbox.checked = checked;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      return __measureBosunGroupLayout();
    })()`);

    const labelRect = narrowGroupLayout.ageCheckboxLabel.rect;
    const hitAreaPoint = {
      x: labelRect.left + 2,
      y: labelRect.top + (labelRect.height / 2)
    };
    const hitAreaTarget = await evaluate(client, `(() => {
      const target = document.elementFromPoint(${hitAreaPoint.x}, ${hitAreaPoint.y});
      return { id: target?.id || '', tagName: target?.tagName || '' };
    })()`);
    async function clickCheckboxHitArea() {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: hitAreaPoint.x,
        y: hitAreaPoint.y
      });
      await evaluate(client, `new Promise((resolve) => requestAnimationFrame(resolve))`);
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: hitAreaPoint.x,
        y: hitAreaPoint.y,
        button: 'left',
        clickCount: 1
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: hitAreaPoint.x,
        y: hitAreaPoint.y,
        button: 'left',
        clickCount: 1
      });
      await evaluate(client, `new Promise((resolve) => requestAnimationFrame(resolve))`);
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await evaluate(client, `new Promise((resolve) => requestAnimationFrame(resolve))`);
    await evaluate(client, `document.querySelector('#age-title > a').click()`);
    const initialCheckboxState = await evaluate(client, `__getBosunCheckboxState()`);
    await clickCheckboxHitArea();
    const selectedCheckboxState = await evaluate(client, `__getBosunCheckboxState()`);
    await clickCheckboxHitArea();
    const uncheckedCheckboxState = await evaluate(client, `__getBosunCheckboxState()`);
    await evaluate(client, `document.getElementById('age-checkbox').focus()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    });
    const keyboardCheckedState = await evaluate(client, `__getBosunCheckboxState()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    });
    const keyboardUncheckedState = await evaluate(client, `__getBosunCheckboxState()`);
    await evaluate(client, `document.getElementById('select-all-layout').click()`);
    const selectAllCheckedState = await evaluate(client, `__getBosunCheckboxState()`);
    await evaluate(client, `document.getElementById('select-all-layout').click()`);
    const selectAllUncheckedState = await evaluate(client, `__getBosunCheckboxState()`);
    checkboxBehavior = {
      originalInputsPreserved: initialCheckboxState.originalInputsPreserved,
      hitAreaTarget,
      hitAreaOutsideInput: hitAreaPoint.x < narrowGroupLayout.ageCheckbox.rect.left,
      ageLabelSize: initialCheckboxState.ageLabelSize,
      ageInputSize: initialCheckboxState.ageInputSize,
      checkedAfterHitAreaClick: selectedCheckboxState.ageChecked,
      uncheckedAfterSecondClick: !uncheckedCheckboxState.ageChecked,
      hoverBackgroundChanged: selectedCheckboxState.labelBackground !== initialCheckboxState.labelBackground,
      hoverSupported: initialCheckboxState.hoverSupported,
      hoverRulePresent: initialCheckboxState.hoverRulePresent,
      checkedWithKeyboard: keyboardCheckedState.ageChecked,
      uncheckedWithKeyboard: !keyboardUncheckedState.ageChecked,
      keyboardFocusVisible: keyboardCheckedState.labelBoxShadow !== 'none',
      selectedOutlineWidth: selectedCheckboxState.outlineWidth,
      selectedOutlineStyle: selectedCheckboxState.outlineStyle,
      uncheckedOutlineStyle: uncheckedCheckboxState.outlineStyle,
      checkedAfterSelectAll: selectAllCheckedState.ageChecked && selectAllCheckedState.countChecked,
      uncheckedAfterSelectAll: !selectAllUncheckedState.ageChecked && !selectAllUncheckedState.countChecked,
      headingClicksBeforeHitArea: initialCheckboxState.headingClicks,
      headingClicksAfterInteractions: selectAllUncheckedState.headingClicks
    };

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    wideGroupLayout = await evaluate(client, `(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return __measureBosunGroupLayout();
    })()`);
  } finally {
    await client.send('Emulation.clearDeviceMetricsOverride');
  }

  function verticalOverlapRatio(first, second) {
    const overlap = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
    return overlap / Math.max(1, Math.min(first.height, second.height));
  }

  for (const value of [narrowGroupLayout.ageValue, narrowGroupLayout.countValue]) {
    assert.strictEqual(value.whiteSpace, 'nowrap');
    assert.strictEqual(value.flexShrink, '0');
    assert.strictEqual(value.fragmentCount, 1);
    assert.ok(value.rect.width + 1 >= value.textRangeWidth, 'Right-side text was clipped');
  }
  assert.strictEqual(checkboxBehavior.originalInputsPreserved, true);
  assert.strictEqual(checkboxBehavior.hitAreaTarget.id, 'age-checkbox-label');
  assert.strictEqual(checkboxBehavior.hitAreaOutsideInput, true);
  assert.ok(checkboxBehavior.ageLabelSize.width >= 27 && checkboxBehavior.ageLabelSize.height >= 27);
  assert.ok(checkboxBehavior.ageInputSize.width >= 15 && checkboxBehavior.ageInputSize.height >= 15);
  assert.ok(checkboxBehavior.ageLabelSize.width > checkboxBehavior.ageInputSize.width);
  assert.ok(narrowGroupLayout.ageTitle.rect.height < narrowGroupLayout.ageCheckboxLabel.rect.height);
  assert.ok(narrowGroupLayout.countTitle.rect.height < narrowGroupLayout.countCheckboxLabel.rect.height);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.top >= narrowGroupLayout.ageHeading.rect.top);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.bottom <= narrowGroupLayout.ageHeading.rect.bottom);
  assert.ok(narrowGroupLayout.countCheckboxLabel.rect.top >= narrowGroupLayout.countHeading.rect.top);
  assert.ok(narrowGroupLayout.countCheckboxLabel.rect.bottom <= narrowGroupLayout.countHeading.rect.bottom);
  assert.strictEqual(checkboxBehavior.checkedAfterHitAreaClick, true);
  assert.strictEqual(checkboxBehavior.uncheckedAfterSecondClick, true);
  assert.strictEqual(checkboxBehavior.hoverRulePresent, true);
  assert.strictEqual(
    checkboxBehavior.hoverBackgroundChanged,
    checkboxBehavior.hoverSupported,
    checkboxBehavior.hoverSupported
      ? 'Hover-capable browser did not show checkbox hit-area feedback'
      : 'Non-hover browser unexpectedly applied hover-only feedback'
  );
  assert.strictEqual(checkboxBehavior.checkedWithKeyboard, true);
  assert.strictEqual(checkboxBehavior.uncheckedWithKeyboard, true);
  assert.strictEqual(checkboxBehavior.keyboardFocusVisible, true);
  assert.strictEqual(checkboxBehavior.selectedOutlineWidth, '2px');
  assert.strictEqual(checkboxBehavior.selectedOutlineStyle, 'solid');
  assert.strictEqual(checkboxBehavior.uncheckedOutlineStyle, 'none');
  assert.strictEqual(checkboxBehavior.checkedAfterSelectAll, true);
  assert.strictEqual(checkboxBehavior.uncheckedAfterSelectAll, true);
  assert.strictEqual(checkboxBehavior.headingClicksBeforeHitArea, 1);
  assert.strictEqual(checkboxBehavior.headingClicksAfterInteractions, 1);
  for (const subject of [narrowGroupLayout.ageSubject, narrowGroupLayout.countSubject]) {
    assert.strictEqual(subject.whiteSpace, 'nowrap');
    assert.strictEqual(subject.overflow, 'hidden');
    assert.strictEqual(subject.textOverflow, 'ellipsis');
    assert.ok(subject.scrollWidth > subject.clientWidth + 1, 'Long subject was not truncated at narrow width');
    assert.strictEqual(subject.fragmentCount, 1);
  }
  assert.ok(verticalOverlapRatio(narrowGroupLayout.ageValue.rect, narrowGroupLayout.ageCheckbox.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(narrowGroupLayout.countValue.rect, narrowGroupLayout.countCheckbox.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(narrowGroupLayout.ageValue.rect, narrowGroupLayout.ageCheckboxLabel.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(narrowGroupLayout.countValue.rect, narrowGroupLayout.countCheckboxLabel.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(narrowGroupLayout.countValue.rect, narrowGroupLayout.copyAll.rect) >= 0.5);
  assert.ok(narrowGroupLayout.ageValue.rect.right <= narrowGroupLayout.ageTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.ageCheckbox.rect.right <= narrowGroupLayout.ageTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.countCheckbox.rect.right <= narrowGroupLayout.countTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.right <= narrowGroupLayout.ageTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.countCheckboxLabel.rect.right <= narrowGroupLayout.countTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.left <= narrowGroupLayout.ageCheckbox.rect.left);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.right >= narrowGroupLayout.ageCheckbox.rect.right);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.top <= narrowGroupLayout.ageCheckbox.rect.top);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.bottom >= narrowGroupLayout.ageCheckbox.rect.bottom);
  assert.ok(Math.abs(
    (narrowGroupLayout.ageCheckboxLabel.rect.left + narrowGroupLayout.ageCheckboxLabel.rect.width / 2) -
    (narrowGroupLayout.ageCheckbox.rect.left + narrowGroupLayout.ageCheckbox.rect.width / 2)
  ) <= 1);
  assert.ok(Math.abs(
    (narrowGroupLayout.ageCheckboxLabel.rect.top + narrowGroupLayout.ageCheckboxLabel.rect.height / 2) -
    (narrowGroupLayout.ageCheckbox.rect.top + narrowGroupLayout.ageCheckbox.rect.height / 2)
  ) <= 1);
  assert.ok(narrowGroupLayout.ageSubject.rect.right <= narrowGroupLayout.ageValue.rect.left + 1);
  assert.ok(narrowGroupLayout.countSubject.rect.right <= narrowGroupLayout.countValue.rect.left + 1);
  assert.ok(narrowGroupLayout.ageSubject.rect.left - narrowGroupLayout.ageSeverity.rect.right >= 3);
  assert.ok(narrowGroupLayout.ageSubject.rect.left - narrowGroupLayout.ageSeverity.rect.right <= 5);
  assert.ok(narrowGroupLayout.ageValue.rect.right <= narrowGroupLayout.ageCheckbox.rect.left + 1);
  assert.ok(narrowGroupLayout.ageValue.rect.left - narrowGroupLayout.ageCopy.rect.right >= 7);
  assert.ok(narrowGroupLayout.ageValue.rect.left - narrowGroupLayout.ageCopy.rect.right <= 10);
  assert.ok(narrowGroupLayout.ageCheckbox.rect.left - narrowGroupLayout.ageValue.rect.right >= 7);
  assert.ok(narrowGroupLayout.ageCheckbox.rect.left - narrowGroupLayout.ageValue.rect.right <= 10);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.left - narrowGroupLayout.ageValue.rect.right >= 1);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.left - narrowGroupLayout.ageValue.rect.right <= 3);
  assert.ok(narrowGroupLayout.countValue.rect.left - narrowGroupLayout.countCopy.rect.right >= 7);
  assert.ok(narrowGroupLayout.countValue.rect.left - narrowGroupLayout.countCopy.rect.right <= 10);
  assert.ok(narrowGroupLayout.countValue.rect.right <= narrowGroupLayout.copyAll.rect.left + 1);
  assert.ok(narrowGroupLayout.copyAll.rect.right <= narrowGroupLayout.countCheckbox.rect.left + 1);
  assert.ok(narrowGroupLayout.countCheckbox.rect.left - narrowGroupLayout.copyAll.rect.right >= 7);
  assert.ok(narrowGroupLayout.countCheckbox.rect.left - narrowGroupLayout.copyAll.rect.right <= 10);

  assert.ok(wideGroupLayout.ageSubject.rect.width > narrowGroupLayout.ageSubject.rect.width);
  assert.ok(wideGroupLayout.countSubject.rect.width > narrowGroupLayout.countSubject.rect.width);
  assert.ok(wideGroupLayout.ageSubject.scrollWidth <= wideGroupLayout.ageSubject.clientWidth + 1);
  assert.ok(wideGroupLayout.countSubject.scrollWidth <= wideGroupLayout.countSubject.clientWidth + 1);
  assert.ok(verticalOverlapRatio(wideGroupLayout.ageValue.rect, wideGroupLayout.ageCheckbox.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(wideGroupLayout.countValue.rect, wideGroupLayout.countCheckbox.rect) >= 0.5);
  assert.ok(wideGroupLayout.ageValue.rect.left - wideGroupLayout.ageCopy.rect.right >= 7);
  assert.ok(wideGroupLayout.ageCheckbox.rect.left - wideGroupLayout.ageValue.rect.right >= 7);
  assert.ok(wideGroupLayout.countValue.rect.left - wideGroupLayout.countCopy.rect.right >= 7);
  assert.ok(wideGroupLayout.ageSubject.rect.left - wideGroupLayout.ageSeverity.rect.right >= 3);
  assert.ok(wideGroupLayout.ageSubject.rect.left - wideGroupLayout.ageSeverity.rect.right <= 5);
  assert.ok(Math.abs(wideGroupLayout.ageValue.rect.width - narrowGroupLayout.ageValue.rect.width) <= 2);
  assert.ok(Math.abs(wideGroupLayout.countValue.rect.width - narrowGroupLayout.countValue.rect.width) <= 2);
  assert.ok(Math.abs(wideGroupLayout.ageCheckboxLabel.rect.width - narrowGroupLayout.ageCheckboxLabel.rect.width) <= 1);
  assert.ok(Math.abs(wideGroupLayout.ageCheckbox.rect.width - narrowGroupLayout.ageCheckbox.rect.width) <= 1);
};
