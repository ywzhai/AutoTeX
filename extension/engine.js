(function (root, factory) {
  const commonJS = typeof module === 'object' && module.exports;
  const Context = commonJS ? require('./context.js') : root.AutoTexContext;
  const Predictor = commonJS ? require('./predictor.js') : root.AutoTexPredictor;
  const model = commonJS ? require('./model.js') : root.AutoTexModel;
  const api = factory(Context, Predictor, model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MathAutocompleteEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Context, Predictor, bundledModel) {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    expressions: true,
    sequences: true,
    minPrefix: 3,
    maxSuggestionLength: 400,
    sequenceEnd: 'n',
    debounceMs: 50
  });
  const BASE_SOURCE = String.raw`(?:\\(?:mathrm|mathbf|mathit|mathsf|mathtt|boldsymbol|bm)\s*\{(?:\\[A-Za-z]+|[A-Za-z])\}|\\[A-Za-z]+|\{(?:\\[A-Za-z]+|[A-Za-z])\}|[A-Za-z])`;
  const TERM_SOURCE = '(' + BASE_SOURCE + ')' + String.raw`\s*_\s*(?:\{(\d+)\}|(\d+))`;
  const compact = (value) => value.replace(/\s+/g, '');
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const escaped = Context.escaped;

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
    // Evidence from this answer takes priority even over a complete list in
    // another answer. A nested subitem can fall back to its parent afterward.
    if (!parsed.scopeFiltered && Context.itemAt(parsed, cursor)) {
      for (const tier of [2, 1, 0]) {
        const scoped = { ...parsed, scopeFiltered: true,
          regions: parsed.regions.filter((region) => Context.scopeTier(parsed, cursor, region.start) === tier) };
        const result = inferEndpoint(scoped, base, firstNumber, cursor, settings);
        if (result.source === 'previous-list' || result.source === 'nearby-bound') return result;
      }
    }
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
        if (!best || score < best.score) best = { value: endpoint, dots: match[5], score, source: 'previous-list', position };
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
        return { value: bound[1], dots: '\\ldots', source: 'nearby-bound', position: region.start };
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

  function expressionSuggestions(parsed, region, text, cursor, settings) {
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
    return results.sort((a, b) => b.itemTier - a.itemTier || b.legacyScore - a.legacyScore).slice(0, 24);
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
        segments, itemId, ancestorIds, cursor, maxTokens: 12, maxCandidates: 32 };
      const candidates = [];
      if (settings.sequences) {
        const sequence = sequenceSuggestion(parsed, region, documentText, cursor, settings);
        if (sequence) candidates.push(sequence);
      }
      if (settings.expressions) {
        candidates.push(...expressionSuggestions(parsed, region, documentText, cursor, settings));
        // Generative v1 fills the end of an expression or an auto-paired group.
        // Existing expression retrieval can still fill known gaps in other text.
        if (compact(prefix).length >= settings.minPrefix && /^[\s}\])]*$/.test(context.right)) {
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
        candidate.scopeTier = candidate.itemTier;
        candidate.features = { ...candidate.features, sameItem: candidate.itemTier === 2 ? 1 : 0,
          parentItem: candidate.itemTier === 1 ? 1 : 0,
          sameItemEvidence: candidate.features?.sameItemEvidence ?? (candidate.itemTier === 2 ? 1 : 0),
          ancestorEvidence: candidate.features?.ancestorEvidence ?? (candidate.itemTier === 1 ? 1 : 0) };
        const previous = unique.get(candidate.insertText);
        if (!previous || candidate.itemTier > previous.itemTier) unique.set(candidate.insertText, candidate);
      }
      return { candidates: [...unique.values()].sort((a, b) => b.itemTier - a.itemTier).slice(0, 32), context };
    }

    return {
      collectCandidates,
      suggest(documentText, cursor, overrides) {
        const collected = collectCandidates(documentText, cursor, overrides);
        if (!collected?.candidates.length) return null;
        const ranked = predictor.rank(collected.candidates, collected.context);
        // Scope priority is a product requirement, independent of learned weights.
        ranked.sort((a, b) => b.itemTier - a.itemTier);
        if (!predictor.trained) {
          const bestTier = ranked[0]?.itemTier ?? 0;
          const reliable = collected.candidates.filter((candidate) => candidate.itemTier === bestTier &&
            (candidate.kind === 'sequence' || candidate.kind === 'expression'));
          reliable.sort((a, b) => Number(b.kind === 'sequence') - Number(a.kind === 'sequence') ||
            (b.legacyScore || 0) - (a.legacyScore || 0));
          if (reliable.length) return reliable[0];
        }
        const threshold = predictor.trained && Number.isFinite(artifact?.training?.recommendedThreshold)
          ? Math.max(0, Math.min(1, artifact.training.recommendedThreshold)) : 0;
        return ranked[0]?.score >= threshold ? ranked[0] : null;
      },
      isMathContext(documentText, cursor) {
        return typeof documentText === 'string' && Boolean(Context.contextAt(parse(documentText), cursor));
      },
      setModel(nextArtifact) { artifact = nextArtifact; predictor = Predictor.createPredictor(artifact); return predictor.valid; },
      reset() { cachedText = undefined; cachedParse = undefined; predictor.reset(); }
    };
  }

  let gateText, gateParse;
  function isMathContext(text, cursor) {
    if (typeof text !== 'string') return false;
    if (gateText !== text) { gateText = text; gateParse = Context.analyzeDocument(text); }
    return Boolean(Context.contextAt(gateParse, cursor));
  }

  return { DEFAULT_SETTINGS, createEngine, isMathContext };
});
