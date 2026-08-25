(() => {
  'use strict';

  const MAX_CONFIG_LENGTH = 8 * 1024 * 1024;
  const MAX_ALERT_BLOCK_LENGTH = 512 * 1024;
  const MAX_ASSIGNMENTS = 256;
  const MAX_EXPRESSION_LENGTH = 256 * 1024;
  const MAX_PROM_QUERY_LENGTH = 200 * 1024;
  const MAX_ALERT_NAMES = 2000;
  const MAX_HASH_LENGTH = 512;
  const MAX_RESOLVE_DEPTH = 16;
  const MAX_RESOLVE_NODES = 512;
  const MAX_EXPRESSION_TOKENS = 4096;
  const MAX_ALERT_EXPRESSION_TOKENS = 32768;
  const MAX_BATCH_EXPRESSION_TOKENS = 1000000;
  const MAX_SYNTAX_DEPTH = 64;
  const DEFAULT_TIMEOUT_MS = 10000;
  const DEFAULT_HASH_CHECK_INTERVAL_MS = 15000;
  const DEFAULT_FAILURE_RETRY_MS = 60000;
  const MAX_CONFIG_STABILITY_ATTEMPTS = 2;
  const ALERT_NAME_RE = /^[A-Za-z0-9_.\-$/]+$/;
  const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const promqlApi = globalThis.BosunHelperPromQL || null;

  function result(overrides = {}) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'invalid_rule_source',
      source: null,
      query: '',
      queries: [],
      fallbackReason: '',
      ...overrides
    };
  }

  function isIdentifierStart(char) {
    return /[A-Za-z_]/.test(char || '');
  }

  function isIdentifierPart(char) {
    return /[A-Za-z0-9_]/.test(char || '');
  }

  function skipQuoted(source, start) {
    if (source.slice(start, start + 3) === "'''") {
      const end = source.indexOf("'''", start + 3);
      return end < 0 ? -1 : end + 3;
    }
    const quote = source[start];
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && quote !== '`') {
        escaped = true;
        continue;
      }
      if (char === quote) return index + 1;
    }
    return -1;
  }

  function lineEndIndex(source, start) {
    const newline = source.indexOf('\n', start);
    return newline < 0 ? source.length : newline;
  }

  function nextLineIndex(source, lineEnd) {
    return lineEnd < source.length ? lineEnd + 1 : source.length;
  }

  function skipHorizontalWhitespace(source, start, end) {
    let index = start;
    while (index < end && /[ \t\r]/.test(source[index])) index += 1;
    return index;
  }

  function skipRuleWhitespaceAndComments(source, start) {
    let index = start;
    while (index < source.length) {
      if (/\s/.test(source[index])) {
        index += 1;
        continue;
      }
      if (source[index] !== '#') break;
      index = nextLineIndex(source, lineEndIndex(source, index));
    }
    return index;
  }

  function structuralBraceIndexOnLine(source, start, lineEnd) {
    for (let index = start; index < lineEnd; index += 1) {
      if (source[index] === '#') return -1;
      if (source[index] === '{' || source[index] === '}') return index;
    }
    return -1;
  }

  function readStructuralDeclaration(source, statementStart) {
    const start = skipRuleWhitespaceAndComments(source, statementStart);
    if (start >= source.length) return { kind: 'eof', next: source.length };
    const structuralLineEnd = lineEndIndex(source, start);
    if (source[start] === '}') return { kind: 'close', closeIndex: start, next: start + 1 };
    if (source[start] === '{' || source[start] === '=') {
      return { kind: 'ambiguous', failureOffset: start, next: start + 1 };
    }

    let tokenEnd = start;
    while (
      tokenEnd < source.length &&
      !/[\s#={]/.test(source[tokenEnd]) &&
      source[tokenEnd] !== '}'
    ) tokenEnd += 1;
    if (tokenEnd === start) return { kind: 'ambiguous', next: start + 1 };
    const token = source.slice(start, tokenEnd);
    const afterToken = skipRuleWhitespaceAndComments(source, tokenEnd);
    if (source[afterToken] === '=') {
      const valueLineEnd = lineEndIndex(source, afterToken + 1);
      return {
        kind: 'pair',
        token,
        valueStart: skipHorizontalWhitespace(source, afterToken + 1, valueLineEnd),
        lineEnd: valueLineEnd
      };
    }

    if (afterToken >= source.length || source[afterToken] === '{' || source[afterToken] === '}') {
      const braceIndex = structuralBraceIndexOnLine(source, start, structuralLineEnd);
      return {
        kind: braceIndex >= 0 ? 'ambiguous' : 'other',
        failureOffset: braceIndex >= 0 ? braceIndex : start,
        next: nextLineIndex(source, structuralLineEnd)
      };
    }
    let nameEnd = afterToken;
    while (
      nameEnd < source.length &&
      !/[\s#{]/.test(source[nameEnd]) &&
      source[nameEnd] !== '}'
    ) nameEnd += 1;
    const name = source.slice(afterToken, nameEnd);
    const openIndex = skipRuleWhitespaceAndComments(source, nameEnd);
    if (source[openIndex] !== '{') {
      const braceIndex = structuralBraceIndexOnLine(source, start, structuralLineEnd);
      return {
        kind: braceIndex >= 0 ? 'ambiguous' : 'other',
        failureOffset: braceIndex >= 0 ? braceIndex : start,
        next: nextLineIndex(source, structuralLineEnd)
      };
    }
    return { kind: 'section', token, name, openIndex, next: openIndex + 1 };
  }

  function findPromrasTripleQuoteOnLine(source, start, lineEnd) {
    let quote = '';
    let escaped = false;
    for (let index = start; index < lineEnd; index += 1) {
      const char = source[index];
      const triple = index + 2 < lineEnd &&
        char === "'" &&
        source[index + 1] === "'" &&
        source[index + 2] === "'";
      if (quote) {
        if (triple) return -1;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === quote) quote = '';
        continue;
      }
      if (!triple) {
        if (char === '"' || char === "'") quote = char;
        continue;
      }
      let cursor = index - 1;
      while (cursor >= start && /[ \t\r]/.test(source[cursor])) cursor -= 1;
      if (source[cursor] !== '(') continue;
      cursor -= 1;
      while (cursor >= start && /[ \t\r]/.test(source[cursor])) cursor -= 1;
      const nameEnd = cursor + 1;
      while (cursor >= start && /[A-Za-z0-9_]/.test(source[cursor])) cursor -= 1;
      if (
        source.slice(cursor + 1, nameEnd) === 'promras' &&
        !/[A-Za-z0-9_]/.test(source[cursor] || '')
      ) return index;
      return -1;
    }
    return -1;
  }

  function hasRuleVariableAssignmentBefore(source, openingLineEnd, end) {
    for (
      let lineStart = nextLineIndex(source, openingLineEnd);
      lineStart < end;
      lineStart = nextLineIndex(source, lineEndIndex(source, lineStart))
    ) {
      const lineEnd = Math.min(lineEndIndex(source, lineStart), end);
      let cursor = skipHorizontalWhitespace(source, lineStart, lineEnd);
      if (source[cursor] !== '$') continue;
      cursor += 1;
      if (!isIdentifierStart(source[cursor])) continue;
      cursor += 1;
      while (cursor < lineEnd && isIdentifierPart(source[cursor])) cursor += 1;
      cursor = skipHorizontalWhitespace(source, cursor, lineEnd);
      if (source[cursor] === '=') return true;
    }
    return false;
  }

  function scanRulePairValue(source, declaration) {
    if (source[declaration.valueStart] === '`') {
      const closeIndex = source.indexOf('`', declaration.valueStart + 1);
      if (closeIndex < 0) {
        return { ok: false, end: declaration.valueStart, next: -1 };
      }
      return { ok: true, end: closeIndex + 1, next: closeIndex + 1 };
    }

    let scanStart = declaration.valueStart;
    let lineEnd = declaration.lineEnd;
    while (scanStart <= source.length) {
      const openingTriple = findPromrasTripleQuoteOnLine(source, scanStart, lineEnd);
      if (openingTriple < 0) {
        return { ok: true, end: lineEnd, next: nextLineIndex(source, lineEnd) };
      }
      const closeTriple = source.indexOf("'''", openingTriple + 3);
      if (closeTriple < 0) {
        return { ok: true, end: lineEnd, next: nextLineIndex(source, lineEnd) };
      }
      if (hasRuleVariableAssignmentBefore(source, lineEnd, closeTriple)) {
        return { ok: true, end: lineEnd, next: nextLineIndex(source, lineEnd) };
      }
      scanStart = closeTriple + 3;
      lineEnd = lineEndIndex(source, scanStart);
    }
    return { ok: true, end: source.length, next: source.length };
  }

  function skipPairValue(source, declaration) {
    const scanned = scanRulePairValue(source, declaration);
    return scanned.ok ? scanned.next : -1;
  }

  function findSectionClose(source, openIndex) {
    let depth = 1;
    let index = openIndex + 1;
    while (index < source.length) {
      const declaration = readStructuralDeclaration(source, index);
      if (declaration.kind === 'eof') break;
      if (declaration.kind === 'other') {
        index = declaration.next;
        continue;
      }
      if (declaration.kind === 'pair') {
        index = skipPairValue(source, declaration);
        if (index < 0) return -1;
        continue;
      }
      if (declaration.kind === 'section') {
        depth += 1;
        index = declaration.next;
        continue;
      }
      if (declaration.kind === 'close') {
        depth -= 1;
        if (depth === 0) return declaration.closeIndex;
        index = declaration.next;
        continue;
      }
      return -1;
    }
    return -1;
  }

  function findOpaqueSectionClose(source, openIndex) {
    return findSectionClose(source, openIndex);
  }

  function findAlertSectionClose(source, openIndex) {
    return findSectionClose(source, openIndex);
  }

  function extractAlertBlocks(configText, alertNames, options = {}) {
    const source = typeof configText === 'string' ? configText : '';
    const collectAll = options.collectAll === true;
    const names = collectAll ? [] : normalizeAlertNames(alertNames);
    function failure() {
      return { ok: false, reason: 'invalid_rule_source', blocks: new Map() };
    }
    if (
      !source ||
      source.length > MAX_CONFIG_LENGTH ||
      (!collectAll && !names.length)
    ) return failure();

    const targets = new Set(names);
    const blocks = new Map();
    const invalidNames = new Set();
    const indexedNames = new Set();
    for (let index = 0; index < source.length;) {
      const declaration = readStructuralDeclaration(source, index);
      if (declaration.kind === 'eof') break;
      if (declaration.kind === 'other') {
        index = declaration.next;
        continue;
      }
      if (declaration.kind === 'pair') {
        index = skipPairValue(source, declaration);
        if (index < 0) return failure();
        continue;
      }
      if (declaration.kind === 'close' || declaration.kind === 'ambiguous') {
        return failure();
      }
      if (declaration.kind !== 'section') {
        index = nextLineIndex(source, declaration.lineEnd);
        continue;
      }
      if (declaration.token !== 'alert') {
        const closeIndex = findOpaqueSectionClose(source, declaration.openIndex);
        if (closeIndex < 0) return failure();
        index = closeIndex + 1;
        continue;
      }

      const candidateName = declaration.name;
      const cursor = declaration.openIndex;
      const shouldIndex = collectAll
        ? ALERT_NAME_RE.test(candidateName)
        : targets.has(candidateName);
      const closeIndex = findAlertSectionClose(source, cursor);
      if (closeIndex < 0) return failure();
      if (shouldIndex) {
        if (!indexedNames.has(candidateName)) {
          if (indexedNames.size >= MAX_ALERT_NAMES) {
            return failure();
          }
          indexedNames.add(candidateName);
        }
        const body = source.slice(cursor + 1, closeIndex);
        if (body.length > MAX_ALERT_BLOCK_LENGTH || blocks.has(candidateName)) {
          invalidNames.add(candidateName);
          blocks.delete(candidateName);
        } else if (!invalidNames.has(candidateName)) {
          blocks.set(candidateName, body);
        }
      }
      index = closeIndex + 1;
    }

    return { ok: true, reason: '', blocks, invalidNames };
  }

  function extractAlertBlock(configText, alertName) {
    const name = typeof alertName === 'string' ? alertName.trim() : '';
    const extracted = extractAlertBlocks(configText, [name]);
    const body = extracted.blocks?.get(name);
    if (!extracted.ok || !body || extracted.invalidNames?.has(name)) {
      return { ok: false, reason: 'invalid_rule_source', body: '' };
    }
    return { ok: true, reason: '', body };
  }

  function extractAssignments(blockBody) {
    const source = typeof blockBody === 'string' ? blockBody : '';
    const assignments = new Map();
    const orders = new Map();
    let hasMacro = false;
    let lineOnlyIndent = true;
    for (let index = 0; index < source.length;) {
      const char = source[index];
      if (char === '\n') {
        lineOnlyIndent = true;
        index += 1;
        continue;
      }
      if (lineOnlyIndent && /[ \t\r]/.test(char)) {
        index += 1;
        continue;
      }
      if (char === '#') {
        while (index < source.length && source[index] !== '\n') index += 1;
        continue;
      }
      if (!lineOnlyIndent) {
        index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        const next = skipQuoted(source, index);
        if (next < 0) return { ok: false, assignments, orders, hasMacro };
        index = next;
        lineOnlyIndent = false;
        continue;
      }

      if (char === '$') {
        let cursor = index + 1;
        if (!isIdentifierStart(source[cursor])) {
          index += 1;
          continue;
        }
        const nameStart = cursor;
        cursor += 1;
        while (cursor < source.length && isIdentifierPart(source[cursor])) cursor += 1;
        const name = source.slice(nameStart, cursor);
        while (/[ \t\r]/.test(source[cursor] || '')) cursor += 1;
        if (source[cursor] !== '=') {
          index += 1;
          continue;
        }
        const valueLineEnd = lineEndIndex(source, cursor + 1);
        const valueStart = skipHorizontalWhitespace(source, cursor + 1, valueLineEnd);
        const scanned = scanRulePairValue(source, {
          token: `$${name}`,
          valueStart,
          lineEnd: valueLineEnd
        });
        if (!scanned.ok) return { ok: false, assignments, orders, hasMacro };
        const value = source.slice(valueStart, scanned.end).trim();
        if (
          !VARIABLE_NAME_RE.test(name) ||
          !value ||
          value.length > MAX_EXPRESSION_LENGTH ||
          assignments.has(name) ||
          assignments.size >= MAX_ASSIGNMENTS
        ) return { ok: false, assignments, orders, hasMacro };
        assignments.set(name, value);
        orders.set(name, orders.size);
        index = scanned.next < 0 ? source.length : scanned.next;
        lineOnlyIndent = true;
        continue;
      }

      if (source.slice(index, index + 5) === 'macro' && !isIdentifierPart(source[index + 5])) {
        let cursor = index + 5;
        while (/[ \t\r]/.test(source[cursor] || '')) cursor += 1;
        if (source[cursor] === '=') hasMacro = true;
      }
      lineOnlyIndent = false;
      index += 1;
    }
    return { ok: true, assignments, orders, hasMacro };
  }

  class ParseFailure extends Error {
    constructor(reason) {
      super(reason);
      this.reason = reason;
    }
  }

  function tokenizeExpression(expression, diagnostics = null) {
    const source = typeof expression === 'string' ? expression : '';
    if (!source || source.length > MAX_EXPRESSION_LENGTH) throw new ParseFailure('invalid_rule_source');
    const tokens = [];
    let syntaxDepth = 0;
    function addToken(token) {
      if (tokens.length >= MAX_EXPRESSION_TOKENS) {
        throw new ParseFailure('computed_graph');
      }
      tokens.push(token);
      if (diagnostics) diagnostics.tokens = tokens.length;
    }
    for (let index = 0; index < source.length;) {
      const char = source[index];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      if (char === '#') {
        while (index < source.length && source[index] !== '\n') index += 1;
        continue;
      }
      if (source.slice(index, index + 3) === "'''") {
        const end = source.indexOf("'''", index + 3);
        if (end < 0) throw new ParseFailure('invalid_promras');
        addToken({ type: 'string', value: source.slice(index + 3, end), triple: true });
        index = end + 3;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        const end = skipQuoted(source, index);
        if (end < 0) throw new ParseFailure('invalid_rule_source');
        addToken({ type: 'string', value: source.slice(index + 1, end - 1), triple: false });
        index = end;
        continue;
      }
      if (char === '$') {
        let cursor = index + 1;
        if (!isIdentifierStart(source[cursor])) throw new ParseFailure('unresolved_variable');
        cursor += 1;
        while (cursor < source.length && isIdentifierPart(source[cursor])) cursor += 1;
        addToken({ type: 'variable', value: source.slice(index + 1, cursor) });
        index = cursor;
        continue;
      }
      if (/[0-9.]/.test(char)) {
        const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
        if (!match) throw new ParseFailure('computed_graph');
        addToken({ type: 'number', value: match[0] });
        index += match[0].length;
        continue;
      }
      if (isIdentifierStart(char)) {
        let cursor = index + 1;
        while (cursor < source.length && isIdentifierPart(source[cursor])) cursor += 1;
        addToken({ type: 'identifier', value: source.slice(index, cursor) });
        index = cursor;
        continue;
      }
      if ('()+-*/%,'.includes(char)) {
        if (char === '(') {
          syntaxDepth += 1;
          if (syntaxDepth > MAX_SYNTAX_DEPTH) {
            throw new ParseFailure('computed_graph');
          }
        } else if (char === ')') {
          syntaxDepth -= 1;
          if (syntaxDepth < 0) throw new ParseFailure('computed_graph');
        }
        addToken({ type: char, value: char });
        index += 1;
        continue;
      }
      throw new ParseFailure('computed_graph');
    }
    if (syntaxDepth !== 0) throw new ParseFailure('computed_graph');
    addToken({ type: 'eof', value: '' });
    return tokens;
  }

  function uniqueQueries(values) {
    const result = [];
    const seen = new Set();
    for (const value of values || []) {
      if (typeof value !== 'string' || !value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  const SAFE_AGGREGATIONS = new Set(['sum', 'avg', 'min', 'max', 'count', 'group', 'stddev', 'stdvar']);

  function findMatchingParenthesis(source, openIndex) {
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = openIndex; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (char === '(') depth += 1;
      else if (char === ')' && --depth === 0) return index;
    }
    return -1;
  }

  function getQueryOutputSignature(query) {
    const source = String(query || '').trim();
    if (!source) return null;
    const grouped = source.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+by\s*\(([^)]*)\)\s*\(/i);
    if (grouped && SAFE_AGGREGATIONS.has(grouped[1].toLowerCase())) {
      const labels = grouped[2].split(',').map((label) => label.trim()).filter(Boolean);
      if (
        !labels.length ||
        labels.some((label) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) ||
        new Set(labels).size !== labels.length
      ) return null;
      const openIndex = grouped[0].lastIndexOf('(');
      if (findMatchingParenthesis(source, openIndex) !== source.length - 1) return null;
      return null;
    }
    const ungrouped = source.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (ungrouped && SAFE_AGGREGATIONS.has(ungrouped[1].toLowerCase())) {
      const openIndex = ungrouped[0].lastIndexOf('(');
      if (findMatchingParenthesis(source, openIndex) === source.length - 1) return 'labels:';
    }
    return `exact:${source}`;
  }

  function findVariableDependencies(expression) {
    const dependencies = [];
    const seen = new Set();
    const source = typeof expression === 'string' ? expression : '';
    for (const match of source.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        dependencies.push(match[1]);
      }
    }
    return dependencies;
  }

  function hasVariableCycle(selectedName, assignments) {
    const visiting = new Set();
    const visited = new Set();
    let nodes = 0;
    function visit(name, depth) {
      nodes += 1;
      if (nodes > MAX_RESOLVE_NODES || depth > MAX_RESOLVE_DEPTH) return false;
      if (visiting.has(name)) return true;
      if (visited.has(name) || !assignments.has(name)) return false;
      visiting.add(name);
      for (const dependency of findVariableDependencies(assignments.get(name))) {
        if (visit(dependency, depth + 1)) return true;
      }
      visiting.delete(name);
      visited.add(name);
      return false;
    }
    return visit(selectedName, 0);
  }

  function graphValue(prom, queries = [], options = {}) {
    const expression = typeof prom === 'string' ? prom : '';
    if (!expression || expression.length > MAX_PROM_QUERY_LENGTH) return graphError('invalid_promras');
    return {
      type: 'value',
      prom: expression,
      queries: uniqueQueries(queries),
      computed: options.computed === true,
      transformed: options.transformed === true,
      signature: options.signature || null
    };
  }

  function graphMulti(queries) {
    return { type: 'multi', queries: uniqueQueries(queries) };
  }

  function graphError(reason) {
    return { type: 'error', reason };
  }

  function parseGraphExpression(expression, assignments, context) {
    let tokens;
    const tokenDiagnostics = { tokens: 0 };
    let actualTokensRecorded = false;
    try {
      tokens = tokenizeExpression(expression, tokenDiagnostics);
      context.batchWork.actualExpressionTokens += tokenDiagnostics.tokens;
      actualTokensRecorded = true;
      context.expressionTokens += tokens.length;
      context.batchWork.expressionTokens += tokens.length;
      if (
        context.expressionTokens > MAX_ALERT_EXPRESSION_TOKENS ||
        context.batchWork.expressionTokens > MAX_BATCH_EXPRESSION_TOKENS
      ) {
        throw new ParseFailure(
          'computed_graph',
          context.batchWork.expressionTokens > MAX_BATCH_EXPRESSION_TOKENS
            ? 'batch_expression_token_limit'
            : 'alert_expression_token_limit'
        );
      }
    } catch (error) {
      if (!actualTokensRecorded) context.batchWork.actualExpressionTokens += tokenDiagnostics.tokens;
      context.expressionTokens += MAX_EXPRESSION_TOKENS;
      context.batchWork.expressionTokens += MAX_EXPRESSION_TOKENS;
      return graphError(error instanceof ParseFailure ? error.reason : 'computed_graph');
    }
    let offset = 0;

    function current() {
      return tokens[offset] || { type: 'eof', value: '' };
    }

    function consume(type) {
      if (current().type !== type) throw new ParseFailure('computed_graph');
      const token = current();
      offset += 1;
      return token;
    }

    function resolveVariable(name) {
      if (context.stack.includes(name)) return graphError('cyclic_variable');
      if (context.memo.has(name)) return context.memo.get(name);
      context.nodes += 1;
      context.maxDepth = Math.max(context.maxDepth, context.stack.length);
      if (context.nodes > MAX_RESOLVE_NODES || context.stack.length >= MAX_RESOLVE_DEPTH) {
        return graphError(
          'unresolved_variable',
          context.nodes > MAX_RESOLVE_NODES ? 'resolve_node_limit' : 'resolve_depth_limit'
        );
      }
      const value = assignments.get(name);
      if (typeof value !== 'string') return graphError('unresolved_variable');
      const dependencyOrder = context.orders.get(name);
      if (!Number.isInteger(dependencyOrder) || dependencyOrder >= context.currentOrder) {
        return graphError('unresolved_variable');
      }
      const previousOrder = context.currentOrder;
      context.currentOrder = dependencyOrder;
      context.stack.push(name);
      context.maxDepth = Math.max(context.maxDepth, context.stack.length);
      const resolved = parseGraphExpression(value, assignments, context);
      context.stack.pop();
      context.currentOrder = previousOrder;
      context.memo.set(name, resolved);
      return resolved;
    }

    function parseCall(name) {
      consume('(');
      const args = [];
      if (current().type !== ')') {
        while (true) {
          if (current().type === 'string') {
            const token = current();
            offset += 1;
            args.push({ type: 'string', value: token.value, triple: token.triple });
          } else {
            const parsedArgument = parseAdditive();
            if (parsedArgument?.type === 'error') {
              throw new ParseFailure(parsedArgument.reason);
            }
            args.push(parsedArgument);
          }
          if (current().type !== ',') break;
          offset += 1;
        }
      }
      if (current().type !== ')') {
        throw new ParseFailure(name.toLowerCase() === 'promras' ? 'invalid_promras' : 'computed_graph');
      }
      offset += 1;

      const lower = name.toLowerCase();
      if (lower === 'promras') {
        if (
          args.length !== 4 ||
          args[0]?.type !== 'string' ||
          args[0].triple !== true
        ) return graphError('invalid_promras');
        const query = String(args[0].value || '').trim();
        if (!query || query.length > MAX_PROM_QUERY_LENGTH) return graphError('invalid_promras');
        if (/\$[A-Za-z_]/.test(query)) return graphError('unresolved_variable');
        const validated = promqlApi?.applyAlertTagsToPromQuery?.(query, '', '');
        if (validated !== query) return graphError('invalid_promras');
        return graphValue(query, [query], { signature: getQueryOutputSignature(query) });
      }
      if (lower === 'prom') return graphError('legacy_prom');
      if (lower === 'dropna') {
        if (args.length !== 1 || args[0]?.type !== 'value' || !args[0].queries.length) {
          return args.find((arg) => arg?.type === 'error') || graphError('computed_graph');
        }
        return graphValue(args[0].prom, args[0].queries, {
          computed: true,
          transformed: true,
          signature: args[0].signature
        });
      }
      if (lower === 'addtags') {
        const firstError = args.find((arg) => arg?.type === 'error');
        if (firstError) return firstError;
        if (
          args.length !== 2 ||
          args[0]?.type !== 'value' ||
          !args[0].queries.length ||
          args[1]?.type !== 'string'
        ) return graphError('computed_graph');
        return graphValue(args[0].prom, args[0].queries, {
          computed: true,
          transformed: true
        });
      }
      if (lower === 'merge') {
        const firstError = args.find((arg) => arg?.type === 'error');
        if (firstError) return firstError;
        if (args.length < 2 || args.some((arg) => !['value', 'multi'].includes(arg?.type))) {
          return graphError('multi_query_graph');
        }
        const queries = args.flatMap((arg) => arg.queries || []);
        if (uniqueQueries(queries).length < 2) return graphError('computed_graph');
        return graphMulti(queries);
      }
      const firstError = args.find((arg) => arg?.type === 'error');
      return firstError || graphError('computed_graph');
    }

    function parsePrimary() {
      const token = current();
      if (token.type === 'variable') {
        offset += 1;
        return resolveVariable(token.value);
      }
      if (token.type === 'number') {
        offset += 1;
        return graphValue(token.value, []);
      }
      if (token.type === 'identifier') {
        offset += 1;
        if (current().type !== '(') return graphError('computed_graph');
        return parseCall(token.value);
      }
      if (token.type === '(') {
        offset += 1;
        const nested = parseAdditive();
        if (current().type !== ')') throw new ParseFailure('computed_graph');
        offset += 1;
        return nested;
      }
      if (token.type === 'string') {
        offset += 1;
        return { type: 'string', value: token.value, triple: token.triple };
      }
      throw new ParseFailure('computed_graph');
    }

    function parseUnary() {
      const operators = [];
      while (current().type === '+' || current().type === '-') {
        if (operators.length >= MAX_SYNTAX_DEPTH) return graphError('computed_graph');
        operators.push(current().type);
        offset += 1;
      }
      let operand = parsePrimary();
      for (let index = operators.length - 1; index >= 0; index -= 1) {
        if (operand.type !== 'value') return operand.type === 'error' ? operand : graphError('computed_graph');
        operand = graphValue(`(${operators[index]}(${operand.prom}))`, operand.queries, {
          computed: true,
          transformed: operand.transformed,
          signature: operand.signature
        });
      }
      return operand;
    }

    function combine(left, operator, right) {
      if (left.type === 'error') return left;
      if (right.type === 'error') return right;
      if (left.type !== 'value' || right.type !== 'value') return graphError('computed_graph');
      if (!left.queries.length && !right.queries.length) return graphError('computed_graph');
      const leftHasQuery = left.queries.length > 0;
      const rightHasQuery = right.queries.length > 0;
      if (
        leftHasQuery &&
        rightHasQuery &&
        (!left.signature || left.signature !== right.signature)
      ) return graphError('computed_graph');
      const signature = leftHasQuery ? left.signature : right.signature;
      return graphValue(`((${left.prom}) ${operator} (${right.prom}))`, [
        ...left.queries,
        ...right.queries
      ], {
        computed: true,
        transformed: left.transformed || right.transformed,
        signature
      });
    }

    function parseMultiplicative() {
      let value = parseUnary();
      if (value?.type === 'error') throw new ParseFailure(value.reason);
      while (current().type === '*' || current().type === '/' || current().type === '%') {
        const operator = current().type;
        offset += 1;
        value = combine(value, operator, parseUnary());
        if (value?.type === 'error') throw new ParseFailure(value.reason);
      }
      return value;
    }

    function parseAdditive() {
      let value = parseMultiplicative();
      if (value?.type === 'error') throw new ParseFailure(value.reason);
      while (current().type === '+' || current().type === '-') {
        const operator = current().type;
        offset += 1;
        value = combine(value, operator, parseMultiplicative());
        if (value?.type === 'error') throw new ParseFailure(value.reason);
      }
      return value;
    }

    try {
      const parsed = parseAdditive();
      if (current().type !== 'eof') return graphError('computed_graph');
      return parsed;
    } catch (error) {
      return graphError(error instanceof ParseFailure ? error.reason : 'computed_graph');
    }
  }

  function resolveAlertBlockGraph(
    blockBody,
    batchWork = { expressionTokens: 0, actualExpressionTokens: 0 }
  ) {
    if (batchWork.expressionTokens >= MAX_BATCH_EXPRESSION_TOKENS) {
      return result({ kind: 'unsupported', reason: 'computed_graph' });
    }
    const parsed = extractAssignments(blockBody);
    if (!parsed.ok) return result();

    let selectedName = 'usage_graph';
    let source = 'usage_graph';
    let fallbackReason = '';
    if (!parsed.assignments.has(selectedName)) {
      if (parsed.hasMacro) {
        return result({
          kind: 'unsupported',
          reason: 'unresolved_variable',
          source
        });
      }
      if (!parsed.assignments.has('q')) {
        return result({ kind: 'missing', reason: 'no_usage_graph' });
      }
      selectedName = 'q';
      source = 'q';
      fallbackReason = 'no_usage_graph';
    }

    if (hasVariableCycle(selectedName, parsed.assignments)) {
      return result({
        kind: 'unsupported',
        reason: 'cyclic_variable',
        source,
        fallbackReason
      });
    }
    const context = {
      nodes: 0,
      maxDepth: 1,
      stack: [selectedName],
      memo: new Map(),
      expressionTokens: 0,
      batchWork,
      orders: parsed.orders,
      currentOrder: parsed.orders.get(selectedName)
    };
    const resolved = parseGraphExpression(parsed.assignments.get(selectedName), parsed.assignments, context);
    batchWork.maxResolveDepth = Math.max(batchWork.maxResolveDepth || 0, context.maxDepth);
    if (resolved.type === 'error') {
      const invalid = resolved.reason === 'invalid_promras' || resolved.reason === 'invalid_rule_source';
      return result({
        kind: invalid ? 'invalid' : 'unsupported',
        reason: resolved.reason,
        source,
        fallbackReason
      });
    }
    if (resolved.type === 'multi') {
      return result({
        kind: 'multi_query',
        reason: 'multi_query_graph',
        source,
        queries: resolved.queries,
        fallbackReason
      });
    }
    if (resolved.type !== 'value' || !resolved.queries.length || resolved.transformed) {
      return result({
        kind: 'unsupported',
        reason: 'computed_graph',
        source,
        queries: resolved.queries || [],
        fallbackReason
      });
    }
    if (!resolved.prom || resolved.prom.length > MAX_PROM_QUERY_LENGTH) {
      return result({
        kind: 'invalid',
        reason: 'invalid_promras',
        source,
        queries: resolved.queries,
        fallbackReason
      });
    }
    return result({
      ok: true,
      kind: 'single_query',
      reason: resolved.computed ? 'computed_graph' : 'direct_promras',
      source,
      query: resolved.prom,
      queries: resolved.queries,
      fallbackReason
    });
  }

  function resolveAlertGraphs(configText, alertNames) {
    const names = normalizeAlertNames(alertNames);
    const results = new Map();
    if (!names.length) return results;
    const extracted = extractAlertBlocks(configText, names);
    const batchWork = { expressionTokens: 0, actualExpressionTokens: 0 };
    for (const name of names) {
      const body = extracted.blocks?.get(name);
      results.set(
        name,
        extracted.ok && body && !extracted.invalidNames?.has(name)
          ? resolveAlertBlockGraph(body, batchWork)
          : result()
      );
    }
    return results;
  }

  function buildAlertResolutionIndex(configText) {
    const extracted = extractAlertBlocks(configText, [], { collectAll: true });
    if (!extracted.ok) return null;
    const results = new Map();
    const batchWork = {
      expressionTokens: 0,
      actualExpressionTokens: 0,
      maxResolveDepth: 0
    };
    for (const [name, body] of extracted.blocks) {
      if (batchWork.expressionTokens >= MAX_BATCH_EXPRESSION_TOKENS) return null;
      const resolution = resolveAlertBlockGraph(body, batchWork);
      if (batchWork.expressionTokens > MAX_BATCH_EXPRESSION_TOKENS) return null;
      results.set(name, resolution);
    }
    for (const name of extracted.invalidNames || []) results.set(name, result());
    return results;
  }

  function resolveAlertGraph(configText, alertName) {
    const name = typeof alertName === 'string' ? alertName.trim() : '';
    return resolveAlertGraphs(configText, [name]).get(name) || result();
  }

  function normalizeAlertNames(alertNames) {
    const names = [];
    const seen = new Set();
    for (const candidate of Array.isArray(alertNames) ? alertNames : []) {
      const name = typeof candidate === 'string' ? candidate.trim() : '';
      if (!name || !ALERT_NAME_RE.test(name) || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length >= MAX_ALERT_NAMES) break;
    }
    return names;
  }

  async function readBoundedResponseText(response, maxBytes) {
    const reader = response?.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      if (typeof text !== 'string' || text.length > maxBytes) throw new Error('response_too_large');
      return text;
    }
    const decoder = new TextDecoder();
    const chunks = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += Number(value?.byteLength || 0);
      if (receivedBytes > maxBytes) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error('response_too_large');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const text = chunks.join('');
    if (receivedBytes > maxBytes) throw new Error('response_too_large');
    return text;
  }

  function createRuleGraphResolver(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(100, Number(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    const hashCheckIntervalMs = Number.isFinite(options.hashCheckIntervalMs)
      ? Math.max(0, Number(options.hashCheckIntervalMs))
      : DEFAULT_HASH_CHECK_INTERVAL_MS;
    const failureRetryMs = Number.isFinite(options.failureRetryMs)
      ? Math.max(0, Number(options.failureRetryMs))
      : DEFAULT_FAILURE_RETRY_MS;
    const hashUrl = options.hashUrl || '/api/config/running_hash';
    const configUrl = options.configUrl || '/api/config';
    const onInvalidate = typeof options.onInvalidate === 'function' ? options.onInvalidate : () => {};
    let generation = 0;
    let stopGeneration = 0;
    let currentHash = '';
    let rejectedHash = '';
    let loaded = false;
    let verified = false;
    let loading = false;
    let failureReason = 'not_loaded';
    let nextRetryAt = -Infinity;
    let lastHashCheckAt = -Infinity;
    let resolutions = new Map();
    let activeController = null;
    let inFlight = null;
    let destroyed = false;

    function notifyInvalidate(reason) {
      try { onInvalidate(reason); } catch (_) {}
    }

    function clearCache() {
      currentHash = '';
      rejectedHash = '';
      loaded = false;
      verified = false;
      loading = false;
      failureReason = 'not_loaded';
      nextRetryAt = -Infinity;
      lastHashCheckAt = -Infinity;
      resolutions = new Map();
    }

    function snapshot(available, reason = '') {
      const unavailableReason = reason || failureReason || (loading ? 'loading' : 'not_loaded');
      return {
        available,
        reason: available ? '' : unavailableReason,
        hash: available ? currentHash : '',
        count: available ? resolutions.size : 0
      };
    }

    async function fetchHash(controller) {
      const response = await fetchImpl(hashUrl, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!response?.ok) {
        const error = new Error('hash_unavailable');
        error.status = Number(response?.status || 0);
        throw error;
      }
      const length = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(length) && length > 4096) {
        throw new Error('hash_unavailable');
      }
      let data;
      try {
        data = JSON.parse(await readBoundedResponseText(response, 4096));
      } catch (_) {
        throw new Error('hash_unavailable');
      }
      const hash = typeof data?.Hash === 'string' ? data.Hash.trim() : '';
      if (!hash || hash.length > MAX_HASH_LENGTH || /[\u0000-\u001f]/.test(hash)) {
        throw new Error('hash_unavailable');
      }
      return hash;
    }

    async function fetchConfig(controller) {
      const response = await fetchImpl(`${configUrl}?hash=`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/plain' },
        signal: controller.signal
      });
      if (!response?.ok) {
        const error = new Error('config_unavailable');
        error.status = Number(response?.status || 0);
        throw error;
      }
      const length = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(length) && length > MAX_CONFIG_LENGTH) {
        throw new Error('config_unavailable');
      }
      const text = await readBoundedResponseText(response, MAX_CONFIG_LENGTH);
      if (typeof text !== 'string' || !text || text.length > MAX_CONFIG_LENGTH) {
        throw new Error('config_unavailable');
      }
      return text;
    }

    async function runRefresh(refreshOptions, token, controller) {
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let hash = await fetchHash(controller);
        if (token !== generation || destroyed) return snapshot(false, 'stale_result');
        lastHashCheckAt = now();

        if (
          hash === currentHash &&
          loaded &&
          verified &&
          refreshOptions.force !== true
        ) {
          loading = false;
          failureReason = '';
          nextRetryAt = -Infinity;
          return snapshot(true);
        }

        if (
          hash === rejectedHash &&
          !loaded &&
          refreshOptions.force !== true
        ) {
          loading = false;
          verified = false;
          failureReason = 'rule_index_unavailable';
          nextRetryAt = now() + failureRetryMs;
          return snapshot(false, failureReason);
        }

        if (hash !== currentHash) {
          loaded = false;
          verified = false;
          loading = true;
          failureReason = '';
          notifyInvalidate('hash_changed');
        }

        for (let attempt = 0; attempt < MAX_CONFIG_STABILITY_ATTEMPTS; attempt += 1) {
          const configHash = hash;
          const fetchedConfig = await fetchConfig(controller);
          if (token !== generation || destroyed) {
            return snapshot(false, 'stale_result');
          }

          const confirmedHash = await fetchHash(controller);
          if (token !== generation || destroyed) {
            return snapshot(false, 'stale_result');
          }
          lastHashCheckAt = now();
          if (confirmedHash !== configHash) {
            loaded = false;
            verified = false;
            loading = true;
            failureReason = '';
            if (confirmedHash !== currentHash) notifyInvalidate('hash_changed');
            hash = confirmedHash;
            if (attempt + 1 < MAX_CONFIG_STABILITY_ATTEMPTS) continue;
            throw new Error('config_unavailable');
          }

          const builtIndex = buildAlertResolutionIndex(fetchedConfig);
          if (!(builtIndex instanceof Map)) {
            rejectedHash = configHash;
            throw new Error('rule_index_unavailable');
          }
          if (token !== generation || destroyed) {
            return snapshot(false, 'stale_result');
          }
          currentHash = configHash;
          rejectedHash = '';
          resolutions = builtIndex;
          loaded = true;
          verified = true;
          loading = false;
          failureReason = '';
          nextRetryAt = -Infinity;
          return snapshot(true);
        }
        throw new Error('config_unavailable');
      } catch (error) {
        if (token !== generation || destroyed) return snapshot(false, 'stale_result');
        resolutions = new Map();
        loaded = false;
        verified = false;
        loading = false;
        const reason = error?.message === 'hash_unavailable'
          ? 'hash_unavailable'
          : (error?.message === 'rule_index_unavailable'
              ? 'rule_index_unavailable'
              : 'config_unavailable');
        failureReason = reason;
        nextRetryAt = now() + failureRetryMs;
        notifyInvalidate(reason);
        return snapshot(false, reason);
      } finally {
        clearTimeout(timer);
      }
    }

    function refresh(alertNames, refreshOptions = {}) {
      if (destroyed || typeof fetchImpl !== 'function') {
        failureReason = 'config_unavailable';
        return Promise.resolve(snapshot(false, failureReason));
      }
      const names = normalizeAlertNames(alertNames);
      if (!names.length) {
        return Promise.resolve(snapshot(loaded && verified));
      }
      if (refreshOptions.force !== true && failureReason && now() < nextRetryAt) {
        loading = false;
        verified = false;
        return Promise.resolve(snapshot(false, failureReason));
      }
      if (inFlight && refreshOptions.force !== true) {
        return inFlight;
      }
      if (inFlight && refreshOptions.force === true) {
        const queuedStopGeneration = stopGeneration;
        const pending = inFlight;
        return pending.then(() => {
          if (destroyed || queuedStopGeneration !== stopGeneration) {
            return snapshot(false, 'stale_result');
          }
          return refresh(names, { force: true });
        });
      }
      const hashCheckDue = !currentHash || now() - lastHashCheckAt >= hashCheckIntervalMs;
      if (
        refreshOptions.force !== true &&
        refreshOptions.verify !== true &&
        loaded &&
        verified &&
        !hashCheckDue
      ) return Promise.resolve(snapshot(true));

      loading = true;
      const keepVerifiedDuringScheduledCheck = refreshOptions.force !== true &&
        refreshOptions.verify !== true &&
        loaded &&
        verified;
      if (!keepVerifiedDuringScheduledCheck) verified = false;
      failureReason = '';
      if (refreshOptions.verify === true) notifyInvalidate('refresh_started');
      if (refreshOptions.force === true) {
        loaded = false;
        notifyInvalidate('refresh_started');
      }
      const token = ++generation;
      const controller = new AbortController();
      activeController = controller;
      const promise = runRefresh(refreshOptions, token, controller);
      inFlight = promise;
      promise.finally(() => {
        if (inFlight === promise) inFlight = null;
        if (activeController === controller) activeController = null;
      });
      return promise;
    }

    function stop() {
      generation += 1;
      stopGeneration += 1;
      activeController?.abort?.();
      activeController = null;
      inFlight = null;
      clearCache();
      failureReason = 'stopped';
    }

    function destroy() {
      stop();
      destroyed = true;
    }

    function getResolution(alertName) {
      const name = typeof alertName === 'string' ? alertName.trim() : '';
      return loaded && verified && name && resolutions.has(name) ? resolutions.get(name) : null;
    }

    return {
      refresh,
      getResolution,
      getSnapshot: () => snapshot(loaded && verified),
      stop,
      destroy
    };
  }

  globalThis.BosunHelperRuleGraph = {
    MAX_CONFIG_LENGTH,
    MAX_ALERT_BLOCK_LENGTH,
    MAX_ASSIGNMENTS,
    MAX_RESOLVE_DEPTH,
    extractAlertBlock,
    extractAlertBlocks,
    extractAssignments,
    resolveAlertGraph,
    resolveAlertGraphs,
    createRuleGraphResolver
  };
})();
