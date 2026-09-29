(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MathAutocompleteEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    expressions: true,
    sequences: true,
    minPrefix: 3,
    maxSuggestionLength: 400,
    sequenceEnd: 'n',
    debounceMs: 160
  });
  const MATH_ENVIRONMENTS = /^(?:equation|align|alignat|gather|multline|eqnarray|flalign|math|displaymath)\*?$/;
  const BASE_SOURCE = String.raw`(?:\\(?:mathrm|mathbf|mathit|mathsf|mathtt|boldsymbol|bm)\s*\{(?:\\[A-Za-z]+|[A-Za-z])\}|\\[A-Za-z]+|\{(?:\\[A-Za-z]+|[A-Za-z])\}|[A-Za-z])`;
  const TERM_SOURCE = '(' + BASE_SOURCE + ')' + String.raw`\s*_\s*(?:\{(\d+)\}|(\d+))`;
  const compact = (value) => value.replace(/\s+/g, '');
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function escaped(text, position) {
    let count = 0;
    while (position > 0 && text[--position] === '\\') count++;
    return count % 2 === 1;
  }

  // Preserve positions while masking comments. No document content leaves this engine.
  function maskComments(text) {
    const pieces = [];
    let start = 0;
    for (let position = 0; position < text.length; position++) {
      if (text[position] !== '%' || escaped(text, position)) continue;
      let end = position;
      while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
      pieces.push(text.slice(start, position), ' '.repeat(end - position));
      start = end;
      position = end - 1;
    }
    pieces.push(text.slice(start));
    return pieces.join('');
  }

  function inComment(text, cursor) {
    const line = text.lastIndexOf('\n', cursor - 1) + 1;
    for (let i = line; i < cursor; i++) {
      if (text[i] === '%' && !escaped(text, i)) return true;
    }
    return false;
  }

  function maskLiteralRegions(text) {
    const commands = /\\begin\{(verbatim\*?|Verbatim|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|comment)\}|\\(?:verb\*?|lstinline\*?)(?![A-Za-z])/g;
    const pieces = [];
    const excluded = [];
    let start = 0;
    let match;
    while ((match = commands.exec(text))) {
      if (escaped(text, match.index) || inComment(text, match.index)) continue;
      let end;
      let closed;
      if (match[1]) {
        const closing = '\\end{' + match[1] + '}';
        const closingStart = text.indexOf(closing, commands.lastIndex);
        closed = closingStart >= 0;
        end = closed ? closingStart + closing.length : text.length;
      } else {
        let delimiterStart = commands.lastIndex;
        if (match[0].startsWith('\\lstinline') && text[delimiterStart] === '[') {
          const optionEnd = text.indexOf(']', delimiterStart + 1);
          if (optionEnd < 0) continue;
          delimiterStart = optionEnd + 1;
        }
        const delimiter = text[delimiterStart];
        if (!delimiter || /\s/.test(delimiter)) continue;
        const lineEnd = text.indexOf('\n', delimiterStart + 1);
        const boundary = lineEnd < 0 ? text.length : lineEnd;
        const closingStart = text.indexOf(delimiter === '{' ? '}' : delimiter, delimiterStart + 1);
        closed = closingStart >= 0 && closingStart < boundary;
        end = closed ? closingStart + 1 : boundary;
      }
      excluded.push({ start: match.index, end, closed });
      pieces.push(text.slice(start, match.index), text.slice(match.index, end).replace(/[^\r\n]/g, ' '));
      start = end;
      commands.lastIndex = end;
    }
    pieces.push(text.slice(start));
    return { text: pieces.join(''), excluded };
  }

  function parseMath(text) {
    const literals = maskLiteralRegions(text);
    const clean = maskComments(literals.text);
    const regions = [];
    const tokens = /\\(?:begin|end)\{([^}]+)\}|\\[()[\]]|\$\$?/g;
    let active = null;
    let token;
    while ((token = tokens.exec(clean))) {
      if (escaped(clean, token.index)) continue;
      const value = token[0];
      if (!active) {
        let close;
        if (value === '$' || value === '$$') close = value;
        else if (value === '\\(') close = '\\)';
        else if (value === '\\[') close = '\\]';
        else if (value.startsWith('\\begin{') && MATH_ENVIRONMENTS.test(token[1])) {
          close = '\\end{' + token[1] + '}';
        }
        if (close) active = { start: tokens.lastIndex, end: clean.length, close, closed: false };
      } else if (value === active.close) {
        active.end = token.index;
        active.closed = true;
        regions.push(active);
        active = null;
      }
    }
    if (active) regions.push(active);
    return { clean, regions, literalText: literals.text, excluded: literals.excluded };
  }

  function trimOverlap(insertText, right) {
    const limit = Math.min(insertText.length, right.length);
    for (let count = limit; count > 0; count--) {
      if (insertText.endsWith(right.slice(0, count))) return insertText.slice(0, -count);
    }
    return insertText;
  }

  function finish(insertText, kind, label, text, cursor, settings, details) {
    const original = insertText;
    const right = text.slice(cursor, cursor + settings.maxSuggestionLength);
    insertText = trimOverlap(insertText, right);
    // When editing the middle of a token, only insert a known missing portion.
    if (original === insertText && /^[A-Za-z0-9_]/.test(right)) return null;
    if (!insertText.trim() || insertText.length > settings.maxSuggestionLength) return null;
    return Object.assign({ insertText, kind, label }, details);
  }

  function previousTerms(fragment) {
    const expression = new RegExp(TERM_SOURCE, 'g');
    const terms = [];
    let match;
    while ((match = expression.exec(fragment))) {
      const before = fragment[match.index - 1];
      if (before && /[A-Za-z\\]/.test(before)) continue;
      terms.push({
        base: match[1], number: Number(match[2] || match[3]), braced: match[2] !== undefined,
        start: match.index, end: expression.lastIndex
      });
    }
    return terms;
  }

  function indexText(value, braced) {
    return braced || !/^(?:[A-Za-z]|\d)$/.test(value) ? '{' + value + '}' : value;
  }

  function inferEndpoint(parsed, base, firstNumber, cursor, settings) {
    const literal = escapeRegex(base).replace(/\s+/g, '\\s*');
    const index = String.raw`_\s*(?:\{([^{}]+)\}|([A-Za-z]|\d+|\\[A-Za-z]+))`;
    const prior = new RegExp(literal + index + String.raw`\s*,\s*` + literal + index +
      String.raw`\s*,\s*(\\(?:l|c)?dots|\.\.\.)\s*,\s*` + literal + index, 'g');
    let best = null;
    for (const region of parsed.regions) {
      const body = parsed.clean.slice(region.start, region.end);
      let match;
      while ((match = prior.exec(body))) {
        const position = region.start + match.index;
        if (position <= cursor && position + match[0].length >= cursor) continue;
        const first = Number(match[1] || match[2]);
        const second = Number(match[3] || match[4]);
        const endpoint = (match[6] || match[7]).trim();
        if (!Number.isInteger(first) || second !== first + 1 || !/^(?:[A-Za-z]|\d+|\\[A-Za-z]+|[A-Za-z]\s*[-+]\s*\d+)$/.test(endpoint)) continue;
        const score = Math.abs(cursor - position) + (first === firstNumber ? 0 : 10000);
        if (!best || score < best.score) best = { value: endpoint, dots: match[5], score, source: 'previous-list' };
      }
    }
    if (best) return best;

    // A bound is evidence only if the same indexed variable appears in that math region.
    const variable = new RegExp(literal + String.raw`_\s*(?:\{([ijk])\}|([ijk]))`);
    for (const region of parsed.regions.slice().sort((a, b) => Math.abs(a.start - cursor) - Math.abs(b.start - cursor))) {
      if (Math.abs(region.start - cursor) > 1500) continue;
      const body = parsed.clean.slice(region.start, region.end);
      const indexed = variable.exec(body);
      if (!indexed) continue;
      const symbol = indexed[1] || indexed[2];
      const endpointPattern = String.raw`([A-Za-z](?:\s*[-+]\s*\d+)?|\d+|\\[A-Za-z]+)(?![A-Za-z0-9])`;
      const boundPatterns = [
        String.raw`(?:0|1)\s*\\le(?:q)?\s*` + symbol + String.raw`\s*\\le(?:q)?\s*`,
        symbol + String.raw`\s*=\s*(?:0|1)\s*,\s*(?:\\(?:l|c)?dots|\.\.\.)\s*,\s*`,
      ];
      for (const pattern of boundPatterns) {
        const bound = new RegExp(pattern + endpointPattern).exec(body);
        if (!bound) continue;
        const remainder = body.slice(bound.index + bound[0].length).trimStart();
        // Do not treat the first token of an unsupported expression as its endpoint.
        if (/^(?:[-+*\/^_(A-Za-z0-9]|\\(?:cdot|times|frac|over|div|ast)\b)/.test(remainder)) continue;
        return { value: bound[1], dots: '\\ldots', source: 'nearby-bound' };
      }
    }
    const configured = typeof settings.sequenceEnd === 'string' || typeof settings.sequenceEnd === 'number'
      ? String(settings.sequenceEnd).trim() : '';
    const explicitInteger = /^\d{1,3}$/.test(configured) && Number(configured) >= 3 && Number(configured) <= 999;
    const explicitSymbol = /^(?:[A-Za-z]|\\[A-Za-z]+|[A-Za-z]\s*[-+]\s*\d+)$/.test(configured);
    const value = explicitInteger ? String(Number(configured)) : explicitSymbol ? configured : 'n';
    return { value, dots: '\\ldots', source: value === 'n' ? 'default' : 'configured' };
  }

  function sequenceSuggestion(parsed, region, text, cursor, settings) {
    const fragmentStart = Math.max(region.start, cursor - 1000);
    const fragment = parsed.clean.slice(fragmentStart, cursor);
    const terms = previousTerms(fragment);
    if (!terms.length) return null;
    let last = terms[terms.length - 1];
    let tail = fragment.slice(last.end);
    let partial = '';
    let separator;
    let trailingComma = false;
    let runEnd = terms.length - 1;
    let second = last;
    const partialMatch = new RegExp(String.raw`^(,\s*)` + escapeRegex(last.base) + String.raw`\s*_\s*(\{?)(\d*)$`).exec(tail);
    if (partialMatch) {
      const nextNumber = String(last.number + 1);
      if (!nextNumber.startsWith(partialMatch[3])) return null;
      const usesBrace = partialMatch[2] === '{';
      partial = nextNumber.slice(partialMatch[3].length) + (usesBrace ? '}' : '');
      separator = partialMatch[1];
      second = { ...last, number: last.number + 1, braced: usesBrace, end: fragment.length };
    } else {
      if (!/^\s*,?\s*$/.test(tail)) return null;
      trailingComma = tail.includes(',');
      const previous = terms[terms.length - 2];
      if (!previous || compact(previous.base) !== compact(last.base) || last.number !== previous.number + 1) return null;
      separator = fragment.slice(previous.end, last.start);
      if (!/^,\s*$/.test(separator)) return null;
      runEnd--;
    }
    let first = terms[runEnd];
    while (runEnd > 0) {
      const candidate = terms[runEnd - 1];
      if (compact(candidate.base) !== compact(first.base) || candidate.number + 1 !== first.number ||
          !/^,\s*$/.test(fragment.slice(candidate.end, first.start))) break;
      first = candidate;
      runEnd--;
    }
    // A malformed earlier list must not be silently turned into a new consecutive run.
    if (runEnd > 0 && /^,\s*$/.test(fragment.slice(terms[runEnd - 1].end, first.start))) return null;
    const endpoint = inferEndpoint(parsed, second.base, first.number, cursor, settings);
    if (/^\d+$/.test(endpoint.value) && Number(endpoint.value) <= second.number) return null;
    const endingTerm = second.base + '_' + indexText(endpoint.value, second.braced);
    let suffix;
    if (/^\d+$/.test(endpoint.value) && Number(endpoint.value) === second.number + 1) {
      suffix = partial + (trailingComma ? separator.slice(tail.length) : separator) + endingTerm;
    } else {
      suffix = partial + (trailingComma ? separator.slice(Math.min(tail.length, separator.length)) : separator) + endpoint.dots + separator + endingTerm;
    }
    const beforeRun = fragment.slice(0, first.start).trimEnd();
    if (beforeRun.endsWith('\\left\\{')) suffix += '\\right\\}';
    else if (beforeRun.endsWith('\\{')) suffix += '\\}';
    else if (beforeRun.endsWith('\\left(')) suffix += '\\right)';
    else if (beforeRun.endsWith('\\left[')) suffix += '\\right]';
    else if (beforeRun.endsWith('{')) suffix += '}';
    else if (beforeRun.endsWith('(')) suffix += ')';
    else if (beforeRun.endsWith('[')) suffix += ']';
    return finish(suffix, 'sequence', 'Complete indexed sequence', text, cursor, settings, { endpointSource: endpoint.source });
  }

  function compactWithPositions(value) {
    let result = '';
    const positions = [];
    for (let i = 0; i < value.length; i++) {
      if (!/\s/.test(value[i])) { result += value[i]; positions.push(i); }
    }
    return { value: result, positions };
  }

  function expressionCandidates(parsed, cursor, maxLength) {
    const candidates = [];
    for (const region of parsed.regions) {
      const content = parsed.clean.slice(region.start, region.end);
      const rows = /\\\\(?:\[[^\]]*\])?|\r?\n/g;
      let rowStart = 0;
      let match;
      do {
        match = rows.exec(content);
        const raw = content.slice(rowStart, match ? match.index : content.length);
        const start = region.start + rowStart;
        const end = start + raw.length;
        if (!(start <= cursor && cursor <= end)) {
          const value = raw.replace(/\\(?:label|tag)\{[^}]*\}/g, '').replace(/\\(?:nonumber|notag)\b/g, '').replace(/&/g, '').trim();
          if (value.length >= 3 && value.length <= maxLength && !/\\(?:begin|end)\{/.test(value)) {
            candidates.push({ value, position: start, normalized: compactWithPositions(value) });
          }
        }
        rowStart = match ? rows.lastIndex : content.length;
      } while (match);
    }
    return candidates;
  }

  function expressionSuggestion(parsed, region, text, cursor, settings) {
    const fragment = parsed.clean.slice(Math.max(region.start, cursor - settings.maxSuggestionLength), cursor);
    const row = fragment.split(/\\\\|\r?\n/).pop();
    if (!row.trim() || /\\(?:text|textrm|textit|textbf|mbox)\{[^}]*$/.test(row)) return null;
    const prefixes = [row.trimStart()];
    const boundaries = /[=+,;&]|\\(?:approx|equiv|leq?|geq?)\b/g;
    let boundary;
    while ((boundary = boundaries.exec(row))) prefixes.push(row.slice(boundaries.lastIndex).trimStart());
    const sources = expressionCandidates(parsed, cursor, settings.maxSuggestionLength);
    const frequencies = new Map();
    for (const source of sources) frequencies.set(source.normalized.value, (frequencies.get(source.normalized.value) || 0) + 1);
    let best = null;
    for (const prefix of prefixes) {
      const needle = compact(prefix);
      if (needle.length < settings.minPrefix) continue;
      for (const source of sources) {
        let occurrence = source.normalized.value.indexOf(needle);
        while (occurrence >= 0) {
          const originalStart = source.normalized.positions[occurrence];
          const preceding = source.value[originalStart - 1];
          const validStart = needle.startsWith('\\') ? !escaped(source.value, originalStart)
            : !preceding || !/[A-Za-z0-9\\]/.test(preceding);
          if (validStart) {
            const originalEnd = source.normalized.positions[occurrence + needle.length - 1] + 1;
            let suffix = source.value.slice(originalEnd);
            if (/\s$/.test(prefix)) suffix = suffix.trimStart();
            // A reused subexpression must not insert the original expression's unmatched closing groups.
            if (occurrence > 0) suffix = balancedTail(prefix, suffix);
            if (suffix.trim()) {
              const distance = Math.abs(cursor - source.position);
              const frequency = frequencies.get(source.normalized.value);
              const score = needle.length * 10000 + frequency * 150 - Math.min(distance, 10000) - occurrence * 2;
              if (!best || score > best.score) best = { suffix, score, source: source.value };
            }
          }
          occurrence = source.normalized.value.indexOf(needle, occurrence + 1);
        }
      }
    }
    return best ? finish(best.suffix, 'expression', 'Reuse expression from this document', text, cursor, settings, { source: best.source }) : null;
  }

  function balancedTail(prefix, suffix) {
    const depth = { '{': 0, '(': 0, '[': 0 };
    const opening = { '}': '{', ')': '(', ']': '[' };
    for (let i = 0; i < prefix.length; i++) {
      if (!escaped(prefix, i)) {
        if (prefix[i] in depth) depth[prefix[i]]++;
        else if (prefix[i] in opening) depth[opening[prefix[i]]]--;
      }
    }
    for (let i = 0; i < suffix.length; i++) {
      if (!escaped(suffix, i)) {
        if (suffix[i] in depth) depth[suffix[i]]++;
        else if (suffix[i] in opening && --depth[opening[suffix[i]]] < 0) {
          const end = suffix.slice(0, i).endsWith('\\right') ? i - 6 : i;
          return suffix.slice(0, end);
        }
      }
    }
    return suffix;
  }

  function inTextCommand(value) {
    const commands = /\\(?:text|textrm|textit|textbf|textnormal|textsf|texttt|mbox|operatorname)\*?\s*\{/g;
    let match;
    while ((match = commands.exec(value))) {
      if (escaped(value, match.index)) continue;
      let depth = 1;
      let position = commands.lastIndex;
      while (position < value.length && depth > 0) {
        if (!escaped(value, position)) {
          if (value[position] === '{') depth++;
          else if (value[position] === '}') depth--;
        }
        position++;
      }
      if (depth > 0) return true;
      commands.lastIndex = position;
    }
    return false;
  }

  function createEngine(initialSettings) {
    let cachedText;
    let cachedParse;
    return {
      suggest(documentText, cursor, overrides) {
        if (typeof documentText !== 'string' || !Number.isInteger(cursor) || cursor < 0 || cursor > documentText.length) return null;
        const settings = Object.assign({}, DEFAULT_SETTINGS, initialSettings, overrides);
        if (!settings.enabled) return null;
        settings.minPrefix = Math.max(1, Math.min(30, Number(settings.minPrefix) || DEFAULT_SETTINGS.minPrefix));
        settings.maxSuggestionLength = Math.max(1, Math.min(2000, Number(settings.maxSuggestionLength) || DEFAULT_SETTINGS.maxSuggestionLength));
        if (cachedText !== documentText) {
          cachedText = documentText;
          cachedParse = parseMath(documentText);
        }
        if (inComment(cachedParse.literalText, cursor) || cachedParse.excluded.some((item) =>
          cursor > item.start && (cursor < item.end || (!item.closed && cursor === item.end)))) return null;
        const region = cachedParse.regions.find((item) => cursor >= item.start && cursor <= item.end);
        if (!region) return null;
        const before = cachedParse.clean.slice(region.start, cursor);
        if (inTextCommand(before)) return null;
        if (settings.sequences) {
          const sequence = sequenceSuggestion(cachedParse, region, documentText, cursor, settings);
          if (sequence) return sequence;
        }
        return settings.expressions ? expressionSuggestion(cachedParse, region, documentText, cursor, settings) : null;
      },
      reset() { cachedText = undefined; cachedParse = undefined; }
    };
  }

  return { DEFAULT_SETTINGS, createEngine };
});
