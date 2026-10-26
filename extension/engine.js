(function (root, factory) {
  const commonJS = typeof module === 'object' && module.exports;
  const Context = commonJS ? require('./context.js') : root.AutoTexContext;
  const Classifier = commonJS ? require('./classifier.js') : root.AutoTexClassifier;
  const Predictor = commonJS ? require('./predictor.js') : root.AutoTexPredictor;
  const model = commonJS ? require('./model.js') : root.AutoTexModel;
  const api = factory(Context, Predictor, model, Classifier);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MathAutocompleteEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Context, Predictor, bundledModel, Classifier) {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    expressions: true,
    sequences: true,
    autoFractions: true,
    minPrefix: 3,
    maxSuggestionLength: 400,
    sequenceEnd: 'n',
    debounceMs: 50
  });
  // A list element may contain several adjacent symbols (ba, b\\alpha, etc.).
  // Keep this separate from the classifier's individual mathematical symbols.
  const ELEMENT_SYMBOL = String.raw`(?:\\[A-Za-z]+(?![A-Za-z])|[A-Za-z0-9])`;
  const ELEMENT_GROUP = String.raw`\{\s*(?:` + ELEMENT_SYMBOL + String.raw`\s*)+\}`;
  const STYLE_NAMES = '(?:mathbb|mathcal|mathfrak|mathrm|mathbf|mathit|mathsf|mathtt|boldsymbol|bm)(?![A-Za-z])';
  const ELEMENT_STYLE = String.raw`\\` + STYLE_NAMES + String.raw`\s*(?:` + ELEMENT_GROUP + '|' + ELEMENT_SYMBOL + ')';
  // Style commands must not also match a bare command followed by a group:
  // overlapping alternatives make failed matches exponential on long runs.
  const ELEMENT_PLAIN = String.raw`(?:\\(?!` + STYLE_NAMES + String.raw`)[A-Za-z]+(?![A-Za-z])|[A-Za-z0-9])`;
  const INDEXED_BASE_SOURCE = '(?:' + ELEMENT_STYLE + '|' + ELEMENT_GROUP + '|' + ELEMENT_PLAIN + ')+';
  const TERM_SOURCE = '(' + INDEXED_BASE_SOURCE + ')' + String.raw`\s*_\s*(?:\{([^{}]+)\}|(\d+|[A-Za-z]|\\[A-Za-z]+))`;
  const compact = (value) => value.replace(/\s+/g, '');
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const escaped = Context.escaped;

  function baseStartsAt(text, position) {
    return !escaped(text, position) && !/[A-Za-z0-9\\}]/.test(text[position - 1] || '');
  }

  function termStartsAt(text, position) {
    return baseStartsAt(text, position) &&
      !/_\s*(?:\{[^{}]+\}|\\[A-Za-z]+|[A-Za-z]|\d+)[ \t]+$/.test(text.slice(0, position));
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
    // Keep the untrimmed continuation so typed auto-paired closers can advance
    // through it later without losing a final delimiter borrowed from the file.
    return Object.assign({ insertText, fullText: original, kind, label }, details);
  }

  function previousTerms(fragment) {
    const expression = new RegExp(TERM_SOURCE, 'g');
    const continuation = new RegExp(TERM_SOURCE, 'y');
    const terms = [];
    let match;
    while ((match = expression.exec(fragment))) {
      if (!baseStartsAt(fragment, match.index)) continue;
      const start = match.index, parts = [];
      let end = start;
      do {
        const value = (match[2] || match[3]).trim();
        parts.push({ base: match[1], number: /^\d+$/.test(value) ? Number(value) : null, braced: match[2] !== undefined,
          gap: fragment.slice(end, match.index) });
        end = match.index + match[0].length;
        continuation.lastIndex = end;
        while (/[ \t]/.test(fragment[continuation.lastIndex] || '')) continuation.lastIndex++;
        match = continuation.exec(fragment);
      } while (match);
      expression.lastIndex = end;
      // An endpoint after an ellipsis belongs to the completion tail, including
      // when the user has already typed one or more of its index slots.
      const previous = terms[terms.length - 1];
      if (previous && /^\s*,\s*(?:\\(?:l|c)?dots|\.{3}|…)\s*,\s*$/.test(fragment.slice(previous.end, start))) continue;
      const number = parts[0].number;
      // Keep inconsistent products as a whole invalid term rather than letting
      // their last factor become a different, apparently valid sequence.
      terms.push({ parts, number: Number.isSafeInteger(number) && parts.every((part) => part.number === number) ? number : null,
        start, end });
    }
    return terms;
  }

  function sameParts(left, right) {
    return left.length === right.length && left.every((part, index) => compact(part.base) === compact(right[index].base));
  }

  function completeTerm(parts, value, typed = '') {
    const needle = compact(typed), renderedParts = [];
    let text = '';
    for (const part of parts) {
      const prefix = text + part.gap + part.base + '_';
      const normalized = compact(prefix);
      const braced = needle.startsWith(normalized) ? needle[normalized.length] === '{' : part.braced;
      renderedParts.push({ ...part, braced });
      text = prefix + indexText(value, braced);
    }
    const normalized = compactWithPositions(text);
    if (!normalized.value.startsWith(needle)) return null;
    const offset = needle.length ? normalized.positions[needle.length - 1] + 1 : 0;
    return { text, suffix: text.slice(offset), parts: renderedParts };
  }

  function termPattern(parts, indexPattern) {
    return parts.map((part, index) => (index ? '[ \\t]*' : '') +
      escapeRegex(part.base).replace(/\s+/g, '\\s*') + String.raw`\s*_\s*` + indexPattern).join('');
  }

  function termEndsAt(text, position) {
    if (/[A-Za-z0-9_]/.test(text[position] || '')) return false;
    const continuation = new RegExp('[ \\t]*' + INDEXED_BASE_SOURCE + String.raw`\s*_`, 'y');
    continuation.lastIndex = position;
    return !continuation.test(text);
  }

  function indexText(value, braced) {
    return braced || !/^(?:[A-Za-z]|\d)$/.test(value) ? '{' + value + '}' : value;
  }

  function inferEndpoint(parsed, parts, firstNumber, cursor, settings) {
    // Evidence from this answer takes priority even over a complete list in
    // another answer. A nested subitem can fall back to its parent afterward.
    if (!parsed.scopeFiltered && Context.itemAt(parsed, cursor)) {
      for (const tier of [2, 1, 0]) {
        const scoped = { ...parsed, scopeFiltered: true,
          regions: parsed.regions.filter((region) => Context.scopeTier(parsed, cursor, region.start) === tier) };
        const result = inferEndpoint(scoped, parts, firstNumber, cursor, settings);
        if (result.source === 'previous-list' || result.source === 'nearby-bound') return result;
      }
    }
    const pattern = termPattern(parts, String.raw`(\{[^{}]+\}|[A-Za-z]|\d+|\\[A-Za-z]+)`);
    const prior = new RegExp(pattern + String.raw`\s*,\s*` + pattern +
      String.raw`\s*,\s*(\\(?:l|c)?dots|\.\.\.|…)\s*,\s*` + pattern, 'g');
    const indexValue = (value) => value.replace(/^\{([\s\S]*)\}$/, '$1').trim();
    const sharedValue = (values) => {
      const normalized = values.map(indexValue);
      return normalized.every((value) => compact(value) === compact(normalized[0])) ? normalized[0] : null;
    };
    let best = null;
    for (const region of parsed.regions) {
      const body = parsed.clean.slice(region.start, region.end);
      let match;
      while ((match = prior.exec(body))) {
        if (!termStartsAt(body, match.index) || !termEndsAt(body, prior.lastIndex)) continue;
        const position = region.start + match.index;
        if (position <= cursor && position + match[0].length >= cursor) continue;
        const count = parts.length;
        const firstValue = sharedValue(match.slice(1, count + 1));
        const secondValue = sharedValue(match.slice(count + 1, count * 2 + 1));
        const endpoint = sharedValue(match.slice(count * 2 + 2));
        const first = Number(firstValue), second = Number(secondValue);
        if (firstValue === null || secondValue === null || endpoint === null || !Number.isSafeInteger(first) ||
            second !== first + 1 || !/^(?:[A-Za-z]|\d+|\\[A-Za-z]+|[A-Za-z]\s*[-+]\s*\d+)$/.test(endpoint)) continue;
        const score = Math.abs(cursor - position) + (first === firstNumber ? 0 : 10000);
        if (!best || score < best.score) best = { value: endpoint, dots: match[count * 2 + 1], score, source: 'previous-list', position };
      }
    }
    if (best) return best;

    // A bound is evidence only if the same indexed variable appears in that math region.
    const variable = new RegExp(termPattern(parts, String.raw`(\{[ijk]\}|[ijk])`), 'g');
    for (const region of parsed.regions.slice().sort((a, b) => Math.abs(a.start - cursor) - Math.abs(b.start - cursor))) {
      if (Math.abs(region.start - cursor) > 1500) continue;
      const body = parsed.clean.slice(region.start, region.end);
      variable.lastIndex = 0;
      const indexedVariables = Array.from(body.matchAll(variable)).filter((match) =>
        termStartsAt(body, match.index) && termEndsAt(body, match.index + match[0].length));
      for (const indexed of indexedVariables) {
        const symbol = sharedValue(indexed.slice(1));
        if (!symbol) continue;
        const endpointPattern = String.raw`([A-Za-z](?:\s*[-+]\s*\d+)?|\d+|\\[A-Za-z]+)(?![A-Za-z0-9])`;
        const boundPatterns = [
          String.raw`(?:0|1)\s*\\le(?:q)?\s*` + symbol + String.raw`\s*\\le(?:q)?\s*`,
          symbol + String.raw`\s*=\s*(?:0|1)\s*,\s*(?:\\(?:l|c)?dots|\.\.\.)\s*,\s*`,
        ];
        for (const pattern of boundPatterns) {
          for (const bound of body.matchAll(new RegExp(pattern + endpointPattern, 'g'))) {
            if (!baseStartsAt(body, bound.index)) continue;
            const remainder = body.slice(bound.index + bound[0].length).trimStart();
            // Do not treat the first token of an unsupported expression as its endpoint.
            if (/^(?:[-+*\/^_(A-Za-z0-9]|\\(?:cdot|times|frac|over|div|ast)\b)/.test(remainder)) continue;
            return { value: bound[1], dots: '\\ldots', source: 'nearby-bound', position: region.start };
          }
        }
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
    const previous = terms[terms.length - 2];
    // A partially typed product (a_2b_) initially contains only its first
    // complete factor. Complete it from the preceding whole-product template.
    if (previous && previous.number !== null && last.number === previous.number + 1 &&
        last.parts.length < previous.parts.length && sameParts(last.parts, previous.parts.slice(0, last.parts.length)) &&
        /^,\s*$/.test(fragment.slice(previous.end, last.start))) {
      terms.pop();
      last = previous;
    }
    if (last.number === null) return null;
    let tail = fragment.slice(last.end);
    let partial = '';
    let separator;
    let trailingComma = false;
    let runEnd = terms.length - 1;
    let second = last;
    const ellipsisTail = /^\s*,\s*(\\(?:l|c)?dots(?![A-Za-z])|\.{3}|…)([\s\S]*)$/.exec(tail);
    const partialMatch = !ellipsisTail && /^(,\s*)([\s\S]+)$/.exec(tail);
    const next = partialMatch && partialMatch[2].includes('_') && completeTerm(last.parts, String(last.number + 1), partialMatch[2]);
    if (next) {
      partial = next.suffix;
      separator = partialMatch[1];
      second = { ...last, number: last.number + 1, parts: next.parts, end: fragment.length };
    } else {
      if (!ellipsisTail && !/^\s*,?\s*$/.test(tail)) return null;
      trailingComma = tail.includes(',');
      const previous = terms[terms.length - 2];
      if (!previous || previous.number === null || !sameParts(previous.parts, last.parts) || last.number !== previous.number + 1) return null;
      separator = fragment.slice(previous.end, last.start);
      if (!/^,\s*$/.test(separator)) return null;
      runEnd--;
    }
    let first = terms[runEnd];
    while (runEnd > 0) {
      const candidate = terms[runEnd - 1];
      if (candidate.number === null || !sameParts(candidate.parts, first.parts) || candidate.number + 1 !== first.number ||
          !/^,\s*$/.test(fragment.slice(candidate.end, first.start))) break;
      first = candidate;
      runEnd--;
    }
    // A malformed earlier list must not be silently turned into a new consecutive run.
    if (runEnd > 0 && /^,\s*$/.test(fragment.slice(terms[runEnd - 1].end, first.start))) return null;
    const endpoint = inferEndpoint(parsed, second.parts, first.number, cursor, settings);
    if (/^\d+$/.test(endpoint.value) && Number(endpoint.value) <= second.number) return null;
    const afterDots = ellipsisTail && /^(\s*,\s*)([^\r\n]*)$/.exec(ellipsisTail[2]);
    if (ellipsisTail && !afterDots && ellipsisTail[2].trim()) return null;
    const typedEnd = afterDots?.[2] || '';
    const ending = completeTerm(second.parts, endpoint.value, typedEnd);
    if (!ending) return null;
    let suffix;
    if (ellipsisTail) {
      // Preserve an ellipsis already typed by the user and fill only the missing
      // comma/endpoint, including a partially typed base or subscript.
      suffix = (afterDots ? '' : separator) + ending.suffix;
    } else if (/^\d+$/.test(endpoint.value) && Number(endpoint.value) === second.number + 1) {
      suffix = partial + (trailingComma ? separator.slice(tail.length) : separator) + ending.text;
    } else {
      suffix = partial + (trailingComma ? separator.slice(Math.min(tail.length, separator.length)) : separator) + endpoint.dots + separator + ending.text;
    }
    const beforeRun = fragment.slice(0, first.start).trimEnd();
    if (beforeRun.endsWith('\\left\\{')) suffix += '\\right\\}';
    else if (beforeRun.endsWith('\\{')) suffix += '\\}';
    else if (beforeRun.endsWith('\\left(')) suffix += '\\right)';
    else if (beforeRun.endsWith('\\left[')) suffix += '\\right]';
    else if (beforeRun.endsWith('{')) suffix += '}';
    else if (beforeRun.endsWith('(')) suffix += ')';
    else if (beforeRun.endsWith('[')) suffix += ']';
    return finish(suffix, 'sequence', 'Complete indexed sequence', text, cursor, settings, {
      endpointSource: endpoint.source, position: endpoint.position,
      itemTier: endpoint.position == null ? 0 : Context.scopeTier(parsed, cursor, endpoint.position),
      features: { sourceSequence: 1, prefixLength: fragment.length, length: suffix.length }
    });
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
    for (const segment of parsed.segments || Context.mathSegments(parsed)) {
      const { start, end } = segment;
      if (start <= cursor && cursor <= end) continue;
      const value = parsed.clean.slice(start, end).replace(/\\&|&/g, (match) => match === '&' ? '' : match)
        .replace(/\\(?:nonumber|notag)\b/g, '').trim();
      if (/[=+\-*/^_]$/.test(value) && parsed.textRanges.some((range) => range.commandStart === end)) continue;
      if (value.length >= 3 && value.length <= maxLength && !/\\(?:begin|end)\{/.test(value)) {
        candidates.push({ value, position: start, itemId: segment.itemId, normalized: compactWithPositions(value) });
      }
    }
    return candidates;
  }

  function expressionSuggestions(parsed, region, text, cursor, settings, context) {
    const fragment = parsed.clean.slice(Math.max(region.start, cursor - settings.maxSuggestionLength), cursor);
    const row = fragment.split(/\\\\|\r?\n/).pop();
    if (!row.trim() || /\\(?:text|textrm|textit|textbf|mbox)\{[^}]*$/.test(row)) return [];
    const prefixes = [row.trimStart()];
    const boundaries = /[=+,;&]|\\(?:approx|equiv|leq?|geq?)\b/g;
    let boundary;
    while ((boundary = boundaries.exec(row))) prefixes.push(row.slice(boundaries.lastIndex).trimStart());
    const sources = expressionCandidates(parsed, cursor, settings.maxSuggestionLength);
    const frequencies = new Map();
    for (const source of sources) frequencies.set(source.normalized.value, (frequencies.get(source.normalized.value) || 0) + 1);
    const results = [];
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
              const candidate = finish(suffix, 'expression', 'Reuse expression from this document', text, cursor, settings, {
                source: source.value, position: source.position, itemId: source.itemId,
                itemTier: Context.scopeTier(parsed, cursor, source.position), legacyScore: score,
                features: { sourceExpression: 1, prefixLength: needle.length, localFrequency: frequency,
                  distance, length: suffix.length }
              });
              if (candidate) results.push(candidate);
            }
          }
          occurrence = source.normalized.value.indexOf(needle, occurrence + 1);
        }
      }
    }
    return results.sort((a, b) => b.itemTier - a.itemTier || b.legacyScore - a.legacyScore).slice(0, 64)
      .map((candidate) => semanticFeatures(candidate, context))
      .sort((a, b) => b.itemTier - a.itemTier || b.semanticScore - a.semanticScore || b.legacyScore - a.legacyScore).slice(0, 24);
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


  function semanticFeatures(candidate, context) {
    const features = Classifier.candidateFeatures(candidate, context);
    candidate.features = { ...candidate.features, ...features };
    candidate.semanticScore = (context.classification?.confidence || 0) *
      (2 * features.categoryMatch + 3 * features.indexFit + 2 * features.symbolTypeMatch);
    return candidate;
  }

  // The offline evaluator uses this same selection policy. Low corpus confidence
  // must not disable a concrete completion already supported by the document.
  function selectCandidate(ranked, threshold = 0, useLearnedRanking = false) {
    if (!Array.isArray(ranked) || !ranked.length) return null;
    const tier = (candidate) => candidate.itemTier ?? candidate.scopeTier ?? 0;
    const isReliable = (candidate) => candidate.reliable ||
      candidate.kind === 'expression' || candidate.kind === 'sequence';
    // Rejected predictions are not eligible to block a lower-scope reuse.
    const eligible = ranked.filter((candidate) => isReliable(candidate) ||
      (Number.isFinite(candidate.score) && candidate.score >= threshold));
    if (!eligible.length) return null;
    const bestTier = Math.max(...eligible.map(tier));
    const scoped = eligible.filter((candidate) => tier(candidate) === bestTier);
    if (useLearnedRanking) {
      // All providers participate in learned ranking. Document-supported candidates
      // remain eligible below the generated threshold, preserving a useful fallback.
      scoped.sort((a, b) => (b.score || 0) - (a.score || 0) ||
        (b.semanticScore || 0) - (a.semanticScore || 0) ||
        (b.legacyScore || 0) - (a.legacyScore || 0) ||
        (a.insertText || '').localeCompare(b.insertText || ''));
      return scoped[0];
    }
    const reliable = scoped.filter(isReliable);
    reliable.sort((a, b) => (b.semanticScore || 0) - (a.semanticScore || 0) ||
      Number(b.kind === 'sequence') - Number(a.kind === 'sequence') ||
      (b.legacyScore || 0) - (a.legacyScore || 0) ||
      (a.insertText || '').localeCompare(b.insertText || ''));
    if (reliable.length) return reliable[0];
    scoped.sort((a, b) => (b.score || 0) - (a.score || 0) ||
      (b.insertText || '').length - (a.insertText || '').length ||
      (a.insertText || '').localeCompare(b.insertText || ''));
    return Number.isFinite(scoped[0]?.score) && scoped[0].score >= threshold ? scoped[0] : null;
  }

  function declarationContext(parsed, active, cursor) {
    const declarations = [];
    function add(start, end, tier, budget, ownerId) {
      end = Math.min(end, cursor);
      start = Math.max(start, end - budget);
      if (end <= start) return;
      const excluded = parsed.items.filter((item) => item.id !== ownerId &&
        item.end > start && item.start < end &&
        (ownerId == null || item.start >= parsed.items[ownerId - 1].contentStart)).map((item) => ({start:item.start,end:Math.min(end,item.end)}));
      let position = start, text = '';
      for (const range of excluded) {
        if (range.start >= position) text += parsed.clean.slice(position, range.start);
        position = Math.max(position, range.end);
      }
      text += parsed.clean.slice(position, end);
      if (text.trim()) declarations.push({text, itemTier:tier});
    }
    if (active.item) {
      add(active.item.contentStart, active.item.end, 2, 3500, active.item.id);
      for (const id of active.ancestorIds.slice(0, 2)) {
        const item = parsed.items[id - 1];
        add(item.contentStart, item.end, 1, 1500, item.id);
      }
      add(0, parsed.items[0]?.start ?? cursor, 0, 1500, null);
    } else {
      add(0, cursor, 0, 5000, null);
    }
    return declarations;
  }

  function observedIndices(segment) {
    const found = [];
    const pattern = new RegExp('(' + INDEXED_BASE_SOURCE + ')' + '\\s*_\\s*', 'g');
    let match;
    while ((match = pattern.exec(segment.text))) {
      if (!baseStartsAt(segment.text, match.index)) continue;
      const start = pattern.lastIndex;
      let content, end;
      if (segment.text[start] === '{') {
        let depth = 1;
        end = start + 1;
        for (; end < segment.text.length && end - start < 100; end++) {
          if (escaped(segment.text, end)) continue;
          if (segment.text[end] === '{') depth++;
          if (segment.text[end] === '}' && --depth === 0) break;
        }
        if (depth !== 0) continue;
        content = segment.text.slice(start + 1, end);
        end++;
      } else {
        const token = /^(?:\\[A-Za-z]+|\\[^A-Za-z]|[^\s{}_^])/.exec(segment.text.slice(start));
        if (!token) continue;
        content = token[0];
        end = start + content.length;
      }
      if (content.trim() && !/[\r\n$%]/.test(content)) found.push({base:match[1],content,start:segment.start + match.index});
      pattern.lastIndex = end;
    }
    return found;
  }

  function indexSuggestions(context, parsed, text, cursor, settings) {
    const index = context.classification?.index;
    if (context.classification?.kind !== 'index' || !index) return [];
    const typed = index.content || '';
    const beforeIndex = context.prefix.slice(0, context.prefix.length - typed.length - (index.braced ? 1 : 0))
      .replace(/_\s*$/, '').trimEnd();
    const baseMatch = new RegExp('(' + INDEXED_BASE_SOURCE + ')$').exec(beforeIndex);
    if (!baseMatch || !baseStartsAt(beforeIndex, baseMatch.index)) return [];
    const base = Classifier.canonicalSymbol(baseMatch[1]);
    const needle = compact(typed);
    const proposals = [];
    for (const segment of context.segments) {
      for (const source of observedIndices(segment)) {
        if (Classifier.canonicalSymbol(source.base) !== base) continue;
        // A suffix cannot add braces before an already typed unbraced command.
        // Reusing a composite argument here would change the subscript's meaning.
        if (!index.braced && typed && !/^(?:[A-Za-z0-9]|\\[A-Za-z]+)$/.test(source.content.trim())) continue;
        const normalized = compactWithPositions(source.content);
        if (!normalized.value.startsWith(needle)) continue;
        const offset = needle.length ? normalized.positions[needle.length - 1] + 1 : 0;
        let suffix = source.content.slice(offset);
        if (/\s$/.test(typed)) suffix = suffix.trimStart();
        if (index.braced) suffix += '}';
        else if (!typed && !/^(?:[A-Za-z0-9]|\\[A-Za-z]+)$/.test(source.content)) suffix = '{' + source.content + '}';
        if (!suffix.trim()) continue;
        const candidate = finish(suffix, 'index', 'Reuse an index for this symbol', text, cursor, settings, {
          source:source.base + '_{' + source.content + '}', position:source.start, itemId:segment.itemId,
          itemTier:Context.scopeTier(parsed, cursor, segment.start), reliable:true,
          legacyScore:needle.length * 10000 - Math.min(Math.abs(cursor - source.start), 10000),
        });
        if (candidate) proposals.push(semanticFeatures(candidate, context));
      }
    }
    return proposals.sort((a,b)=>b.itemTier-a.itemTier || b.semanticScore-a.semanticScore ||
      b.legacyScore-a.legacyScore).slice(0, 12);
  }

  function fractionEdit(parsed, cursor) {
    const active = Context.contextAt(parsed, cursor);
    if (!active) return null;
    const text = parsed.source;
    // A trailing backslash belongs to TeX's literal \/ command.
    if (Context.escaped(text, cursor)) return null;
    let from = cursor;
    while (from > active.region.start && !/\s/.test(text[from - 1])) from--;

    // Environment arguments configure the surrounding math and must remain
    // outside a new fraction, including when spaces occur inside the header.
    function environmentBody(name, position) {
      let at = position;
      const skipSpace = () => { while (at < cursor && /\s/.test(text[at])) at++; };
      function group(open, close) {
        if (text[at] !== open) return false;
        const stack = [close];
        for (at++; at < cursor; at++) {
          if (Context.escaped(text, at)) continue;
          const value = text[at];
          if (value === '{') stack.push('}');
          else if (open === '[' && value === '[' && stack[stack.length - 1] === ']') stack.push(']');
          else if (value === stack[stack.length - 1]) stack.pop();
          if (!stack.length) { at++; return true; }
        }
        return false;
      }
      const required = /^(?:array|subarray|alignat\*?|alignedat)$/.test(name);
      const optional = /^(?:array|alignedat|aligned|gathered|[pbBvV]?matrix\*)$/.test(name);
      if (!required && !optional) return position;
      skipSpace();
      if (optional && text[at] === '[') {
        if (!group('[', ']')) return null;
        skipSpace();
      }
      if (required && !group('{', '}')) return null;
      return at;
    }
    if (active.region.environment) {
      const start = environmentBody(active.region.environment, active.region.start);
      if (start === null) return null;
      from = Math.max(from, start);
    }
    const environments = /\\begin\s*\{([^{}]+)\}/g;
    const mathPrefix = parsed.clean.slice(active.region.start, cursor);
    let environment;
    while ((environment = environments.exec(mathPrefix))) {
      if (Context.escaped(text, active.region.start + environment.index)) continue;
      const start = environmentBody(environment[1], active.region.start + environments.lastIndex);
      if (start === null || start > cursor) return null;
      from = Math.max(from, start);
    }

    // In "\\left (PQ", whitespace separates the delimiter from its command.
    // Moving that delimiter into a fraction would make \\left consume \\frac.
    const delimiterCommand = /\\(?:left|right|middle|[bB]ig(?:g)?[lrm]?)\s+$/.exec(text.slice(active.region.start, from));
    if (delimiterCommand && !Context.escaped(text, active.region.start + delimiterCommand.index)) return null;
    // In "\\sqrt PQ" or "\\frac{A} B", replacing an unbraced argument with
    // a command would make TeX consume only the new \\frac token. Leave these
    // spaced argument forms literal; conventional braced input remains usable.
    const beforeBlock = parsed.clean.slice(active.region.start, from);
    const argumentCommands = /\\([dtc]?frac|[dt]?binom|overset|underset|stackrel|sqrt|overline|underline|hat|bar|vec|dot|ddot|tilde|widehat|widetilde|math(?:bf|rm|it|sf|tt|cal|bb|frak))(?![A-Za-z])/g;
    let argumentCommand;
    while ((argumentCommand = argumentCommands.exec(beforeBlock))) {
      if (Context.escaped(beforeBlock, argumentCommand.index)) continue;
      let at = argumentCommands.lastIndex;
      const skipSpace = () => { while (/\s/.test(beforeBlock[at] || '')) at++; };
      const skipGroup = (open, close) => {
        let depth = 0;
        do {
          if (!Context.escaped(beforeBlock, at)) {
            if (beforeBlock[at] === open) depth++;
            else if (beforeBlock[at] === close) depth--;
          }
          at++;
        } while (at < beforeBlock.length && depth);
        return depth === 0;
      };
      skipSpace();
      if (argumentCommand[1] === 'sqrt' && beforeBlock[at] === '[') {
        if (!skipGroup('[', ']')) continue;
      }
      const count = /^(?:[dtc]?frac|[dt]?binom|overset|underset|stackrel)$/.test(argumentCommand[1]) ? 2 : 1;
      for (let index = 0; index < count; index++) {
        skipSpace();
        if (at === beforeBlock.length) return null;
        if (beforeBlock[at] === '{') {
          if (!skipGroup('{', '}')) break; // The cursor is inside an existing braced argument.
        } else {
          const token = /^\\(?:[A-Za-z]+|[^A-Za-z])/.exec(beforeBlock.slice(at));
          at += token?.[0].length || 1;
        }
      }
    }
    const groups = [];
    for (let at = from; at < cursor;) {
      const character = text[at];
      if (character === '\\') {
        const command = /^\\(?:[A-Za-z]+|[^A-Za-z])/.exec(text.slice(at, cursor))?.[0];
        if (!command) return null;
        at += command.length;
        if (command === '\\\\') {
          // Alignment rows and cells are outside the numerator.
          const spacing = /^\[[^\]]*\]/.exec(text.slice(at, cursor));
          at += spacing?.[0].length || 0;
          from = at;
          groups.length = 0;
        } else if (command === '\\begin' || command === '\\end') {
          const environment = /^\{[^{}]+\}/.exec(text.slice(at, cursor));
          if (!environment) return null;
          at += environment[0].length;
          from = at;
          groups.length = 0;
        } else if (command === '\\left' || command === '\\right' || command === '\\middle') {
          const delimiter = /^(?:\\[A-Za-z]+|\\[^A-Za-z]|[()[\]{}|.<>])/.exec(text.slice(at, cursor));
          if (!delimiter) return null;
          at += delimiter[0].length;
          if (command === '\\left') groups.push({ kind: 'delimiter', after: at });
          else if (command === '\\right') { if (groups.pop()?.kind !== 'delimiter') return null; }
          else {
            const enclosing = groups[groups.length - 1];
            if (enclosing?.kind !== 'delimiter') return null;
            enclosing.middle = true;
          }
        }
        continue;
      }
      if (character === '{') groups.push({ kind: 'brace', after: at + 1 });
      else if (character === '}' && groups.pop()?.kind !== 'brace') return null;
      else if (character === '&') { from = at + 1; groups.length = 0; }
      at++;
    }
    // Inside an unfinished group, wrap only its content, keeping its opener and
    // any existing closer in place. Never move an unmatched closer across braces.
    if (groups.some((group) => group.middle)) return null;
    if (groups.length) from = groups[groups.length - 1].after;
    if (from === cursor) return null;
    const insert = '\\frac{' + text.slice(from, cursor) + '}{}';
    return { from, to: cursor, insert, anchor: from + insert.length - 1 };
  }

  function createEngine(initialSettings) {
    let cachedText;
    let cachedParse;
    let artifact = initialSettings?.model ?? bundledModel ?? undefined;
    let predictor = Predictor.createPredictor(artifact);

    function parse(documentText) {
      if (cachedText !== documentText) {
        cachedText = documentText;
        cachedParse = Context.analyzeDocument(documentText);
        cachedParse.segments = Context.mathSegments(cachedParse);
      }
      return cachedParse;
    }

    function collectCandidates(documentText, cursor, overrides) {
      if (typeof documentText !== 'string' || !Number.isInteger(cursor) || cursor < 0 || cursor > documentText.length) return null;
      const settings = Object.assign({}, DEFAULT_SETTINGS, initialSettings, overrides);
      if (!settings.enabled) return null;
      settings.minPrefix = Math.max(1, Math.min(30, Number(settings.minPrefix) || DEFAULT_SETTINGS.minPrefix));
      settings.maxSuggestionLength = Math.max(1, Math.min(2000, Number(settings.maxSuggestionLength) || DEFAULT_SETTINGS.maxSuggestionLength));
      const parsed = parse(documentText);
      const active = Context.contextAt(parsed, cursor);
      if (!active) return null;
      const { region, itemId, ancestorIds } = active;
      const before = parsed.clean.slice(Math.max(region.start, cursor - settings.maxSuggestionLength), cursor);
      const prefix = before.split(/\\\\|\r?\n/).pop();
      const segments = parsed.segments.filter((segment) => !(segment.start <= cursor && cursor <= segment.end))
        .sort((a, b) => Context.scopeTier(parsed, cursor, b.start) - Context.scopeTier(parsed, cursor, a.start) ||
          Math.abs(a.start - cursor) - Math.abs(b.start - cursor)).slice(0, 128);
      const context = { prefix, right: parsed.clean.slice(cursor, Math.min(region.end, cursor + settings.maxSuggestionLength)),
        segments, itemId, ancestorIds, cursor, maxTokens: 12, maxCandidates: 32,
        declarations: declarationContext(parsed, active, cursor) };
      context.classification = Classifier.analyze(context);
      const candidates = [];
      if (settings.sequences) {
        const sequence = sequenceSuggestion(parsed, region, documentText, cursor, settings);
        if (sequence) candidates.push(sequence);
      }
      if (settings.expressions) {
        candidates.push(...indexSuggestions(context, parsed, documentText, cursor, settings));
        candidates.push(...expressionSuggestions(parsed, region, documentText, cursor, settings, context));
        // Generative v1 fills the end of an expression or an auto-paired group.
        // Existing expression retrieval can still fill known gaps in other text.
        if ((compact(prefix).length >= settings.minPrefix || context.classification.kind === 'index') && /^[\s}\])]*$/.test(context.right)) {
          for (const proposal of predictor.candidates(context)) {
            const result = finish(proposal.fullText ?? proposal.insertText, proposal.kind || 'prediction',
              'Predict a mathematical continuation', documentText, cursor, settings, proposal);
            // The provider owns features, but never the final insertion/overlap checks.
            if (result) {
              result.fullText = proposal.fullText ?? proposal.insertText;
              result.insertText = trimOverlap(result.fullText, documentText.slice(cursor, cursor + settings.maxSuggestionLength));
              result.itemTier = proposal.itemTier ?? proposal.scopeTier ??
                (proposal.features?.sameItem > 0 ? 2 : proposal.features?.parentItem > 0 ? 1 : 0);
              candidates.push(result);
            }
          }
        }
      }
      const unique = new Map();
      for (const candidate of candidates) {
        if (!candidate.insertText?.trim()) continue;
        semanticFeatures(candidate, context);
        if (context.classification.kind === 'index' && candidate.features.indexFit <= -1) continue;
        candidate.scopeTier = candidate.itemTier;
        candidate.features = { ...candidate.features, sameItem: candidate.itemTier === 2 ? 1 : 0,
          parentItem: candidate.itemTier === 1 ? 1 : 0,
          sameItemEvidence: candidate.features?.sameItemEvidence ?? (candidate.itemTier === 2 ? 1 : 0),
          ancestorEvidence: candidate.features?.ancestorEvidence ?? (candidate.itemTier === 1 ? 1 : 0) };
        const previous = unique.get(candidate.insertText);
        if (!previous || candidate.itemTier > previous.itemTier ||
            (candidate.itemTier === previous.itemTier && candidate.semanticScore > previous.semanticScore)) unique.set(candidate.insertText, candidate);
      }
      return { candidates: predictor.prepareCandidates([...unique.values()].sort((a, b) => b.itemTier - a.itemTier).slice(0, 32), context), context };
    }

    return {
      collectCandidates,
      rankCandidates(candidates, context) { return predictor.rank(candidates, context); },
      suggest(documentText, cursor, overrides) {
        const collected = collectCandidates(documentText, cursor, overrides);
        if (!collected?.candidates.length) return null;
        const ranked = predictor.rank(collected.candidates, collected.context);
        const threshold = predictor.trained && Number.isFinite(artifact?.training?.recommendedThreshold)
          ? Math.max(0, Math.min(1, artifact.training.recommendedThreshold)) : 0;
        return selectCandidate(ranked, threshold, predictor.trained);
      },
      isMathContext(documentText, cursor) {
        return typeof documentText === 'string' && Boolean(Context.contextAt(parse(documentText), cursor));
      },
      fractionEdit(documentText, cursor) {
        return typeof documentText === 'string' ? fractionEdit(parse(documentText), cursor) : null;
      },
      setModel(nextArtifact) { artifact = nextArtifact; predictor = Predictor.createPredictor(artifact); return predictor.valid; },
      feedback(candidate, accepted) { return predictor.feedback(candidate, accepted); },
      calibrationState() { return predictor.calibrationState(); },
      reset() { cachedText = undefined; cachedParse = undefined; predictor.reset(); }
    };
  }

  let gateText, gateParse;
  function isMathContext(text, cursor) {
    if (typeof text !== 'string') return false;
    if (gateText !== text) { gateText = text; gateParse = Context.analyzeDocument(text); }
    return Boolean(Context.contextAt(gateParse, cursor));
  }

  return { DEFAULT_SETTINGS, createEngine, isMathContext, selectCandidate };
});
