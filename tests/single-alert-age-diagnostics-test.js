'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const timers = new Map();
const observers = [];
let sequence = 0;
const context = vm.createContext({
  setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
  clearTimeout(id) { timers.delete(id); },
  document: { body: {} },
  MutationObserver: class {
    constructor(callback) { this.callback = callback; this.stopped = false; observers.push(this); }
    observe(_root, options) { this.options = options; }
    disconnect() { this.stopped = true; }
    takeRecords() { return []; }
  }
});
vm.runInContext(fs.readFileSync('src/bosun/single-alert-age.js', 'utf8'), context);
const privateMarker = 'PRIVATE_SENTINEL_NEVER_EXPORT';
const fixedNow = Date.parse('2026-10-16T12:00:00Z');
const ago = new Date(fixedNow - 14 * 60000).toISOString();
const panel = { key: privateMarker, subject: privateMarker, strong: true, count: 1,
  node: { textContent: '1 alerts', dataset: {}, childNodes: [] } };
const panels = [panel];
const api = context.BosunHelperSingleAlertAge.createSingleAlertAge({
  now: () => fixedNow,
  buildGroupKeyFromData: group => group.Key,
  buildGroupKeyFromDom: row => row.key,
  getRoots: () => [{ type: 'NeedAck', root: {} }],
  getGroupPanels: () => panels,
  getGroupSubject: row => row.subject,
  getGroupCountNode: row => row.node,
  getDomChildCount: row => row.count,
  hasStrongDomIdentity: row => row.strong
});
const payload = key => ({ Groups: { NeedAck: [{ Key: key, Subject: privateMarker,
  Children: [{ Ago: ago, State: { Id: 1122334455 }, AlertKey: privateMarker }] }] } });
api.update(payload(privateMarker), { source: 'prime' }); api.refresh();
assert.strictEqual(panel.node.textContent, '14m-ago');
assert.strictEqual(api.diagnostics.report().active, false);
assert.strictEqual(timers.size, 0);
assert.strictEqual(observers.length, 0);
const historyBefore = api.getHistoryStats().entries;
api.diagnostics.start({ durationMs: 999999 });
assert.strictEqual(timers.values().next().value.ms, 120000);
assert.strictEqual(panel.node.textContent, '14m-ago');
assert.strictEqual(api.getHistoryStats().entries, historyBefore);
assert.strictEqual(api.diagnostics.report().panels[1].identityReason, 'group-key');
assert.strictEqual(api.diagnostics.report().panels[1].presentationReason, 'matched');
api.diagnostics.received(payload('different'), 'regular');
assert.strictEqual(api.diagnostics.report().snapshotApplied, false);
api.update(payload('different'), { source: 'leader' }); api.refresh();
let report = api.diagnostics.report();
assert.strictEqual(report.panels[1].identityReason, 'strong-key-mismatch');
assert.strictEqual(report.panels[1].presentationReason, 'dom-child-count-mismatch');
assert.strictEqual(report.panels[1].restoreCountCalled, true);
assert.strictEqual(report.panels[1].restoreCountApplied, true);
assert.strictEqual(report.panels[1].state, 'count');
api.diagnostics.received(payload(privateMarker), 'regular');
api.update(payload(privateMarker), { source: 'leader' }); api.refresh();
report = api.diagnostics.report();
assert.strictEqual(report.panels[1].generation, 3);
assert.strictEqual(report.panels[1].identityReason, 'group-key');
assert.strictEqual(report.panels[1].state, 'age');
assert.ok(report.events.some(row => row.generation === 2 && row.restoreCountApplied === true));
assert.ok(report.events.some(row => row.generation === 3 && row.result === 'age-displayed'));
const originalNode = panel.node; panel.node = null;
api.refresh();
assert.strictEqual(api.diagnostics.report().panels[1].presentationReason, 'count-node-missing');
panel.node = originalNode;
for (let i = 0; i < 2100; i += 1) api.diagnostics.received({}, privateMarker);
report = api.diagnostics.report();
assert.strictEqual(report.events.length, 2000);
assert.ok(report.droppedEvents > 0);
const serialized = JSON.stringify(report);
for (const forbidden of [privateMarker, ago, '1122334455', '14m-ago', '1 alerts', 'subjectHash',
  'groupKeyHash', 'AlertKey', '"Subject":', '"Ago":', 'https://', 'payload']) assert.ok(!serialized.includes(forbidden), forbidden);
assert.ok(report.events.some(row => row.event === 'snapshot-received' && row.source === 'other'));
report.events.length = 0;
assert.ok(api.diagnostics.report().events.length > 0, 'Report must be a detached copy');
api.diagnostics.stop();
assert.strictEqual(timers.size, 0);
assert.strictEqual(observers[0].stopped, true);
const stopped = JSON.stringify(api.diagnostics.report());
api.update(payload(privateMarker)); api.refresh();
assert.strictEqual(JSON.stringify(api.diagnostics.report()), stopped, 'Stopped reports must remain frozen');
api.diagnostics.start({ durationMs: 1000 });
timers.values().next().value.fn();
assert.strictEqual(api.diagnostics.report().active, false);
assert.strictEqual(timers.size, 0);
assert.ok(observers.every(observer => observer.stopped));
api.diagnostics.clear();
assert.strictEqual(api.diagnostics.report().active, false);
assert.strictEqual(panel.node.textContent, '14m-ago');
panels.splice(0, 1, ...Array.from({ length: 600 }, () => ({ ...panel,
  node: { textContent: '1 alerts', dataset: {}, childNodes: [] } })));
api.diagnostics.start();
report = api.diagnostics.report();
assert.strictEqual(report.domPanelsFound, 600);
assert.strictEqual(report.panelCount, 512);
assert.strictEqual(Object.keys(report.panels).length, 512);
assert.strictEqual(report.panelLimitReached, true);
api.diagnostics.failed(privateMarker);
report = api.diagnostics.report();
assert.strictEqual(report.snapshotReceived, false);
assert.strictEqual(report.snapshotApplied, false);
assert.strictEqual(report.events.at(-1).event, 'snapshot-fetch-failed');
assert.strictEqual(report.events.at(-1).source, 'other');
api.diagnostics.clear();
assert.strictEqual(timers.size, 0);
// Subject normalization is diagnostic only, including collisions and raw DOM text.
let syntheticTime = fixedNow;
const collapsed = { raw: 'synthetic whitespace', node: { textContent: '1 alerts', dataset: {}, childNodes: [] } };
const whitespaceApi = context.BosunHelperSingleAlertAge.createSingleAlertAge({
  now: () => syntheticTime,
  getRoots: () => [{ type: 'NeedAck', root: {} }], getGroupPanels: () => [collapsed],
  getGroupSubject: row => row.raw.replace(/\s+/g, ' ').trim(), getRawGroupSubject: row => row.raw,
  getGroupCountNode: row => row.node
});
const whitespacePayload = subjects => ({ Groups: { NeedAck: subjects.map(Subject => ({ Subject, Children: [{ Ago: ago }] })) } });
for (const separator of [' ', '  ', '\n', '\t', '\u00a0', '\u2003']) {
  syntheticTime = fixedNow;
  whitespaceApi.update(whitespacePayload(['synthetic whitespace'])); whitespaceApi.refresh();
  whitespaceApi.diagnostics.start();
  const text = 'synthetic' + separator + 'whitespace'; collapsed.raw = text;
  whitespaceApi.update(whitespacePayload([text])); whitespaceApi.refresh();
  const observation = whitespaceApi.diagnostics.report().panels[1];
  assert.strictEqual(observation.exactSubjectMatch, separator === ' ');
  assert.strictEqual(observation.rawDomSubjectExactMatch, true);
  assert.strictEqual(observation.whitespaceNormalizedMatch, true);
  assert.strictEqual(observation.identityReason, separator === ' ' ? 'unique-subject' : 'missing-candidate');
  whitespaceApi.diagnostics.clear();
}
collapsed.raw = '  synthetic whitespace\n';
whitespaceApi.update(whitespacePayload(['\t synthetic whitespace\u00a0'])); whitespaceApi.refresh();
whitespaceApi.diagnostics.start();
assert.strictEqual(whitespaceApi.diagnostics.report().panels[1].identityReason, 'unique-subject');
whitespaceApi.update(whitespacePayload(['synthetic  whitespace', 'synthetic\twhitespace'])); whitespaceApi.refresh();
const collision = whitespaceApi.diagnostics.report().panels[1];
assert.strictEqual(collision.candidateCountAfterNormalization, 2);
assert.strictEqual(collision.candidateCountInCurrentSection, 0);
assert.strictEqual(collision.identityReason, 'missing-candidate', 'Normalization must not become a matching fallback');
whitespaceApi.diagnostics.clear();
assert.strictEqual(timers.size, 0);
// Transient child-ID comparison must never provide a rendering fallback.
const oldSubject = 'synthetic lifecycle original';
const stablePanel = { node: { textContent: '1 alerts', dataset: {}, childNodes: [] } };
const stableApi = context.BosunHelperSingleAlertAge.createSingleAlertAge({
  now: () => fixedNow, getRoots: () => [{ type: 'NeedAck', root: {} }], getGroupPanels: () => [stablePanel],
  getGroupSubject: () => oldSubject, getGroupCountNode: row => row.node,
  buildGroupKeyFromData: group => group.Subject + ':' + JSON.stringify(group.Children.map(child => child.State?.Id))
});
const child = Id => ({ State: { Id }, Ago: ago });
const group = (Subject, ids) => ({ Subject, Children: ids.map(child) });
const snapshot = (NeedAck, Acknowledged = []) => ({ Groups: { NeedAck, Acknowledged } });
const original = snapshot([group(oldSubject, [1122334455])]);
function inspectLifecycle(next, previousPayload = original, baseline = original) {
  stableApi.diagnostics.clear(); stableApi.update(baseline); stableApi.refresh(); stableApi.diagnostics.start();
  stableApi.update(next, { source: 'follower', previousPayload }); stableApi.refresh();
  const result = stableApi.diagnostics.report();
  const event = result.events.find(row => row.event === 'snapshot-index-comparison');
  assert.ok(event);
  for (const forbidden of [oldSubject, 'synthetic lifecycle renamed', '1122334455', ago, 'State', '"Subject":', '"Id":']) {
    assert.ok(!JSON.stringify(result).includes(forbidden), forbidden);
  }
  return { event, row: result.panels[1] };
}
let lifecycle = inspectLifecycle(snapshot([group('synthetic lifecycle renamed', [1122334455])]));
assert.strictEqual(lifecycle.event.previousStableChildIdAvailable, true);
assert.strictEqual(lifecycle.event.stableChildFoundInNewSnapshot, true);
assert.strictEqual(lifecycle.event.stableChildMatchCount, 1);
assert.strictEqual(lifecycle.event.sameStableChildDifferentSubject, true);
assert.strictEqual(lifecycle.event.sameStableChildDifferentGroupKey, true);
assert.strictEqual(lifecycle.event.previousGroupDisappeared, false);
assert.strictEqual(lifecycle.row.identityReason, 'missing-candidate');
assert.strictEqual(lifecycle.row.presentationReason, 'preserved-mapping');
lifecycle = inspectLifecycle(snapshot([], [group('synthetic lifecycle renamed', ['1122334455'])]));
assert.strictEqual(lifecycle.event.sameStableChildDifferentSection, true);
assert.strictEqual(lifecycle.event.stableChildMatchCount, 1, 'Numeric and canonical string IDs agree');
lifecycle = inspectLifecycle(snapshot([group('synthetic lifecycle renamed', [1122334455, 1122334466])]));
assert.strictEqual(lifecycle.event.stableChildDestinationHasAdditionalChildren, true);
assert.strictEqual(lifecycle.event.stableChildDestinationGroupCount, 1);
lifecycle = inspectLifecycle(snapshot([group('synthetic lifecycle renamed', [1122334455])], [group('synthetic lifecycle duplicate', [1122334455])]));
assert.strictEqual(lifecycle.event.stableChildMatchCount, 2);
assert.strictEqual(lifecycle.event.stableChildIdAmbiguous, true);
assert.strictEqual(lifecycle.event.previousGroupDisappeared, false);
lifecycle = inspectLifecycle(snapshot([group('synthetic lifecycle replacement', [1122334477])]));
assert.strictEqual(lifecycle.event.stableChildComparisonComplete, true);
assert.strictEqual(lifecycle.event.stableChildFoundInNewSnapshot, false);
assert.strictEqual(lifecycle.event.previousGroupDisappeared, true);
lifecycle = inspectLifecycle(snapshot([group(oldSubject, [1122334477])]));
assert.strictEqual(lifecycle.event.stableChildFoundInNewSnapshot, false);
assert.strictEqual(lifecycle.event.previousGroupDisappeared, false, 'A retained subject prevents a disappearance claim');
assert.strictEqual(lifecycle.row.identityReason, 'unique-subject');
for (const badId of [null, 0, -1, 'unknown', Number.MAX_SAFE_INTEGER + 1]) {
  lifecycle = inspectLifecycle(snapshot([group('synthetic lifecycle replacement', [badId])]));
  assert.strictEqual(lifecycle.event.stableChildComparisonComplete, false);
  assert.strictEqual(lifecycle.event.previousGroupDisappeared, false);
}
lifecycle = inspectLifecycle({ Groups: { NeedAck: [] } });
assert.strictEqual(lifecycle.event.stableChildComparisonComplete, false);
assert.strictEqual(lifecycle.event.previousGroupDisappeared, false);
lifecycle = inspectLifecycle(snapshot([]), null);
assert.strictEqual(lifecycle.event.previousStableChildIdAvailable, false);
assert.strictEqual(lifecycle.event.previousGroupDisappeared, false);
const withoutId = snapshot([group(oldSubject, [null])]);
lifecycle = inspectLifecycle(snapshot([]), withoutId, withoutId);
assert.strictEqual(lifecycle.event.previousStableChildIdAvailable, false);
assert.strictEqual(lifecycle.event.previousGroupDisappeared, false);
const multiple = snapshot([group(oldSubject, [1122334455, 1122334466])]);
lifecycle = inspectLifecycle(snapshot([group('synthetic lifecycle renamed', [1122334455]),
  group('synthetic lifecycle split', [1122334466])]), multiple, multiple);
assert.strictEqual(lifecycle.event.stableChildDestinationGroupCount, 2);
assert.strictEqual(lifecycle.event.allPreviousStableChildrenFound, true);
assert.strictEqual(lifecycle.event.stableChildIdAmbiguous, false);
stableApi.diagnostics.clear();
assert.strictEqual(timers.size, 0);
const changedTime = snapshot([group(oldSubject, [1122334455])]);
changedTime.Groups.NeedAck[0].Children[0].Ago = new Date(fixedNow - 5 * 60000).toISOString();
changedTime.Groups.NeedAck[0].Children[0].State.Events = [{ Time: changedTime.Groups.NeedAck[0].Children[0].Ago }];
changedTime.Groups.NeedAck[0].Children[0].State.Start = new Date(fixedNow - 86400000).toISOString();
lifecycle = inspectLifecycle(changedTime);
assert.strictEqual(lifecycle.event.sameGroupKeyAgoComparable, true);
assert.strictEqual(lifecycle.event.sameGroupKeyAgoTimestampChanged, true);
assert.strictEqual(lifecycle.event.stableChildAgoComparable, true);
assert.strictEqual(lifecycle.event.stableChildAgoChanged, true);
assert.strictEqual(lifecycle.event.stableChildAgoMovedForward, true);
assert.strictEqual(lifecycle.row.ageSource, 'snapshot-child');
assert.strictEqual(lifecycle.row.snapshotLastEventTimePresent, true);
assert.strictEqual(lifecycle.row.snapshotChildAgoMatchesLastEvent, true);
assert.strictEqual(lifecycle.row.snapshotChildAgoMatchesIncidentStart, false);
changedTime.Groups.NeedAck[0].Subject = 'synthetic lifecycle renamed';
lifecycle = inspectLifecycle(changedTime);
assert.strictEqual(lifecycle.event.sameGroupKeyAgoComparable, false);
assert.strictEqual(lifecycle.event.stableChildAgoChanged, true);
assert.strictEqual(lifecycle.row.ageSource, 'preserved-snapshot-child');
stableApi.diagnostics.clear();
console.log('Single Alert Age diagnostics tests passed (snapshot lifecycle, separate reasons, privacy, bounds, timeout and cleanup).');
