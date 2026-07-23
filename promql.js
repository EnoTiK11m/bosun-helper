(() => {
  'use strict';

  const PROMQL_KEYWORDS = new Set([
    'and', 'or', 'unless', 'by', 'without', 'on', 'ignoring',
    'group_left', 'group_right', 'bool', 'offset'
  ]);

  const LABEL_LIST_KEYWORDS = new Set([
    'by', 'without', 'on', 'ignoring', 'group_left', 'group_right'
  ]);

  const AGGREGATION_OPERATORS = new Set([
    'sum', 'avg', 'min', 'max', 'count', 'group',
    'stddev', 'stdvar', 'topk', 'bottomk', 'quantile', 'count_values'
  ]);

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

  function parseAlertTags(rawTags, alertKey = '') {
    if (rawTags && typeof rawTags === 'object' && !Array.isArray(rawTags)) {
      return Object.entries(rawTags)
        .filter(([name, value]) => {
          return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
            value != null &&
            String(value).trim() !== '';
        })
        .map(([name, value]) => ({ name, value: String(value) }));
    }

    let source = typeof rawTags === 'string' ? rawTags.trim() : '';
    if (!source && typeof alertKey === 'string') {
      const open = alertKey.indexOf('{');
      const close = alertKey.lastIndexOf('}');
      if (open >= 0 && close > open) source = alertKey.slice(open + 1, close);
    }

    const tags = [];
    for (const rawPart of splitOutsideQuotedStrings(source)) {
      const part = rawPart.trim();
      const match = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/);
      if (!match) continue;

      const value = unquoteTagValue(match[2]);
      if (!value) continue;
      tags.push({ name: match[1], value });
    }
    return tags;
  }

  function extractPromrasQuery(expr) {
    if (typeof expr !== 'string' || !expr.trim()) return '';

    const querySectionMatch = expr.match(
      /(?:^|\n)\s*Query:\s*([\s\S]*?)(?=\n\s*[A-Z][A-Za-z0-9 _-]*:\s|$)/i
    );
    const source = querySectionMatch ? querySectionMatch[1] : expr;
    const matches = [];
    const seen = new Set();
    const pattern = /promras\(\s*'''([\s\S]*?)'''/gi;

    for (const match of source.matchAll(pattern)) {
      const query = match[1].trim();
      if (!query || seen.has(query)) continue;
      seen.add(query);
      matches.push(query);
    }

    if (matches.length === 1) return matches[0];
    return matches.map((query) => `(${query})`).join(' or ');
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
    for (const part of splitOutsideQuotedStrings(matchers)) {
      const match = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)/);
      if (match) labels.add(match[1]);
    }
    return labels;
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
    const tags = parseAlertTags(rawTags, alertKey);
    if (!source || !tags.length) return source;

    let result = '';
    let index = 0;
    let quote = '';
    let escaped = false;
    let comment = false;
    const parentheses = [];

    while (index < source.length) {
      const char = source[index];

      if (comment) {
        result += char;
        if (char === '\n') comment = false;
        index += 1;
        continue;
      }

      if (escaped) {
        result += char;
        escaped = false;
        index += 1;
        continue;
      }

      if (quote) {
        result += char;
        if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        index += 1;
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        result += char;
        index += 1;
        continue;
      }

      if (char === '#') {
        comment = true;
        result += char;
        index += 1;
        continue;
      }

      if (char === '(') {
        const previous = previousIdentifier(source, index);
        parentheses.push(LABEL_LIST_KEYWORDS.has(previous) ? 'label-list' : 'expression');
        result += char;
        index += 1;
        continue;
      }

      if (char === ')') {
        parentheses.pop();
        result += char;
        index += 1;
        continue;
      }

      if (!isIdentifierStart(char)) {
        result += char;
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
        inLabelList ||
        previousChar === '$' ||
        previousChar === '.' ||
        /[A-Za-z0-9_:]/.test(previousChar) ||
        nextChar === '(' ||
        (AGGREGATION_OPERATORS.has(lowerIdentifier) && LABEL_LIST_KEYWORDS.has(nextWord))
      ) {
        result += identifier;
        continue;
      }

      if (nextChar === '{') {
        const closeIndex = findClosingBrace(source, lookahead);
        if (closeIndex < 0) {
          result += source.slice(start);
          break;
        }

        const whitespace = source.slice(index, lookahead);
        const matchers = source.slice(lookahead + 1, closeIndex);
        const additions = buildMissingMatchers(tags, collectMatcherLabels(matchers));
        const trimmedMatchers = matchers.trim();
        const nextMatchers = [trimmedMatchers, additions.join(', ')].filter(Boolean).join(', ');
        result += `${identifier}${whitespace}{${nextMatchers}}`;
        index = closeIndex + 1;
        continue;
      }

      const additions = buildMissingMatchers(tags, new Set());
      result += additions.length
        ? `${identifier}{${additions.join(', ')}}`
        : identifier;
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
