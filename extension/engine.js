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
  const compact = (value) => value.replace(/\s+/g, '');
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const escaped = Context.escaped;

  function baseStartsAt(text, position) {
    return !escaped(text, position) && !/[A-Za-z0-9\\}]/.test(text[position - 1] || '');
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

  // Parse scripted factors before finding sequence boundaries. In particular,
  // the k_i inside p_i^{k_i} belongs to that factor, not to an outer list.
  const SEQUENCE_OPERATORS = 'cdot|times|ast|star|circ|pm|mp|cup|cap|setminus|oplus|otimes|' +
    'subset|subseteq|subsetneq|subsetneqq|subseteqq|supset|supseteq|supsetneq|supsetneqq|supseteqq|' +
    'in|ni|le|leq|leqslant|ge|geq|geqslant|ll|gg|prec|preceq|succ|succeq|' +
    'equiv|sim|simeq|approx|cong|to|rightarrow|leftarrow|leftrightarrow|mapsto|' +
    'Rightarrow|Leftarrow|Leftrightarrow|implies|iff|mid|parallel|ne|neq';
  const SEQUENCE_OPERATOR = '(?:\\\\(?:' + SEQUENCE_OPERATORS + ')(?![A-Za-z])|<=|>=|[,+*=<>;≤≥⊂⊆⊃⊇∪∩×·→←↔-])';
  const SEQUENCE_BASE = '(?:' + ELEMENT_STYLE + '|' + ELEMENT_GROUP + '|' +
    String.raw`(?:\\(?!(?:` + SEQUENCE_OPERATORS + String.raw`|ldots|cdots|dots)(?![A-Za-z]))(?!` +
    STYLE_NAMES + String.raw`)[A-Za-z]+(?![A-Za-z])|[A-Za-z0-9]))+`;
  const DOTS = /^(\\(?:l|c)?dots(?![A-Za-z])|\.{3}(?!\.)|…)/;
  const endpointValue = (value) => /^(?:[A-Za-z]|\d+|\\[A-Za-z]+|[A-Za-z]\s*[-+]\s*\d+)$/.test(value);

  function sequenceSeparator(raw) {
    if (/^[ \t]*$/.test(raw)) return { key: '', raw };
    const match = new RegExp('^\\s*(' + SEQUENCE_OPERATOR + ')\\s*$').exec(raw);
    return match ? { key: match[1], raw } : null;
  }

  function separatorPrefix(text, separator) {
    if (!separator.key) {
      const raw = /^[ \t]*/.exec(text)[0];
      return { raw, rest: text.slice(raw.length) };
    }
    const match = new RegExp('^\\s*' + escapeRegex(separator.key) +
      (separator.key.startsWith('\\') ? '(?![A-Za-z])' : '') + '\\s*').exec(text);
    return match ? { raw: match[0], rest: text.slice(match[0].length) } : null;
  }

  function ellipsisTail(tail, separator) {
    const before = separatorPrefix(tail, separator);
    const dots = before && DOTS.exec(before.rest);
    if (!dots) return null;
    const rest = before.rest.slice(dots[0].length);
    const after = separatorPrefix(rest, separator);
    if (!after && rest.trim()) return null;
    return { dots: dots[0], typed: after?.rest || '', hasSeparator: !!after, after: after?.raw || '' };
  }

  function ellipsisBetween(raw) {
    const match = /\\(?:l|c)?dots(?![A-Za-z])|\.{3}(?!\.)|…/.exec(raw);
    if (!match) return null;
    const before = sequenceSeparator(raw.slice(0, match.index));
    const after = sequenceSeparator(raw.slice(match.index + match[0].length));
    return before && after && before.key === after.key ? { ...before, dots: match[0] } : null;
  }

  function scriptArgument(text, position, limit = text.length) {
    while (position < limit && /\s/.test(text[position])) position++;
    const start = position;
    if (text[position] === '{') {
      let depth = 1;
      for (position++; position < limit; position++) {
        if (escaped(text, position)) continue;
        if (text[position] === '{' && ++depth > 32) return null;
        if (text[position] === '}' && --depth === 0) {
          return { start, end: position + 1, from: start + 1, to: position, braced: true };
        }
      }
      return null;
    }
    const match = /^(?:\\(?:[A-Za-z]+|[^\s])|\d+|[^{}_^\\\s])/.exec(text.slice(position, limit));
    return match ? { start, end: position + match[0].length, from: start, to: position + match[0].length, braced: false } : null;
  }

  function scriptSlots(text, from, to, slots, depth = 0) {
    if (depth > 32) return false;
    for (let at = from; at < to; at++) {
      if ((text[at] !== '_' && text[at] !== '^') || escaped(text, at)) continue;
      const argument = scriptArgument(text, at + 1, to);
      if (!argument) return false;
      const value = text.slice(argument.from, argument.to).trim();
      if (text[at] === '_' && endpointValue(value)) {
        slots.push({ start: argument.start, end: argument.end, value, braced: argument.braced });
      } else if (!scriptSlots(text, argument.from, argument.to, slots, depth + 1)) return false;
      at = argument.end - 1;
    }
    return true;
  }

  function previousTerms(fragment, includeEndpoints = false, source = fragment) {
    const base = new RegExp(SEQUENCE_BASE, 'y');
    const atoms = [];
    let at = 0;
    while (at < fragment.length) {
      base.lastIndex = at;
      const match = base.exec(fragment);
      if (!match || (at > 0 && !baseStartsAt(fragment, at) && atoms[atoms.length - 1]?.end !== at)) {
        // Never start in the middle of a control word.
        const command = /^\\[A-Za-z]+/.exec(fragment.slice(at));
        at += command ? command[0].length : 1;
        continue;
      }
      const start = at;
      let end = base.lastIndex, hasScript = false, valid = true, incomplete = false;
      const scripts = new Set();
      while (true) {
        let next = end;
        while (/\s/.test(fragment[next] || '')) next++;
        if (!/[_^]/.test(fragment[next] || '')) break;
        hasScript = true;
        if (scripts.has(fragment[next])) valid = false;
        scripts.add(fragment[next]);
        const argument = scriptArgument(fragment, next + 1);
        if (!argument) { incomplete = true; break; }
        end = argument.end;
      }
      if (incomplete) break;
      if (!hasScript) { at = base.lastIndex; continue; }
      const slots = [];
      valid = scriptSlots(fragment, base.lastIndex, end, slots) && valid &&
        fragment.slice(start, end) === source.slice(start, end);
      const chunks = [];
      let offset = start;
      for (const slot of slots) {
        chunks.push(fragment.slice(offset, slot.start), { value: slot.value, braced: slot.braced });
        offset = slot.end;
      }
      chunks.push(fragment.slice(offset, end));
      const value = slots[0]?.value;
      const shared = valid && value && slots.every((slot) => compact(slot.value) === compact(value)) ? value : null;
      atoms.push({ start, end, chunks, value: shared,
        number: shared !== null && /^\d+$/.test(shared) && Number.isSafeInteger(Number(shared)) ? Number(shared) : null });
      at = end;
    }
    const terms = [];
    let endpointEnd = null;
    for (const atom of atoms) {
      if (endpointEnd !== null && /^[ \t]*$/.test(source.slice(endpointEnd, atom.start))) {
        endpointEnd = atom.end;
        continue;
      }
      endpointEnd = null;
      const previous = terms[terms.length - 1];
      const gap = previous ? source.slice(previous.end, atom.start) : '';
      if (!includeEndpoints && previous && ellipsisBetween(gap)) { endpointEnd = atom.end; continue; }
      // Equal indices make a compound element; a changed index starts the next
      // juxtaposed term. Invalid factors stay present so suffix runs cannot hide them.
      if (previous && /^[ \t]*$/.test(gap) && atom.value !== null && compact(previous.value || '') === compact(atom.value)) {
        previous.parts.push({ ...atom, gap });
        previous.end = atom.end;
      } else {
        terms.push({ parts: [{ ...atom, gap: '' }], start: atom.start, end: atom.end, value: atom.value, number: atom.number });
      }
    }
    return terms;
  }

  function sameParts(left, right) {
    return left.length === right.length && left.every((part, index) => {
      const chunks = right[index].chunks;
      return part.chunks.length === chunks.length && part.chunks.every((chunk, i) =>
        typeof chunk === 'string' ? typeof chunks[i] === 'string' && compact(chunk) === compact(chunks[i]) : typeof chunks[i] === 'object');
    });
  }

  function latexJoin(left, right) {
    return left + (/\\[A-Za-z]+$/.test(left) && /^[A-Za-z]/.test(right) ? ' ' : '') + right;
  }

  function completeTerm(parts, value, typed = '') {
    const needle = compact(typed), renderedParts = [];
    let text = '';
    for (const part of parts) {
      text += part.gap;
      const chunks = [];
      for (const chunk of part.chunks) {
        if (typeof chunk === 'string') { text = latexJoin(text, chunk); chunks.push(chunk); continue; }
        const normalized = compact(text);
        const braced = needle.startsWith(normalized) && needle.length > normalized.length ? needle[normalized.length] === '{' : chunk.braced;
        chunks.push({ ...chunk, braced });
        text += indexText(value, braced);
      }
      renderedParts.push({ ...part, chunks });
    }
    const normalized = compactWithPositions(text);
    if (!normalized.value.startsWith(needle)) return null;
    const offset = needle.length ? normalized.positions[needle.length - 1] + 1 : 0;
    return { text, suffix: text.slice(offset), parts: renderedParts };
  }

  function indexText(value, braced) {
    return braced || !/^(?:[A-Za-z]|\d)$/.test(value) ? '{' + value + '}' : value;
  }

  function inferEndpoint(parsed, parts, firstNumber, cursor, settings, separator) {
    // Evidence in the current answer wins before parent items and the rest of the file.
    if (!parsed.scopeFiltered && Context.itemAt(parsed, cursor)) {
      for (const tier of [2, 1, 0]) {
        const scoped = { ...parsed, scopeFiltered: true,
          regions: parsed.regions.filter((region) => Context.scopeTier(parsed, cursor, region.start) === tier) };
        const result = inferEndpoint(scoped, parts, firstNumber, cursor, settings, separator);
        if (result.source === 'previous-list' || result.source === 'nearby-bound') return result;
      }
    }
    const regions = parsed.regions.map((region) => {
      const clean = parsed.clean.slice(region.start, region.end);
      const body = parsed.source.slice(region.start, region.end);
      const terms = region.sequenceTerms || (region.sequenceTerms = previousTerms(clean, true, body));
      return { ...region, body, clean, terms };
    });
    let best = null;
    for (const region of regions) {
      for (let i = 0; i + 2 < region.terms.length; i++) {
        const [first, second, last] = region.terms.slice(i, i + 3);
        if (first.number === null || second.number !== first.number + 1 || !last.value || !endpointValue(last.value) ||
            ![first, second, last].every((term) => sameParts(term.parts, parts))) continue;
        const between = sequenceSeparator(region.body.slice(first.end, second.start));
        const dots = ellipsisBetween(region.body.slice(second.end, last.start));
        if (!between || between.key !== separator.key || !dots || dots.key !== separator.key) continue;
        // Validate the entire numeric run before reusing its endpoint, including
        // examples that spell out three or more terms before the ellipsis.
        let runStart = i;
        while (runStart > 0) {
          const earlier = region.terms[runStart - 1], current = region.terms[runStart];
          const before = sequenceSeparator(region.body.slice(earlier.end, current.start));
          if (before?.key !== separator.key || earlier.number === null ||
              earlier.number + 1 !== current.number || !sameParts(earlier.parts, parts)) break;
          runStart--;
        }
        const earlier = region.terms[runStart - 1];
        if (earlier) {
          const before = sequenceSeparator(region.body.slice(earlier.end, region.terms[runStart].start));
          if (before && (before.key === separator.key || before.key === '')) continue;
        }
        if (/[A-Za-z0-9_]/.test(region.body[last.end] || '')) continue;
        const following = region.terms[i + 3];
        if (following && sequenceSeparator(region.body.slice(last.end, following.start))?.key === '') continue;
        const position = region.start + region.terms[runStart].start;
        if (position <= cursor && region.start + last.end >= cursor) continue;
        const score = Math.abs(cursor - position) + (region.terms[runStart].number === firstNumber ? 0 : 10000);
        if (!best || score < best.score) best = { value: last.value, dots: dots.dots, score, source: 'previous-list', position };
      }
    }
    if (best) return best;
    for (const region of regions.sort((a, b) => Math.abs(a.start - cursor) - Math.abs(b.start - cursor))) {
      if (Math.abs(region.start - cursor) > 1500) continue;
      for (let i = 0; i < region.terms.length; i++) {
        const term = region.terms[i], before = region.terms[i - 1], after = region.terms[i + 1];
        if ((before && sequenceSeparator(region.body.slice(before.end, term.start))?.key === '') ||
            (after && sequenceSeparator(region.body.slice(term.end, after.start))?.key === '') ||
            /[A-Za-z0-9_]/.test(region.body[term.end] || '')) continue;
        if (!sameParts(term.parts, parts) || !/^[ijk]$/.test(term.value || '')) continue;
        const symbol = term.value;
        const endpointPattern = String.raw`([A-Za-z](?:\s*[-+]\s*\d+)?|\d+|\\[A-Za-z]+)(?![A-Za-z0-9])`;
        const boundPatterns = [
          String.raw`(?:0|1)\s*\\le(?:q)?\s*` + symbol + String.raw`\s*\\le(?:q)?\s*`,
          symbol + String.raw`\s*=\s*(?:0|1)\s*,\s*(?:\\(?:l|c)?dots|\.\.\.)\s*,\s*`,
        ];
        for (const pattern of boundPatterns) {
          for (const bound of region.clean.matchAll(new RegExp(pattern + endpointPattern, 'g'))) {
            if (!baseStartsAt(region.clean, bound.index)) continue;
            const remainder = region.clean.slice(bound.index + bound[0].length).trimStart();
            if (/^(?:[-+*\/^_(A-Za-z0-9]|\\(?:cdot|times|frac|over|div|ast)\b)/.test(remainder)) continue;
            return { value: bound[1], dots: separator.key === ',' ? '\\ldots' : '\\cdots', source: 'nearby-bound', position: region.start };
          }
        }
      }
    }
    const configured = typeof settings.sequenceEnd === 'string' || typeof settings.sequenceEnd === 'number'
      ? String(settings.sequenceEnd).trim() : '';
    const explicitInteger = /^\d{1,3}$/.test(configured) && Number(configured) >= 3 && Number(configured) <= 999;
    const explicitSymbol = /^(?:[A-Za-z]|\\[A-Za-z]+|[A-Za-z]\s*[-+]\s*\d+)$/.test(configured);
    const value = explicitInteger ? String(Number(configured)) : explicitSymbol ? configured : 'n';
    return { value, dots: separator.key === ',' ? '\\ldots' : '\\cdots', source: value === 'n' ? 'default' : 'configured' };
  }

  function sequenceSuggestion(parsed, region, text, cursor, settings) {
    const outer = sequenceCompletion(parsed, region, text, cursor, settings);
    if (outer) return outer;
    // If no outer pattern fits, an unfinished script may itself contain a list
    // (x^{a_1+a_2|}). Try only its currently open groups, never completed scripts.
    const groups = [];
    for (let at = region.start; at < cursor; at++) {
      if (escaped(parsed.clean, at)) continue;
      if (parsed.clean[at] === '{') groups.push(at);
      else if (parsed.clean[at] === '}') groups.pop();
    }
    for (const start of groups.slice(-32).reverse()) {
      const inner = sequenceCompletion(parsed, { ...region, start }, text, cursor, settings);
      if (inner) return inner;
    }
    return null;
  }

  function sequenceCompletion(parsed, region, text, cursor, settings) {
    const fragmentStart = Math.max(region.start, cursor - 1000);
    const fragment = text.slice(fragmentStart, cursor);
    const terms = previousTerms(parsed.clean.slice(fragmentStart, cursor), false, fragment);
    if (!terms.length) return null;
    let last = terms[terms.length - 1];
    // A partial factor or product is rendered from the previous complete term.
    // This also covers an unfinished nested exponent p_2^{k_.
    const previous = terms[terms.length - 2];
    if (previous && previous.number !== null) {
      const separator = sequenceSeparator(fragment.slice(previous.end, last.start));
      const typed = fragment.slice(last.start);
      const next = separator && completeTerm(previous.parts, String(previous.number + 1), typed);
      if (next && next.suffix && typed.includes('_')) { terms.pop(); last = previous; }
    }
    if (last.number === null) return null;
    let tail = fragment.slice(last.end), partial = '', separator, second = last, runEnd = terms.length - 1;
    // Find a partial next term after a supported operator (or juxtaposition).
    const split = new RegExp('^(\\s*' + SEQUENCE_OPERATOR + '\\s*|[ \\t]*)([\\s\\S]+)$').exec(tail);
    const next = split && split[2].includes('_') && completeTerm(last.parts, String(last.number + 1), split[2]);
    if (next) {
      separator = sequenceSeparator(split[1]);
      if (!separator) return null;
      partial = next.suffix;
      second = { ...last, number: last.number + 1, parts: next.parts, end: fragment.length };
      tail = '';
    } else {
      const previous = terms[terms.length - 2];
      if (!previous || previous.number === null || last.number !== previous.number + 1 || !sameParts(previous.parts, last.parts)) return null;
      separator = sequenceSeparator(fragment.slice(previous.end, last.start));
      if (!separator) return null;
      runEnd--;
    }
    let first = terms[runEnd];
    while (runEnd > 0) {
      const candidate = terms[runEnd - 1];
      const between = sequenceSeparator(fragment.slice(candidate.end, first.start));
      if (candidate.number === null || !sameParts(candidate.parts, first.parts) || candidate.number + 1 !== first.number || between?.key !== separator.key) break;
      first = candidate;
      runEnd--;
    }
    // An earlier mismatched term/operator invalidates the run rather than
    // silently making its last two terms a fresh sequence. '=' may introduce it.
    if (runEnd > 0) {
      const earlier = sequenceSeparator(fragment.slice(terms[runEnd - 1].end, first.start));
      if (earlier && (earlier.key === separator.key || earlier.key !== '=')) return null;
    }
    const dots = ellipsisTail(tail, separator);
    const trailing = sequenceSeparator(tail);
    if (!dots && (!trailing || (tail.trim() && trailing.key !== separator.key))) return null;
    let endpoint = inferEndpoint(parsed, second.parts, first.number, cursor, settings, separator);
    if (dots?.typed) {
      // A value already supplied by the user is stronger evidence than a default
      // (e.g. ...p_m^{k_| should finish k_m, even when the default is n).
      const values = [];
      for (let at = 0; at < dots.typed.length; at++) {
        if (dots.typed[at] !== '_' || escaped(dots.typed, at)) continue;
        const argument = scriptArgument(dots.typed, at + 1);
        const partial = !argument && /^\s*\{([^{}]*)$/.exec(dots.typed.slice(at + 1));
        const value = argument ? dots.typed.slice(argument.from, argument.to).trim() : partial?.[1].trim();
        if (value && endpointValue(value)) values.push(value);
      }
      if (values.length && values.every((value) => compact(value) === compact(values[0])) &&
          completeTerm(second.parts, values[0], dots.typed)) {
        endpoint = { value: values[0], source: 'typed' };
      }
    }
    if (/^\d+$/.test(endpoint.value) && Number(endpoint.value) <= second.number) return null;
    const ending = completeTerm(second.parts, endpoint.value, dots?.typed || '');
    if (!ending) return null;
    const missingSeparator = tail.trim()
      ? /\s*$/.exec(separator.raw)[0].slice(/\s*$/.exec(tail)[0].length)
      : separator.raw.replace(/^\s*/, (space) => space.slice(tail.length));
    let suffix;
    if (dots) suffix = latexJoin(tail, (dots.hasSeparator ? '' : separator.raw) + ending.suffix).slice(tail.length);
    else if (/^\d+$/.test(endpoint.value) && Number(endpoint.value) === second.number + 1) {
      suffix = latexJoin(partial + missingSeparator, ending.text);
    } else {
      suffix = latexJoin(partial + missingSeparator + endpoint.dots + separator.raw, ending.text);
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
