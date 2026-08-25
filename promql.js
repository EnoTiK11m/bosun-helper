(() => {
  'use strict';

  const PROMQL_KEYWORDS = new Set([
    'and', 'or', 'unless', 'by', 'without', 'on', 'ignoring',
    'group_left', 'group_right', 'bool', 'offset', 'atan2'
  ]);

  const PROMQL_SCALAR_LITERALS = new Set(['Inf', 'NaN']);

  const LABEL_LIST_KEYWORDS = new Set([
    'by', 'without', 'on', 'ignoring', 'group_left', 'group_right'
  ]);

  const AGGREGATION_OPERATORS = new Set([
    'sum', 'avg', 'min', 'max', 'count', 'group',
    'stddev', 'stdvar', 'topk', 'bottomk', 'quantile', 'count_values'
  ]);
  const MAX_PROM_QUERY_LENGTH = 16 * 1024;
  const MAX_EXPR_LENGTH = 64 * 1024;
  const MAX_TAG_SOURCE_LENGTH = 8 * 1024;
  const MAX_TAG_COUNT = 64;
  const MAX_TAG_NAME_LENGTH = 128;
  const MAX_TAG_VALUE_LENGTH = 1024;

  function isIdentifierStart(char) {
    return typeof char === 'string' && /[A-Za-z_:]/.test(char);
  }

  function isIdentifierPart(char) {
    return typeof char === 'string' && /[A-Za-z0-9_:]/.test(char);
  }

  function escapePromLabelValue(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }

  function splitOutsideQuotedStrings(source, separator = ',') {
    const parts = [];
    let current = '';
    let quote = '';
    let escaped = false;

    for (const char of String(source || '')) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }

      if (char === '\\' && quote) {
        current += char;
        escaped = true;
        continue;
      }

      if (quote) {
        current += char;
        if (char === quote) quote = '';
        continue;
      }

      if (char === '"' || char === "'") {
        current += char;
        quote = char;
        continue;
      }

      if (char === separator) {
        parts.push(current);
        current = '';
        continue;
      }

      current += char;
    }

    parts.push(current);
    return parts;
  }

  function unquoteTagValue(value) {
    const text = String(value || '').trim();
    if (text.length < 2) return text;
    const quote = text[0];
    if ((quote !== '"' && quote !== "'") || text[text.length - 1] !== quote) {
      return text;
    }

    return text.slice(1, -1).replace(/\\(.)/g, '$1');
  }

  function parseAlertTagsStrict(rawTags, alertKey = '') {
    if (rawTags && typeof rawTags === 'object' && !Array.isArray(rawTags)) {
      const tags = [];
      const entries = Object.entries(rawTags);
      if (entries.length > MAX_TAG_COUNT) return { valid: false, tags: [] };
      let serializedLength = 0;
      for (const [name, value] of entries) {
        const stringValue = String(value);
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
          name.length > MAX_TAG_NAME_LENGTH ||
          !['string', 'number', 'boolean'].includes(typeof value) ||
          !stringValue.trim() ||
          stringValue.length > MAX_TAG_VALUE_LENGTH
        ) return { valid: false, tags: [] };
        serializedLength += name.length + stringValue.length + 2;
        if (serializedLength > MAX_TAG_SOURCE_LENGTH) return { valid: false, tags: [] };
        tags.push({ name, value: stringValue });
      }
      return { valid: true, tags };
    }

    if (rawTags != null && typeof rawTags !== 'string') {
      return { valid: false, tags: [] };
    }

    if (
      (typeof rawTags === 'string' && rawTags.length > MAX_TAG_SOURCE_LENGTH) ||
      (typeof alertKey === 'string' && alertKey.length > MAX_TAG_SOURCE_LENGTH)
    ) return { valid: false, tags: [] };

    let source = typeof rawTags === 'string' ? rawTags.trim() : '';
    if (!source && typeof alertKey === 'string') {
      const open = alertKey.indexOf('{');
      const close = alertKey.lastIndexOf('}');
      if ((open >= 0) !== (close >= 0) || (open >= 0 && close <= open)) {
        return { valid: false, tags: [] };
      }
      if (open >= 0) {
        if (
          alertKey.indexOf('{', open + 1) >= 0 ||
          alertKey.indexOf('}', open) !== close ||
          alertKey.slice(close + 1).trim()
        ) return { valid: false, tags: [] };
        source = alertKey.slice(open + 1, close).trim();
      }
    }
    if (!source) return { valid: true, tags: [] };

    const parts = [];
    let current = '';
    let quote = '';
    let escaped = false;
    for (const char of source) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (quote && char === '\\') {
        current += char;
        escaped = true;
        continue;
      }
      if (quote) {
        current += char;
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        current += char;
        quote = char;
        continue;
      }
      if (char === ',') {
        parts.push(current);
        if (parts.length > MAX_TAG_COUNT) return { valid: false, tags: [] };
        current = '';
        continue;
      }
      current += char;
    }
    if (quote || escaped) return { valid: false, tags: [] };
    parts.push(current);
    if (parts.length > MAX_TAG_COUNT) return { valid: false, tags: [] };

    const tags = [];
    const valuesByName = new Map();
    for (const rawPart of parts) {
      const part = rawPart.trim();
      const match = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/);
      if (!match) return { valid: false, tags: [] };
      const rawValue = match[2].trim();
      const first = rawValue[0];
      const quoted = first === '"' || first === "'";
      if (
        !rawValue ||
        match[1].length > MAX_TAG_NAME_LENGTH ||
        (quoted && (rawValue.length < 2 || rawValue[rawValue.length - 1] !== first)) ||
        (!quoted && /["']/.test(rawValue))
      ) return { valid: false, tags: [] };
      const value = unquoteTagValue(rawValue);
      if (!value || value.length > MAX_TAG_VALUE_LENGTH) return { valid: false, tags: [] };
      if (valuesByName.has(match[1])) {
        if (valuesByName.get(match[1]) !== value) return { valid: false, tags: [] };
        continue;
      }
      valuesByName.set(match[1], value);
      tags.push({ name: match[1], value });
    }
    return { valid: true, tags };
  }

  function parseAlertTags(rawTags, alertKey = '') {
    return parseAlertTagsStrict(rawTags, alertKey).tags;
  }

  function parsePromrasCallTail(source, startIndex) {
    let index = startIndex;
    while (/\s/.test(source[index] || '')) index += 1;
    if (source[index] === ')') return { valid: true, endIndex: index + 1 };
    if (source[index] !== ',') return { valid: false, endIndex: index };

    index += 1;
    const argumentsFound = [];
    let current = '';
    let quote = '';
    let escaped = false;
    let comment = false;
    const delimiters = [];

    while (index < source.length) {
      const char = source[index];
      if (comment) {
        if (char === '\n') comment = false;
        index += 1;
        continue;
      }
      if (escaped) {
        current += char;
        escaped = false;
        index += 1;
        continue;
      }
      if (quote) {
        current += char;
        if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        index += 1;
        continue;
      }
      if (char === '#') {
        comment = true;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        current += char;
        index += 1;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') {
        delimiters.push(char);
        current += char;
        index += 1;
        continue;
      }
      if (char === ']' || char === '}') {
        const expected = char === ']' ? '[' : '{';
        if (delimiters.pop() !== expected) return { valid: false, endIndex: index };
        current += char;
        index += 1;
        continue;
      }
      if (char === ')') {
        if (delimiters.length) {
          if (delimiters.pop() !== '(') return { valid: false, endIndex: index };
          current += char;
          index += 1;
          continue;
        }
        argumentsFound.push(current.trim());
        return {
          valid: argumentsFound.length === 3 && argumentsFound.every(Boolean),
          endIndex: index + 1
        };
      }
      if (char === ',' && !delimiters.length) {
        argumentsFound.push(current.trim());
        if (argumentsFound.length >= 3 || !argumentsFound[argumentsFound.length - 1]) {
          return { valid: false, endIndex: index };
        }
        current = '';
        index += 1;
        continue;
      }
      current += char;
      index += 1;
    }

    return { valid: false, endIndex: index };
  }

  function extractPromrasQuery(expr) {
    if (
      typeof expr !== 'string' ||
      !expr.trim() ||
      expr.length > MAX_EXPR_LENGTH
    ) return '';

    const querySectionMatch = expr.match(
      /(?:^|\n)\s*Query:\s*([\s\S]*?)(?=\n\s*[A-Z][A-Za-z0-9 _-]*:\s|$)/i
    );
    const source = querySectionMatch ? querySectionMatch[1] : expr;
    const matches = [];
    const seen = new Set();
    let index = 0;
    let quote = '';
    let escaped = false;
    let comment = false;

    while (index < source.length) {
      const char = source[index];
      if (comment) {
        if (char === '\n') comment = false;
        index += 1;
        continue;
      }
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }
      if (quote) {
        if (char === '\\' && quote !== '`') escaped = true;
        else if (char === quote) quote = '';
        index += 1;
        continue;
      }
      if (char === '#') {
        comment = true;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        index += 1;
        continue;
      }
      if (!isIdentifierStart(char)) {
        index += 1;
        continue;
      }

      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      const identifier = source.slice(start, index).toLowerCase();
      if (identifier !== 'promras' || source[start - 1] === '$' || source[start - 1] === '.') {
        continue;
      }

      let cursor = index;
      while (/\s/.test(source[cursor] || '')) cursor += 1;
      if (source[cursor] !== '(') continue;
      cursor += 1;
      while (/\s/.test(source[cursor] || '')) cursor += 1;
      if (source.slice(cursor, cursor + 3) !== "'''") return '';
      const queryStart = cursor + 3;
      const queryEnd = source.indexOf("'''", queryStart);
      if (queryEnd < 0) return '';
      cursor = queryEnd + 3;
      const tail = parsePromrasCallTail(source, cursor);
      if (!tail.valid) return '';

      const query = source.slice(queryStart, queryEnd).trim();
      if (!query || query.length > MAX_PROM_QUERY_LENGTH) return '';
      if (!seen.has(query)) {
        seen.add(query);
        matches.push(query);
      }
      index = tail.endIndex;
    }

    if (matches.length === 1) return matches[0];
    return '';
  }

  function findClosingBrace(query, openIndex) {
    let quote = '';
    let escaped = false;

    for (let index = openIndex + 1; index < query.length; index += 1) {
      const char = query[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && quote) {
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '}') return index;
    }

    return -1;
  }

  function collectMatcherLabels(matchers) {
    const labels = new Set();
    const parts = splitOutsideQuotedStrings(matchers);
    if (String(matchers || '').trim() && parts.some((part) => !part.trim())) return null;
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const match = trimmed.match(
        /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)$/
      );
      if (!match) return null;
      labels.add(match[1]);
    }
    return labels;
  }

  function hasValidPromQueryStructure(source) {
    const stack = [];
    let quote = '';
    let escaped = false;
    let comment = false;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (comment) {
        if (char === '\n') comment = false;
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (char === '\\' && quote !== '`') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '#') {
        comment = true;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') stack.push(char);
      else if (char === ')' || char === ']' || char === '}') {
        const expected = char === ')' ? '(' : char === ']' ? '[' : '{';
        if (stack.pop() !== expected) return false;
      }
    }
    return !quote && !escaped && stack.length === 0;
  }

  function buildMissingMatchers(tags, existingLabels) {
    return tags
      .filter((tag) => !existingLabels.has(tag.name))
      .map((tag) => `${tag.name}="${escapePromLabelValue(tag.value)}"`);
  }

  function previousIdentifier(query, offset) {
    let index = offset - 1;
    while (index >= 0 && /\s/.test(query[index])) index -= 1;
    const end = index + 1;
    while (index >= 0 && isIdentifierPart(query[index])) index -= 1;
    return query.slice(index + 1, end).toLowerCase();
  }

  function applyAlertTagsToPromQuery(query, rawTags, alertKey = '') {
    const source = typeof query === 'string' ? query : '';
    if (
      !source ||
      source.length > MAX_PROM_QUERY_LENGTH ||
      !hasValidPromQueryStructure(source)
    ) return '';
    const parsedTags = parseAlertTagsStrict(rawTags, alertKey);
    if (!parsedTags.valid) return '';
    const tags = parsedTags.tags;
    if (!tags.length) return source;

    let result = '';
    let index = 0;
    let quote = '';
    let escaped = false;
    let comment = false;
    const parentheses = [];
    function appendResult(value) {
      const text = String(value || '');
      if (result.length + text.length > MAX_PROM_QUERY_LENGTH) return false;
      result += text;
      return true;
    }

    while (index < source.length) {
      const char = source[index];

      if (comment) {
        if (!appendResult(char)) return '';
        if (char === '\n') comment = false;
        index += 1;
        continue;
      }

      if (escaped) {
        if (!appendResult(char)) return '';
        escaped = false;
        index += 1;
        continue;
      }

      if (quote) {
        if (!appendResult(char)) return '';
        if (char === '\\' && quote !== '`') escaped = true;
        else if (char === quote) quote = '';
        index += 1;
        continue;
      }

      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        if (!appendResult(char)) return '';
        index += 1;
        continue;
      }

      if (char === '#') {
        comment = true;
        if (!appendResult(char)) return '';
        index += 1;
        continue;
      }

      if (char === '{') return '';

      if (char === '(') {
        const previous = previousIdentifier(source, index);
        parentheses.push(LABEL_LIST_KEYWORDS.has(previous) ? 'label-list' : 'expression');
        if (!appendResult(char)) return '';
        index += 1;
        continue;
      }

      if (char === ')') {
        parentheses.pop();
        if (!appendResult(char)) return '';
        index += 1;
        continue;
      }

      if (!isIdentifierStart(char)) {
        if (!appendResult(char)) return '';
        index += 1;
        continue;
      }

      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      const identifier = source.slice(start, index);
      const lowerIdentifier = identifier.toLowerCase();

      let lookahead = index;
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead += 1;
      const nextChar = source[lookahead] || '';
      const previousChar = source[start - 1] || '';
      const inLabelList = parentheses[parentheses.length - 1] === 'label-list';
      let nextWordEnd = lookahead;
      while (nextWordEnd < source.length && isIdentifierPart(source[nextWordEnd])) {
        nextWordEnd += 1;
      }
      const nextWord = source.slice(lookahead, nextWordEnd).toLowerCase();

      if (
        PROMQL_KEYWORDS.has(lowerIdentifier) ||
        PROMQL_SCALAR_LITERALS.has(identifier) ||
        inLabelList ||
        previousChar === '$' ||
        previousChar === '.' ||
        /[A-Za-z0-9_:]/.test(previousChar) ||
        nextChar === '(' ||
        (AGGREGATION_OPERATORS.has(lowerIdentifier) && LABEL_LIST_KEYWORDS.has(nextWord))
      ) {
        if (!appendResult(identifier)) return '';
        continue;
      }

      if (nextChar === '{') {
        const closeIndex = findClosingBrace(source, lookahead);
        if (closeIndex < 0) {
          if (!appendResult(source.slice(start))) return '';
          break;
        }

        const whitespace = source.slice(index, lookahead);
        const matchers = source.slice(lookahead + 1, closeIndex);
        const existingLabels = collectMatcherLabels(matchers);
        if (!existingLabels) return '';
        const additions = buildMissingMatchers(tags, existingLabels);
        const trimmedMatchers = matchers.trim();
        const nextMatchers = [trimmedMatchers, additions.join(', ')].filter(Boolean).join(', ');
        if (!appendResult(`${identifier}${whitespace}{${nextMatchers}}`)) return '';
        index = closeIndex + 1;
        continue;
      }

      const additions = buildMissingMatchers(tags, new Set());
      if (!appendResult(additions.length
        ? `${identifier}{${additions.join(', ')}}`
        : identifier)) return '';
    }

    return result;
  }

  globalThis.BosunHelperPromQL = {
    escapePromLabelValue,
    parseAlertTags,
    extractPromrasQuery,
    applyAlertTagsToPromQuery
  };
})();
