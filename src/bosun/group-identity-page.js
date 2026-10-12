(() => {
  'use strict';

  // Declarative MAIN script at document_start: both guards precede page listeners.
  // A late injection cannot establish this ordering and must remain unavailable.
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
  const isArray = Array.isArray;
  const matches = Element.prototype.matches;
  const closest = Element.prototype.closest;
  const query = Element.prototype.querySelector;
  const queryAll = Element.prototype.querySelectorAll;
  let authorizedResponse = null, reading = false;
  const own = (object, key) => object && descriptor(object, key)?.value;
  const idOf = value => (typeof value === 'number' || typeof value === 'string') &&
    /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : null;

  // Origin/request nonces alone cannot authenticate same-page replies. Only the
  // exact event created by this closure may reach the isolated response listener.
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
    // Fixed library calls only: no binding parsing/$eval/$apply or model writes.
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
    // No reuse of an ID by a different model group in this same section.
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

  add.call(window, REQUEST, event => {
    stop.call(event); // Only this service event; never a native click/toggle.
    if (reading) return; // No reentrant request can manufacture a nested reply.
    const nonce = detailOf.call(event);
    if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) return;
    reading = true;
    try {
      let identity = null;
      try { identity = read(targetOf.call(event)); } catch (_) { /* Unavailable => fail closed. */ }
      authorizedResponse = new EventConstructor(RESPONSE, {
        detail: stringify({ version: 1, nonce, identity })
      });
      dispatch.call(window, authorizedResponse);
    } finally { authorizedResponse = null; reading = false; }
  }, true);
})();
