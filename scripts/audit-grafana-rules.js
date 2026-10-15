'use strict';

// Explicit, local-only audit. Never print rule names, query text, tags or source.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

function audit(filename) {
  const context = vm.createContext({});
  for (const file of ['promql.js', 'bosun-rule-graph.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/grafana', file), 'utf8'), context);
  }
  const graph = context.BosunHelperRuleGraph;
  const promql = context.BosunHelperPromQL;
  if (fs.statSync(filename).size > graph.MAX_CONFIG_LENGTH) throw new Error();
  const started = performance.now();
  const source = fs.readFileSync(filename, 'utf8');
  const blocks = graph.extractAlertBlocks(source, [], { collectAll: true });
  if (!blocks.ok || blocks.invalidNames.size) throw new Error();
  const resolutions = graph.resolveAlertGraphs(source, Array.from(blocks.blocks.keys()));
  const summary = {
    alertBlocks: blocks.blocks.size,
    resolvedGraphs: 0,
    rejectedGraphs: {},
    validatedInstantVectors: 0,
    finiteOutputLabels: 0,
    openOutputLabels: 0,
    noOutputLabels: 0,
    otherOutputTypes: {},
    analysisFailures: {},
    graphSources: {},
    elapsedMs: 0
  };
  const increment = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
  for (const resolution of resolutions.values()) {
    if (!resolution.ok) {
      increment(summary.rejectedGraphs, resolution.reason);
      continue;
    }
    summary.resolvedGraphs += 1;
    increment(summary.graphSources, resolution.reason);
    const analysis = promql.analyzePromQuery(resolution.query);
    if (!analysis.ok) increment(summary.analysisFailures, analysis.reason);
    else if (analysis.type !== 'vector') increment(summary.otherOutputTypes, analysis.type);
    else {
      summary.validatedInstantVectors += 1;
      if (analysis.labels === null) summary.openOutputLabels += 1;
      else if (analysis.labels.length) summary.finiteOutputLabels += 1;
      else summary.noOutputLabels += 1;
    }
  }
  summary.elapsedMs = Math.round(performance.now() - started);
  return summary;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error();
    process.stdout.write(`${JSON.stringify(audit(process.argv[2]), null, 2)}\n`);
  } catch (_) {
    // Exceptions from private input must not reach logs.
    process.stderr.write('Local rule audit failed: provide one readable, bounded RuleConf with unique alert blocks.\n');
    process.exitCode = 1;
  }
}

module.exports = { audit };
