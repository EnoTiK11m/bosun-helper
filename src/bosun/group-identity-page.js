(() => {
  'use strict';

  // Декларативный MAIN-скрипт на document_start: обе защиты устанавливаются раньше обработчиков страницы.
  // Позднее внедрение не гарантирует этот порядок; в таком случае читатель недоступен.
  if (document.readyState !== 'loading') return;
  const REQUEST = 'bosun-helper-group-identity-read-v1';
  const RESPONSE = 'bosun-helper-group-identity-result-v1';
  const add = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const stop = Event.prototype.stopImmediatePropagation;
  const targetOf = Object.getOwnPropertyDescriptor(Event.prototype, 'target').get;
  const detailOf = Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail').get;
  const EventConstructor = CustomEvent;
  const stringify = JSON.stringify;
  const descriptor = Object.getOwnPropertyDescriptor;
  const prototypeOf = Object.getPrototypeOf;
  const isArray = Array.isArray;
  const matches = Element.prototype.matches;
  const closest = Element.prototype.closest;
  const query = Element.prototype.querySelector;
  const queryAll = Element.prototype.querySelectorAll;
  let authorizedResponse = null, reading = false;
  const own = (object, key) => object && descriptor(object, key)?.value;
  const idOf = value => (typeof value === 'number' || typeof value === 'string') &&
    /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : null;

  // Одних origin и случайных значений запроса недостаточно для аутентификации ответов той же страницы. Только
  // событие, созданное этим замыканием, может достигнуть изолированного обработчика ответа.
  add.call(window, RESPONSE, event => {
    if (event !== authorizedResponse) stop.call(event);
  }, true);

  function read(panel) {
    if (location.pathname !== '/' || !panel?.isConnected || !matches.call(panel, '.panel-group > .panel')) return null;
    const root = closest.call(panel, '[ts-ack-group]');
    const binding = root?.getAttribute('ts-ack-group');
    const section = binding === 'schedule.Groups.NeedAck' ? 'NeedAck'
      : binding === 'schedule.Groups.Acknowledged' ? 'Acknowledged' : null;
    const heading = query.call(panel, ':scope > .panel-heading');
    if (!section || !heading || !query.call(heading, '[ng-bind="group.Subject"]') ||
      queryAll.call(document.documentElement, `[ts-ack-group="${binding}"]`).length !== 1) return null;
    const angular = own(window, 'angular');
    if (typeof own(angular, 'element') !== 'function') return null;
    // Только фиксированные вызовы библиотеки: без разбора привязок, $eval/$apply и записи в модели.
    const scope = angular.element(panel).scope();
    const sectionScope = angular.element(root).isolateScope();
    const group = own(scope, 'group'), groups = own(sectionScope, 'groups');
    if (!group || !isArray(groups) || groups.length > 500 ||
      groups.filter(candidate => candidate === group).length !== 1) return null;
    const peers = queryAll.call(root, '.panel-group > .panel');
    if (peers.length > 1000) return null;
    for (const peer of peers) {
      if (peer === panel) continue;
      const peerHeading = query.call(peer, ':scope > .panel-heading');
      if (peerHeading && query.call(peerHeading, '[ng-bind="group.Subject"]') &&
        own(angular.element(peer).scope(), 'group') === group) return null;
    }
    const children = own(group, 'Children');
    if (!isArray(children) || !children.length || children.length > 100) return null;
    const result = [], ids = new Set();
    for (const child of children) {
      const state = own(child, 'State'), id = idOf(own(state, 'Id'));
      const key = own(child, 'AlertKey'), stateKey = own(state, 'AlertKey');
      const effectiveKey = key ?? stateKey;
      if (!id || ids.has(id) || typeof effectiveKey !== 'string' || !effectiveKey || effectiveKey.length > 2048 ||
        (key != null && stateKey != null && key !== stateKey)) return null;
      ids.add(id); result.push({ id, key: effectiveKey });
    }
    // ID не должен использоваться другой модельной группой в той же секции.
    let examined = 0;
    for (const candidate of groups) {
      if (candidate === group) continue;
      const rows = own(candidate, 'Children');
      if (!isArray(rows)) return null;
      for (const row of rows) {
        if (++examined > 5000 || ids.has(idOf(own(own(row, 'State'), 'Id')))) return null;
      }
    }
    if (location.pathname !== '/' || !panel.isConnected || query.call(panel, ':scope > .panel-heading') !== heading ||
      closest.call(panel, '[ts-ack-group]') !== root || root.getAttribute('ts-ack-group') !== binding ||
      own(scope, 'group') !== group || own(group, 'Children') !== children ||
      !groups.includes(group)) return null;
    return { section, children: result };
  }

  // Операция только для возраста. Старый читатель родителя выше сохраняет свой контракт.
  function readExpandedSingleton(panel, reject) {
    const identity = read(panel);
    if (!identity) return reject('parent-reader-rejected');
    if (identity.children.length !== 1) return reject('parent-not-singleton');
    const angular = own(window, 'angular');
    const root = closest.call(panel, '[ts-ack-group]');
    const heading = query.call(panel, ':scope > .panel-heading');
    const visible = queryAll.call(panel, '[ng-repeat="child in group.Children"]');
    if (visible.length !== 1) return reject('visible-child-count');
    const childPanel = visible[0], childHeading = query.call(childPanel, ':scope > .panel-heading');
    if (!matches.call(childPanel, '.panel') || !childHeading ||
      closest.call(childPanel.parentElement, '[ng-repeat="group in groups"]') !== panel) return reject('visible-child-structure');
    const idNodes = queryAll.call(childHeading, 'span[ng-show="state.Id"]');
    if (idNodes.length !== 1) return reject('visible-id-count');
    const idNode = idNodes[0], idText = idNode.textContent;
    const visibleId = /^#\s*([1-9]\d{0,15}):?$/.exec(idText.trim())?.[1];
    const scope = angular.element(panel).scope(), childScope = angular.element(childPanel).scope();
    const groups = own(angular.element(root).isolateScope(), 'groups');
    const group = own(scope, 'group'), children = own(group, 'Children');
    const child = own(childScope, 'child'), state = own(child, 'State');
    const key = own(child, 'AlertKey'), stateKey = own(state, 'AlertKey');
    const id = idOf(own(state, 'Id'));
    if (!isArray(groups) || groups.filter(row => row === group).length !== 1) return reject('parent-model-membership');
    if (!isArray(children) || children.length !== 1) return reject('parent-child-count');
    if (!childScope) return reject('child-scope-unavailable');
    if (!child) {
      // Только диагностическая классификация: унаследованные привязки и аксессоры не используются
      // для определения идентичности. Читаем дескрипторы, не вызывая getter модели.
      if (own(descriptor(childScope, 'child'), 'get')) return reject('child-binding-accessor');
      let prototype = prototypeOf(childScope);
      for (let depth = 0; prototype && depth < 8; depth++, prototype = prototypeOf(prototype)) {
        const binding = descriptor(prototype, 'child');
        if (binding) return reject(own(binding, 'value') === own(children, '0')
          ? 'child-binding-inherited-parent' : 'child-binding-inherited-other');
      }
      return reject('child-binding-missing');
    }
    if (own(children, '0') !== child) return reject('child-parent-reference-mismatch');
    if (id !== identity.children[0].id) return reject('child-id-mismatch');
    if (!visibleId) return reject('visible-id-format');
    if (visibleId !== id) return reject('visible-id-mismatch');
    if ((key ?? stateKey) !== identity.children[0].key) return reject('child-alertkey-mismatch');
    if (key != null && stateKey != null && key !== stateKey) return reject('child-alertkey-conflict');
    const alias = own(childScope, 'state');
    if (alias != null && alias !== state) {
      const sameId = idOf(own(alias, 'Id')) === id, aliasKey = own(alias, 'AlertKey');
      return reject(sameId && aliasKey === (key ?? stateKey) ? 'state-alias-same-identity'
        : (sameId && aliasKey == null ? 'state-alias-same-id-no-key' : 'state-alias-reference-mismatch'));
    }

    // Вызовы Angular могут повторно войти в код страницы. Сначала повторно читаем принадлежность scope,
    // затем проверяем все сохранённые ссылки DOM/модели и значения идентичности.
    const finalIdentity = read(panel);
    const finalScope = angular.element(panel).scope(), finalChildScope = angular.element(childPanel).scope();
    const finalGroups = own(angular.element(root).isolateScope(), 'groups');
    const finalVisible = queryAll.call(panel, '[ng-repeat="child in group.Children"]');
    if (own(window, 'angular') !== angular) return reject('angular-changed');
    if (finalScope !== scope) return reject('parent-scope-changed');
    if (finalChildScope !== childScope) return reject('child-scope-changed');
    if (finalGroups !== groups) return reject('group-membership-changed');
    if (own(scope, 'group') !== group || own(group, 'Children') !== children || children.length !== 1 || own(children, '0') !== child)
      return reject('parent-model-changed');
    if (own(childScope, 'child') !== child || own(child, 'State') !== state) return reject('child-model-changed');
    if (idOf(own(state, 'Id')) !== id) return reject('child-id-changed');
    if (own(child, 'AlertKey') !== key || own(state, 'AlertKey') !== stateKey) return reject('child-alertkey-changed');
    if (own(childScope, 'state') != null && own(childScope, 'state') !== state) return reject('state-alias-changed');
    if (!finalIdentity) return reject('parent-recheck-rejected');
    if (finalIdentity.section !== identity.section || finalIdentity.children.length !== 1 ||
      finalIdentity.children[0].id !== id || finalIdentity.children[0].key !== identity.children[0].key) return reject('identity-changed');
    if (!panel.isConnected || !childPanel.isConnected || closest.call(panel, '[ts-ack-group]') !== root ||
      closest.call(childPanel.parentElement, '[ng-repeat="group in groups"]') !== panel ||
      query.call(panel, ':scope > .panel-heading') !== heading ||
      finalVisible.length !== 1 || finalVisible[0] !== childPanel ||
      query.call(childPanel, ':scope > .panel-heading') !== childHeading ||
      queryAll.call(childHeading, 'span[ng-show="state.Id"]').length !== 1 ||
      query.call(childHeading, 'span[ng-show="state.Id"]') !== idNode || idNode.textContent !== idText) return reject('dom-changed');
    return identity;
  }

  function serve(request, reader) {
    add.call(window, request, event => {
      stop.call(event); // Только это служебное событие; штатные click/toggle не затрагиваем.
      if (reading) return; // Повторный вход с запросом не может создать вложенный ответ.
      const nonce = detailOf.call(event);
      if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) return;
      reading = true;
      try {
        let identity = null, reason = null;
        const ageOnly = reader === readExpandedSingleton;
        try { identity = ageOnly ? reader(targetOf.call(event), code => { reason = code; return null; }) : reader(targetOf.call(event)); }
        catch (_) { if (ageOnly) reason = 'reader-exception'; /* Текст исключений не передаётся через мост. */ }
        authorizedResponse = new EventConstructor(RESPONSE, {
          detail: stringify({ version: 1, nonce, identity, ...(ageOnly && identity === null ? { reason: reason || 'unknown' } : {}) })
        });
        dispatch.call(window, authorizedResponse);
      } finally { authorizedResponse = null; reading = false; }
    }, true);
  }
  serve(REQUEST, read);
  serve('bosun-helper-age-expanded-identity-read-v1', readExpandedSingleton);
})();
