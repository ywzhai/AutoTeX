(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AutoTexContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MATH_ENVIRONMENTS = /^(?:equation|align|alignat|gather|multline|eqnarray|flalign|math|displaymath)\*?$/;
  const LIST_ENVIRONMENTS = /^(?:enumerate|itemize|description|list|compactenum|compactitem|inparaenum|inparaitem|asparaenum)\*?$/;
  const TEXT_COMMANDS = /\\(?:text|textrm|textit|textbf|textnormal|textsf|texttt|mbox|hbox|vbox|fbox|makebox|intertext|shortintertext|operatorname|label|tag|ref|eqref|cite|url)\*?\s*\{/g;

  function escaped(text, position) {
    let count = 0;
    while (position > 0 && text[--position] === '\\') count++;
    return count % 2 === 1;
  }

  function inComment(text, cursor) {
    const line = text.lastIndexOf('\n', cursor - 1) + 1;
    for (let i = line; i < cursor; i++) if (text[i] === '%' && !escaped(text, i)) return true;
    return false;
  }

  function blank(text) { return text.replace(/[^\r\n]/g, ' '); }

  function maskComments(text) {
    return text.replace(/[^\r\n]*(?:\r?\n|$)/g, (line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '%' && !escaped(line, i)) return line.slice(0, i) + blank(line.slice(i));
      }
      return line;
    });
  }

  function maskLiterals(text) {
    const pattern = /\\begin\{(verbatim\*?|Verbatim|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|comment)\}|\\(?:verb\*?|lstinline\*?)(?![A-Za-z])/g;
    const excluded = [], pieces = [];
    let offset = 0, match;
    while ((match = pattern.exec(text))) {
      if (escaped(text, match.index) || inComment(text, match.index)) continue;
      let end, closed;
      if (match[1]) {
        const close = '\\end{' + match[1] + '}';
        const at = text.indexOf(close, pattern.lastIndex);
        closed = at >= 0;
        end = closed ? at + close.length : text.length;
      } else {
        let at = pattern.lastIndex;
        if (match[0].startsWith('\\lstinline') && text[at] === '[') {
          const optionEnd = text.indexOf(']', at + 1);
          if (optionEnd < 0) continue;
          at = optionEnd + 1;
        }
        const delimiter = text[at];
        if (!delimiter || /\s/.test(delimiter)) continue;
        const newline = text.indexOf('\n', at + 1);
        const boundary = newline < 0 ? text.length : newline;
        const close = text.indexOf(delimiter === '{' ? '}' : delimiter, at + 1);
        closed = close >= 0 && close < boundary;
        end = closed ? close + 1 : boundary;
      }
      excluded.push({ start: match.index, end, closed });
      pieces.push(text.slice(offset, match.index), blank(text.slice(match.index, end)));
      offset = end;
      pattern.lastIndex = end;
    }
    pieces.push(text.slice(offset));
    return { text: pieces.join(''), excluded };
  }

  function maskTextArguments(text, initialRegions) {
    const ranges = [], pieces = [];
    const pattern = new RegExp(TEXT_COMMANDS.source, 'g');
    let offset = 0, match;
    while ((match = pattern.exec(text))) {
      if (escaped(text, match.index)) continue;
      const metadata = /^\\(?:label|tag|ref|eqref|cite|url)\b/.test(match[0]);
      if (!metadata && !initialRegions.some((region) => region.start <= match.index && match.index < region.end)) continue;
      const start = pattern.lastIndex;
      let depth = 1, end = start;
      while (end < text.length && depth) {
        if (!escaped(text, end)) {
          if (text[end] === '{') depth++;
          else if (text[end] === '}') depth--;
        }
        end++;
      }
      const closed = depth === 0;
      ranges.push({ start, end: closed ? end - 1 : end, commandStart: match.index, after: end, closed });
      pieces.push(text.slice(offset, match.index), blank(text.slice(match.index, end)));
      offset = end;
      pattern.lastIndex = end;
    }
    pieces.push(text.slice(offset));
    return { text: pieces.join(''), ranges };
  }

  function mathRegions(text) {
    const regions = [];
    const pattern = /\\(?:begin|end)\s*\{([^}]+)\}|\\[()[\]]|\$\$?/g;
    let active = null, match;
    while ((match = pattern.exec(text))) {
      if (escaped(text, match.index)) continue;
      const value = match[0];
      if (!active) {
        let close, environment = null;
        if (value === '$' || value === '$$') close = value;
        else if (value === '\\(') close = '\\)';
        else if (value === '\\[') close = '\\]';
        else if (value.startsWith('\\begin') && MATH_ENVIRONMENTS.test(match[1])) {
          environment = match[1]; close = '\\end{' + environment + '}';
        }
        if (close) active = { start: pattern.lastIndex, end: text.length, close, environment, closed: false };
      } else if (value === active.close || (active.environment && value.startsWith('\\end') && match[1] === active.environment)) {
        active.end = match.index;
        active.closed = true;
        regions.push(active);
        active = null;
      }
    }
    if (active) regions.push(active);
    return regions;
  }

  function definitionRanges(text) {
    const ranges = [];
    const pattern = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment|provideenvironment|(?:New|Renew|Provide|Declare)(?:Expandable)?Document(?:Command|Environment)|def|gdef|edef|xdef|let|futurelet)(?![A-Za-z])\*?/g;
    const space = (position) => {
      while (position < text.length && /\s/.test(text[position])) position++;
      return position;
    };
    function group(position, opening = '{', closing = '}') {
      if (text[position] !== opening) return position;
      let depth = 1, braces = 0;
      for (let at = position + 1; at < text.length; at++) {
        if (escaped(text, at)) continue;
        if (opening === '[') {
          if (text[at] === '{') braces++;
          else if (text[at] === '}') braces = Math.max(0, braces - 1);
          if (braces) continue;
        }
        if (text[at] === opening) depth++;
        else if (text[at] === closing && --depth === 0) return at + 1;
      }
      // An unfinished explicit definition body owns the remaining text.
      return text.length;
    }
    function token(position) {
      if (position >= text.length) return position;
      if (text[position] === '{') return group(position);
      if (text[position] !== '\\') return position + 1;
      const command = /^\\(?:[A-Za-z]+|[^A-Za-z])/.exec(text.slice(position));
      return position + (command?.[0].length || 1);
    }
    let match;
    while ((match = pattern.exec(text))) {
      if (escaped(text, match.index)) continue;
      const name = match[1];
      let end = token(space(pattern.lastIndex));
      if (name === 'let' || name === 'futurelet') {
        end = space(end);
        if (text[end] === '=') end = space(end + 1);
        end = token(end);
        if (name === 'futurelet') end = token(space(end));
      } else if (/^[gex]?def$/.test(name)) {
        // Parameter delimiters precede the first unescaped replacement group.
        while (end < text.length && (text[end] !== '{' || escaped(text, end))) end++;
        end = group(end);
      } else {
        end = space(end);
        while (text[end] === '[') end = space(group(end, '[', ']'));
        if (/Document(?:Command|Environment)$/.test(name)) end = space(group(end));
        const bodies = /environment|Environment/.test(name) ? 2 : 1;
        for (let index = 0; index < bodies; index++) {
          end = space(end);
          if (text[end] !== '{') break;
          end = group(end);
        }
      }
      ranges.push({ start: match.index, end });
      pattern.lastIndex = Math.max(pattern.lastIndex, end);
    }
    return ranges;
  }

  function findItems(clean, regions) {
    const items = [], lists = [];
    const rootList = { current: null, parentId: null, depth: 0, baseGroupDepth: 0 };
    const definitions = definitionRanges(clean);
    const pattern = /\\(?:begin|end)\s*\{([^}]+)\}|\\item(?![A-Za-z])|[{}]/g;
    let match, groupDepth = 0, regionIndex = 0, definitionIndex = 0;
    while ((match = pattern.exec(clean))) {
      if (escaped(clean, match.index)) continue;
      while (definitions[definitionIndex] && definitions[definitionIndex].end <= match.index) definitionIndex++;
      const definition = definitions[definitionIndex];
      if (definition && definition.start <= match.index && match.index < definition.end) {
        pattern.lastIndex = definition.end;
        continue;
      }
      while (regions[regionIndex] && regions[regionIndex].end < match.index) regionIndex++;
      const math = regions[regionIndex];
      if (math && math.start <= match.index && match.index < math.end) continue;
      const value = match[0];
      if (value === '{') { groupDepth++; continue; }
      if (value === '}') { groupDepth = Math.max(0, groupDepth - 1); continue; }
      if (match[1] && LIST_ENVIRONMENTS.test(match[1])) {
        if (value.startsWith('\\begin')) {
          const parent = lists[lists.length - 1] || rootList;
          lists.push({ name: match[1], current: null, parentId: parent.current?.id ?? parent.parentId,
            depth: lists.length + 1, baseGroupDepth: groupDepth });
        } else {
          const at = lists.map((list) => list.name === match[1] && list.baseGroupDepth === groupDepth).lastIndexOf(true);
          if (at >= 0) {
            for (const list of lists.splice(at)) if (list.current) list.current.end = match.index;
          }
        }
      } else if (value === '\\item') {
        const list = lists[lists.length - 1] || rootList;
        // A list may itself be grouped (for example {\small\begin{enumerate}}),
        // while literal item tokens inside a further command argument are ignored.
        if (groupDepth !== list.baseGroupDepth) continue;
        if (list.current) list.current.end = match.index;
        let contentStart = pattern.lastIndex;
        while (/\s/.test(clean[contentStart] || '') && contentStart < clean.length) contentStart++;
        if (clean[contentStart] === '[') {
          let brackets = 1, braces = 0, at = contentStart + 1;
          while (at < clean.length && brackets) {
            if (!escaped(clean, at)) {
              if (clean[at] === '{') braces++;
              else if (clean[at] === '}') braces--;
              else if (!braces && clean[at] === '[') brackets++;
              else if (!braces && clean[at] === ']') brackets--;
            }
            at++;
          }
          contentStart = at;
        }
        const item = { id: items.length + 1, start: match.index, contentStart, end: clean.length, parentId: list.parentId, depth: list.depth };
        items.push(item); list.current = item;
        pattern.lastIndex = contentStart;
      }
    }
    return items;
  }

  function itemAt(parsed, cursor) {
    // Items are ordered by source position. After a child list ends, walk back
    // through its parent chain rather than scanning every answer in the file.
    let low = 0, high = parsed.items.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (parsed.items[middle].start <= cursor) { found = middle; low = middle + 1; }
      else high = middle - 1;
    }
    let item = parsed.items[found];
    while (item) {
      if (cursor < item.end || (cursor === parsed.clean.length && item.end === cursor)) return item;
      item = item.parentId == null ? null : parsed.items[item.parentId - 1];
    }
    return null;
  }

  function analyzeDocument(text) {
    if (typeof text !== 'string') throw new TypeError('Expected LaTeX source text');
    const literals = maskLiterals(text);
    const comments = maskComments(literals.text);
    const prose = maskTextArguments(comments, mathRegions(comments));
    const regions = mathRegions(prose.text);
    return { clean: prose.text, source: text, literalText: literals.text, excluded: literals.excluded,
      textRanges: prose.ranges, regions, items: findItems(prose.text, regions) };
  }

  function contextAt(parsed, cursor) {
    if (!parsed || !Number.isInteger(cursor) || cursor < 0 || cursor > parsed.clean.length) return null;
    if (inComment(parsed.literalText, cursor) || parsed.excluded.some((range) => cursor > range.start &&
      (cursor < range.end || (!range.closed && cursor === range.end))) ||
      parsed.textRanges.some((range) => cursor > range.commandStart && cursor <= range.end)) return null;
    const region = parsed.regions.find((part) => part.start <= cursor && cursor <= part.end);
    if (!region) return null;
    const item = itemAt(parsed, cursor);
    const ancestorIds = [];
    let parentId = item?.parentId;
    while (parentId != null) {
      ancestorIds.push(parentId);
      parentId = parsed.items[parentId - 1]?.parentId;
    }
    return { region, item, itemId: item?.id ?? null, ancestorIds };
  }

  function scopeTier(parsed, cursor, position) {
    const current = itemAt(parsed, cursor);
    const source = itemAt(parsed, position);
    if (!current) return 0;
    if (source?.id === current.id) return 2;
    let parent = current.parentId;
    while (parent != null) {
      if (source?.id === parent) return 1;
      parent = parsed.items[parent - 1]?.parentId;
    }
    return 0;
  }

  function mathSegments(parsed, cursor) {
    const segments = [];
    for (const region of parsed.regions) {
      const boundaries = /\\\\(?:\[[^\]]*\])?|\r?\n/g;
      const content = parsed.clean.slice(region.start, region.end);
      let offset = 0, match;
      do {
        match = boundaries.exec(content);
        const start = region.start + offset, end = region.start + (match ? match.index : content.length);
        if (!(Number.isInteger(cursor) && start <= cursor && cursor <= end)) {
          // Split at prose arguments rather than teaching transitions across omitted prose.
          let partStart = start;
          for (const range of parsed.textRanges) {
            if (range.commandStart >= end || range.after <= start) continue;
            append(partStart, Math.min(end, range.commandStart));
            partStart = Math.max(partStart, range.after);
          }
          append(partStart, end);
        }
        offset = match ? boundaries.lastIndex : content.length;
      } while (match);
    }
    function append(start, end) {
      // Keep UTF-16 offsets unchanged for training cursor reconstruction.
      const text = parsed.clean.slice(start, end).replace(/\\&|&/g, (match) => match === '&' ? ' ' : match);
      if (end > start && text.trim()) segments.push({ text, start, end, itemId: itemAt(parsed, start)?.id ?? null });
    }
    return segments;
  }

  return { analyzeDocument, contextAt, itemAt, scopeTier, mathSegments, escaped, inComment };
});
