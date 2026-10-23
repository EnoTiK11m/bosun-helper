(() => {
  'use strict';

  const AGGREGATION_OPERATORS = new Set([
    'sum', 'avg', 'min', 'max', 'count', 'group', 'stddev', 'stdvar',
    'topk', 'bottomk', 'quantile', 'count_values', 'limitk', 'limit_ratio'
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
      .replace(/[\u0000-\u001f\u007f]/g, (char) => {
        const escapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
        return escapes[char] || `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
      });
  }

  function unquoteTagValue(value) {
    const text = String(value || '').trim();
    const quote = text[0];
    if (quote !== '"' && quote !== "'") return text;

    let escaped = false;
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        // Первая неэкранированная закрывающая кавычка должна завершать всё значение.
        return index === text.length - 1
          ? text.slice(1, index).replace(/\\(.)/g, '$1')
          : null;
      }
    }
    return null;
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

  // Разбираем только ограниченный, явно поддержанный PromQL. Метаданные меток описывают
  // возможные метки результата: null означает неизвестную схему метрики с известными исключениями.
  const MAX_PROM_TOKENS = 4096;
  const MAX_PROM_DEPTH = 96;
  const analysisCache = new Map();
  const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const BINARY_PRECEDENCE = {
    or: 1, and: 2, unless: 2, '==': 3, '!=': 3, '>': 3, '<': 3, '>=': 3, '<=': 3,
    '+': 4, '-': 4, '*': 5, '/': 5, '%': 5, atan2: 5, '^': 6
  };
  const COMPARISONS = new Set(['==', '!=', '>', '<', '>=', '<=']);
  const SET_OPERATORS = new Set(['and', 'or', 'unless']);
  const PROM_KEYWORDS = new Set([
    ...AGGREGATION_OPERATORS, ...Object.keys(BINARY_PRECEDENCE),
    'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'bool', 'offset'
  ]);
  const UNARY_VECTOR_FUNCTIONS = new Set([
    'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'ceil', 'cos', 'cosh',
    'deg', 'exp', 'floor', 'ln', 'log2', 'log10', 'rad', 'sgn', 'sin', 'sinh',
    'sqrt', 'tan', 'tanh', 'timestamp', 'histogram_avg', 'histogram_count',
    'histogram_sum', 'histogram_stddev', 'histogram_stdvar', 'sort', 'sort_desc'
  ]);
  const RANGE_FUNCTIONS = new Set([
    'avg_over_time', 'count_over_time', 'last_over_time', 'min_over_time',
    'max_over_time', 'sum_over_time', 'stddev_over_time', 'stdvar_over_time',
    'present_over_time', 'changes', 'resets', 'rate', 'irate', 'increase',
    'delta', 'idelta', 'deriv', 'mad_over_time', 'ts_of_last_over_time',
    'ts_of_min_over_time', 'ts_of_max_over_time'
  ]);
  const DATE_FUNCTIONS = new Set([
    'day_of_month', 'day_of_week', 'day_of_year', 'days_in_month', 'hour',
    'minute', 'month', 'year'
  ]);

  function promError(reason) { throw new Error(reason); }

  function tokenizePromQuery(source) {
    const tokens = [];
    let index = 0;
    function add(kind, value) {
      if (tokens.length >= MAX_PROM_TOKENS) promError('query_budget_exceeded');
      tokens.push({ kind, value });
    }
    while (index < source.length) {
      const char = source[index];
      if (/\s/.test(char)) { index += 1; continue; }
      if (char === '#') {
        while (index < source.length && source[index] !== '\n') index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        const quote = char;
        const stringStart = index;
        let value = '';
        let closed = false;
        index += 1;
        while (index < source.length) {
          const next = source[index++];
          if (next === quote) { closed = true; break; }
          if ((next === '\n' || next === '\r') && quote !== '`') promError('invalid_syntax');
          if (next !== '\\' || quote === '`') { value += next; continue; }
          const escaped = source[index++];
          const escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\x0b', '\\': '\\', '"': '"', "'": "'" };
          if (Object.prototype.hasOwnProperty.call(escapes, escaped)) {
            value += escapes[escaped];
            continue;
          }
          let digits;
          let radix = 16;
          if (escaped === 'x' || escaped === 'u' || escaped === 'U') {
            const length = escaped === 'x' ? 2 : escaped === 'u' ? 4 : 8;
            digits = source.slice(index, index + length);
            if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) promError('invalid_syntax');
            index += length;
          } else if (/[0-7]/.test(escaped || '')) {
            digits = escaped + source.slice(index, index + 2);
            if (!/^[0-7]{3}$/.test(digits)) promError('invalid_syntax');
            index += 2;
            radix = 8;
          } else promError('invalid_syntax');
          const codepoint = parseInt(digits, radix);
          if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff) ||
              (radix === 8 && codepoint > 255)) promError('invalid_syntax');
          value += String.fromCodePoint(codepoint);
        }
        if (!closed) promError('invalid_syntax');
        add('string', value);
        Object.assign(tokens[tokens.length - 1], { start: stringStart, end: index, quote });
        continue;
      }
      const rest = source.slice(index);
      const duration = rest.match(/^(?:[0-9]+(?:ms|[smhdwy]))+/);
      if (duration) {
        const units = { y: 31536000000, w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
        let previous = Infinity;
        let total = 0;
        for (const part of duration[0].matchAll(/([0-9]+)(ms|[smhdwy])/g)) {
          const unit = units[part[2]];
          total += Number(part[1]) * unit;
          if (unit >= previous || !Number.isFinite(total) || total > 9223372036854) promError('invalid_syntax');
          previous = unit;
        }
        add('duration', duration[0]); index += duration[0].length; continue;
      }
      const number = rest.match(/^(?:0[xX][0-9a-fA-F]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/);
      if (number) {
        if (!Number.isFinite(Number(number[0]))) promError('invalid_syntax');
        add('number', number[0]); index += number[0].length; continue;
      }
      // Отдельное двоеточие относится к подзапросу. Имена метрик также могут его содержать.
      const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_:]*|^:[A-Za-z_][A-Za-z0-9_:]*/);
      if (identifier) {
        const lower = identifier[0].toLowerCase();
        add('identifier', PROM_KEYWORDS.has(lower) ? lower : identifier[0]);
        tokens[tokens.length - 1].raw = identifier[0];
        index += identifier[0].length;
        continue;
      }
      const pair = source.slice(index, index + 2);
      if (['==', '!=', '>=', '<=', '=~', '!~'].includes(pair)) {
        add('symbol', pair); index += 2; continue;
      }
      if ('(){}[],:@+-*/%^=<>'.includes(char)) {
        add('symbol', char); index += 1; continue;
      }
      promError('invalid_syntax');
    }
    add('eof', '');
    return tokens;
  }

  function promValue(type, labels = null, excluded = []) {
    return { type, labels: labels === null ? null : new Set(labels), excluded: new Set(excluded) };
  }

  function copyPromValue(value, type = value.type) {
    return promValue(type, value.labels, value.excluded);
  }

  function dropPromLabels(value, labels) {
    const result = copyPromValue(value);
    for (const name of labels) {
      if (result.labels) result.labels.delete(name);
      result.excluded.add(name);
    }
    return result;
  }

  function addPromLabels(value, labels) {
    const result = copyPromValue(value);
    for (const name of labels) {
      if (result.labels) result.labels.add(name);
      result.excluded.delete(name);
    }
    return result;
  }

  function unionPromLabels(left, right) {
    if (left.labels && right.labels) return promValue('vector', [...left.labels, ...right.labels]);
    const excluded = [...left.excluded].filter((name) =>
      right.excluded.has(name) || (right.labels && !right.labels.has(name)));
    if (left.labels) {
      return promValue('vector', null, [...right.excluded].filter((name) => !left.labels.has(name)));
    }
    return promValue('vector', null, excluded);
  }

  function parsePromQuery(source) {
    const tokens = tokenizePromQuery(source);
    let cursor = 0;
    let depth = 0;
    const peek = () => tokens[cursor];
    function take(value) {
      if (peek().kind === 'string' || peek().value !== value) return false;
      cursor += 1;
      return true;
    }
    function expect(value) { if (!take(value)) promError('invalid_syntax'); }
    function requireType(value, type) { if (value.type !== type) promError('invalid_type'); }
    function labelList() {
      expect('(');
      const labels = [];
      if (take(')')) return labels;
      do {
        const label = peek();
        const name = label.raw || label.value;
        if (label.kind !== 'identifier' || !LABEL_NAME.test(name) || labels.includes(name)) {
          promError('invalid_syntax');
        }
        cursor += 1;
        labels.push(name);
        if (take(')')) return labels;
        expect(',');
      } while (!take(')'));
      return labels;
    }
    function grouping() {
      if (peek().value !== 'by' && peek().value !== 'without') return null;
      const mode = peek().value;
      cursor += 1;
      return { mode, labels: labelList() };
    }
    function argumentsList() {
      expect('(');
      const args = [];
      if (take(')')) return args;
      do {
        args.push(expression(0));
        if (take(')')) return args;
        expect(',');
      } while (true);
    }
    function stringLabel(value, allowEmpty = false) {
      requireType(value, 'string');
      if (!(allowEmpty && value.literal === '') && !LABEL_NAME.test(value.literal)) {
        promError('invalid_label');
      }
      return value.literal;
    }
    function aggregate(name) {
      let group = grouping();
      const args = argumentsList();
      const tail = grouping();
      if (group && tail) promError('invalid_syntax');
      group = group || tail;
      const parameterized = ['topk', 'bottomk', 'quantile', 'count_values', 'limitk', 'limit_ratio'].includes(name);
      if (args.length !== (parameterized ? 2 : 1)) promError('invalid_arity');
      const vector = args[args.length - 1];
      requireType(vector, 'vector');
      let addedLabel = '';
      if (parameterized) {
        if (name === 'count_values') addedLabel = stringLabel(args[0]);
        else requireType(args[0], 'scalar');
      }
      if (['topk', 'bottomk', 'limitk', 'limit_ratio'].includes(name)) return copyPromValue(vector);
      let result;
      if (!group || group.mode === 'by') {
        result = promValue('vector', group ? group.labels.filter((label) =>
          !vector.excluded.has(label) && (!vector.labels || vector.labels.has(label))) : []);
      }
      else result = dropPromLabels(vector, [...group.labels, '__name__']);
      if (addedLabel && !(group?.mode === 'without' &&
          (group.labels.includes(addedLabel) || addedLabel === '__name__'))) {
        result = addPromLabels(result, [addedLabel]);
      }
      return result;
    }
    function callFunction(name) {
      const args = argumentsList();
      function signature(types, optional = 0, variadic = false) {
        if (args.length < types.length - optional || (!variadic && args.length > types.length)) {
          promError('invalid_arity');
        }
        args.forEach((arg, index) => requireType(arg, types[Math.min(index, types.length - 1)]));
      }
      if (UNARY_VECTOR_FUNCTIONS.has(name)) {
        signature(['vector']);
        return dropPromLabels(args[0], name === 'sort' || name === 'sort_desc' ? [] : ['__name__']);
      }
      if (RANGE_FUNCTIONS.has(name)) {
        signature(['matrix']);
        return dropPromLabels(copyPromValue(args[0], 'vector'), name === 'last_over_time' ? [] : ['__name__']);
      }
      if (DATE_FUNCTIONS.has(name)) {
        signature(['vector'], 1);
        return args.length ? dropPromLabels(args[0], ['__name__']) : promValue('vector', []);
      }
      if (name === 'time' || name === 'pi') { signature([]); return promValue('scalar', []); }
      if (name === 'vector') { signature(['scalar']); return promValue('vector', []); }
      if (name === 'scalar') { signature(['vector']); return promValue('scalar', []); }
      if (name === 'label_replace' || name === 'label_join') {
        signature(name === 'label_replace'
          ? ['vector', 'string', 'string', 'string', 'string']
          : ['vector', 'string', 'string', 'string'], name === 'label_join' ? 1 : 0, name === 'label_join');
        const destination = stringLabel(args[1]);
        for (let i = 3; i < args.length - (name === 'label_replace' ? 1 : 0); i += 1) stringLabel(args[i], true);
        if (name === 'label_replace' && args[2].literal === '' && args[4].literal === '.*') {
          return dropPromLabels(args[0], [destination]);
        }
        if (name === 'label_join' && (args.length === 3 ||
            ((args.length === 4 || args[2].literal === '') && args.slice(3).every((arg) =>
              args[0].excluded.has(arg.literal) || (args[0].labels && !args[0].labels.has(arg.literal)))))) {
          return dropPromLabels(args[0], [destination]);
        }
        return addPromLabels(args[0], [destination]);
      }
      if (name === 'clamp') signature(['vector', 'scalar', 'scalar']);
      else if (name === 'clamp_min' || name === 'clamp_max' || name === 'round') {
        signature(['vector', 'scalar'], name === 'round' ? 1 : 0);
      } else if (name === 'predict_linear') signature(['matrix', 'scalar']);
      else if (name === 'holt_winters' || name === 'double_exponential_smoothing') signature(['matrix', 'scalar', 'scalar']);
      else if (name === 'quantile_over_time') signature(['scalar', 'matrix']);
      else if (name === 'histogram_quantile') signature(['scalar', 'vector']);
      else if (name === 'histogram_fraction') signature(['scalar', 'scalar', 'vector']);
      else if (name === 'sort_by_label' || name === 'sort_by_label_desc') {
        signature(['vector', 'string'], 1, true);
        args.slice(1).forEach((arg) => stringLabel(arg));
        return copyPromValue(args[0]);
      } else if (name === 'absent' || name === 'absent_over_time') {
        signature([name === 'absent' ? 'vector' : 'matrix']);
        // absent выводит метки только из условий равенства непосредственного селектора.
        return promValue('vector', args[0].selector ? args[0].equalLabels : []);
      } else promError('unsupported_function');
      const input = args.find((arg) => arg.type === 'vector' || arg.type === 'matrix');
      let result = dropPromLabels(copyPromValue(input, 'vector'), ['__name__']);
      if (name === 'histogram_quantile' || name === 'histogram_fraction') result = dropPromLabels(result, ['le']);
      return result;
    }
    function selector(named) {
      const value = promValue('vector');
      value.selector = true;
      value.equalLabels = [];
      const matchedLabels = new Set();
      let exactName = false;
      if (!take('{')) return value;
      if (!take('}')) {
        do {
          const label = peek();
          const name = label.raw || label.value;
          if (label.kind !== 'identifier' || !LABEL_NAME.test(name)) promError('invalid_syntax');
          cursor += 1;
          const operator = peek().value;
          if (!['=', '!=', '=~', '!~'].includes(operator)) promError('invalid_syntax');
          cursor += 1;
          if (peek().kind !== 'string') promError('invalid_syntax');
          // Селекторы без имени метрики допустимы только с одним точным непустым именем.
          // Именованные селекторы уже задают __name__, поэтому любое дополнительное условие отклоняется.
          if (name === '__name__') {
            if (named || matchedLabels.has(name) || operator !== '=' || !peek().value) {
              promError('invalid_syntax');
            }
            exactName = true;
          }
          cursor += 1;
          if (matchedLabels.has(name)) value.equalLabels = value.equalLabels.filter((labelName) => labelName !== name);
          else if (operator === '=' && name !== '__name__') value.equalLabels.push(name);
          matchedLabels.add(name);
          if (take('}')) break;
          expect(',');
        } while (!take('}'));
      }
      if (!named && !exactName) promError('unsupported_metricless_selector');
      return value;
    }
    function primary() {
      let value;
      const token = peek();
      if (take('+') || take('-')) {
        value = expression(6);
        if (value.type !== 'scalar' && value.type !== 'vector') promError('invalid_type');
        value = copyPromValue(value);
      } else if (take('(')) {
        value = copyPromValue(expression(0));
        expect(')');
      } else if (token.kind === 'number' || (token.kind === 'identifier' && /^(?:inf|nan)$/i.test(token.value))) {
        cursor += 1;
        value = promValue('scalar', []);
      } else if (token.kind === 'string') {
        cursor += 1;
        value = promValue('string', []);
        value.literal = token.value;
      } else if (token.kind === 'identifier') {
        cursor += 1;
        if (AGGREGATION_OPERATORS.has(token.value) && ['(', 'by', 'without'].includes(peek().value)) {
          value = aggregate(token.value);
        } else if (peek().value === '(') value = callFunction(token.value);
        else {
          if (['on', 'ignoring', 'by', 'without', 'offset', 'bool', 'group_left', 'group_right', 'and', 'or', 'unless', 'atan2'].includes(token.value)) {
            promError('invalid_syntax');
          }
          value = selector(true);
        }
      } else if (token.value === '{') value = selector(false);
      else promError('invalid_syntax');
      let ranged = false;
      let hasOffset = false;
      let hasAt = false;
      while (true) {
        if (take('[')) {
          if (ranged || hasOffset || hasAt || value.type !== 'vector') promError('invalid_type');
          const duration = peek();
          if (duration.kind !== 'duration' || !/[1-9]/.test(duration.value)) promError('invalid_syntax');
          cursor += 1;
          const subquery = take(':');
          if (subquery && peek().kind === 'duration') {
            if (!/[1-9]/.test(peek().value)) promError('invalid_syntax');
            cursor += 1;
          }
          if (!subquery && !value.selector) promError('invalid_type');
          expect(']');
          const selector = value.selector;
          const equalLabels = value.equalLabels;
          value = copyPromValue(value, 'matrix');
          value.modifiable = true;
          value.selector = !subquery && selector;
          value.equalLabels = equalLabels;
          ranged = true;
        } else if (take('offset')) {
          if (hasOffset || !(value.selector || value.modifiable)) promError('invalid_syntax');
          take('-') || take('+');
          if (peek().kind !== 'duration') promError('invalid_syntax');
          cursor += 1;
          hasOffset = true;
        } else if (take('@')) {
          if (hasAt || !(value.selector || value.modifiable)) promError('invalid_syntax');
          if (take('start') || take('end')) { expect('('); expect(')'); }
          else {
            take('-') || take('+');
            if (peek().kind !== 'number') promError('invalid_syntax');
            cursor += 1;
          }
          hasAt = true;
        } else break;
      }
      return value;
    }
    function expression(minimum) {
      depth += 1;
      if (depth > MAX_PROM_DEPTH) promError('query_budget_exceeded');
      let left = primary();
      while (Object.prototype.hasOwnProperty.call(BINARY_PRECEDENCE, peek().value) && BINARY_PRECEDENCE[peek().value] >= minimum) {
        const operator = peek().value;
        cursor += 1;
        const comparison = COMPARISONS.has(operator);
        const setOperator = SET_OPERATORS.has(operator);
        const bool = take('bool');
        if (bool && !comparison) promError('invalid_syntax');
        let match = null;
        let group = null;
        if (peek().value === 'on' || peek().value === 'ignoring') {
          const mode = peek().value;
          cursor += 1;
          match = { mode, labels: labelList() };
        }
        if (peek().value === 'group_left' || peek().value === 'group_right') {
          const side = peek().value;
          cursor += 1;
          group = { side, labels: peek().value === '(' ? labelList() : [] };
          if (setOperator || (match?.mode === 'on' && group.labels.some((label) => match.labels.includes(label)))) {
            promError('invalid_syntax');
          }
        }
        const right = expression(BINARY_PRECEDENCE[operator] + (operator === '^' ? 0 : 1));
        if (!['vector', 'scalar'].includes(left.type) || !['vector', 'scalar'].includes(right.type)) promError('invalid_type');
        if (left.type === 'scalar' && right.type === 'scalar') {
          if (setOperator || match || group || (comparison && !bool)) promError('invalid_type');
          left = promValue('scalar', []);
        } else if (left.type === 'scalar' || right.type === 'scalar') {
          if (setOperator || match || group) promError('invalid_type');
          left = copyPromValue(left.type === 'vector' ? left : right);
          if (!comparison || bool) left = dropPromLabels(left, ['__name__']);
        } else if (setOperator) {
          left = operator === 'or' ? unionPromLabels(left, right) : copyPromValue(left);
        } else {
          const originalLeft = left;
          left = copyPromValue(group?.side === 'group_right' ? right : left);
          if (!group && match?.mode === 'on') {
            left = promValue('vector', match.labels.filter((label) =>
              !originalLeft.excluded.has(label) &&
              (!originalLeft.labels || originalLeft.labels.has(label))), originalLeft.excluded);
          }
          else if (!group && match?.mode === 'ignoring') left = dropPromLabels(left, match.labels);
          if (group) {
            const other = group.side === 'group_right' ? originalLeft : right;
            for (const label of group.labels) {
              left = other.excluded.has(label) || (other.labels && !other.labels.has(label))
                ? dropPromLabels(left, [label]) : addPromLabels(left, [label]);
            }
          }
          if (!comparison || bool) left = dropPromLabels(left, ['__name__']);
        }
      }
      depth -= 1;
      return left;
    }
    const result = expression(0);
    if (peek().kind !== 'eof' || result.type === 'string') promError('invalid_syntax');
    return result;
  }

  function substituteMatcherVariables(query, resolveVariable) {
    if (typeof query !== 'string' || query.length > MAX_PROM_QUERY_LENGTH ||
        typeof resolveVariable !== 'function') return '';
    try {
      const tokens = tokenizePromQuery(query);
      let result = '';
      let copiedThrough = 0;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.kind !== 'string') continue;
        const body = query.slice(token.start + 1, token.end - 1);
        if (!/\$[A-Za-z_]/.test(body)) continue;
        // Значение условия отбора — единственная разрешённая позиция подстановки. Полностью
        // развёрнутый запрос по-прежнему проходит структурную проверку.
        if (token.quote === '`' || tokens[index - 2]?.kind !== 'identifier' ||
            (tokens[index - 2]?.raw || tokens[index - 2]?.value) === '__name__' ||
            !['=', '!=', '=~', '!~'].includes(tokens[index - 1]?.value) || body.includes('\\')) return '';
        const expanded = body.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => {
          const value = resolveVariable(name);
          // Исходные значения пар Bosun: без кавычек, экранирования, кода и рекурсивной текстовой
          // подстановки. Точки и вертикальные черты сохраняют существующую семантику регулярных выражений.
          if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9_.|:-]+$/.test(value)) {
            throw new Error('unresolved_variable');
          }
          return escapePromLabelValue(value);
        });
        result += query.slice(copiedThrough, token.start + 1) + expanded + token.quote;
        copiedThrough = token.end;
        if (result.length > MAX_PROM_QUERY_LENGTH) return '';
      }
      result += query.slice(copiedThrough);
      return result.length <= MAX_PROM_QUERY_LENGTH && !/\$[A-Za-z_]/.test(result) ? result : '';
    } catch (_) {
      return '';
    }
  }

  function analyzePromQuery(query) {
    if (typeof query !== 'string' || !query.trim()) return { ok: false, reason: 'empty_query' };
    if (query.length > MAX_PROM_QUERY_LENGTH) return { ok: false, reason: 'query_budget_exceeded' };
    if (analysisCache.has(query)) return { ...analysisCache.get(query),
      labels: analysisCache.get(query).labels?.slice() ?? null,
      excludedLabels: analysisCache.get(query).excludedLabels?.slice() || [] };
    let result;
    try {
      const value = parsePromQuery(query);
      result = { ok: true, reason: '', type: value.type,
        labels: value.labels === null ? null : [...value.labels], excludedLabels: [...value.excluded] };
    } catch (error) {
      result = { ok: false, reason: error.message || 'invalid_syntax' };
    }
    if (analysisCache.size >= 128) analysisCache.delete(analysisCache.keys().next().value);
    analysisCache.set(query, result);
    return { ...result, labels: result.labels?.slice() ?? null, excludedLabels: result.excludedLabels?.slice() || [] };
  }

  function transformAlertQuery(query, rawTags, alertKey = '') {
    const analysis = analyzePromQuery(query);
    const rejected = (reason) => ({ ok: false, query: '', reason, strategy: '' });
    if (!analysis.ok) return rejected(analysis.reason);
    const parsed = parseAlertTagsStrict(rawTags, alertKey);
    if (!parsed.valid) return rejected('invalid_alert_tags');
    if (!parsed.tags.length) return { ok: true, query, reason: '', strategy: 'unchanged' };
    if (analysis.type !== 'vector') return rejected('non_vector_output');
    if (parsed.tags.some(({ name }) => analysis.excludedLabels.includes(name) ||
        (analysis.labels !== null && !analysis.labels.includes(name)))) return rejected('output_label_unavailable');
    let constant = 'vector(1)';
    for (const tag of parsed.tags) {
      // Prometheus использует раскрытие подстановок Go: $$ обозначает буквальный знак доллара.
      const replacement = escapePromLabelValue(tag.value.replace(/\$/g, '$$$$'));
      constant = `label_replace(${constant}, "${tag.name}", "${replacement}", "", ".*")`;
    }
    const transformed = `(\n${query}\n) and on (${parsed.tags.map((tag) => tag.name).join(', ')}) (${constant})`;
    if (transformed.length > MAX_PROM_QUERY_LENGTH) return rejected('query_budget_exceeded');
    return { ok: true, query: transformed, reason: '', strategy: 'output-filter' };
  }

  function applyAlertTagsToPromQuery(query, rawTags, alertKey = '') {
    return transformAlertQuery(query, rawTags, alertKey).query;
  }

  globalThis.BosunHelperPromQL = {
    escapePromLabelValue,
    parseAlertTags,
    extractPromrasQuery,
    substituteMatcherVariables,
    analyzePromQuery,
    transformAlertQuery,
    applyAlertTagsToPromQuery
  };
})();
