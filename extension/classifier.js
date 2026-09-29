(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AutoTexClassifier = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "autotex-context-v1";
  const LIMITS = Object.freeze({ prefix: 4096, segments: 128, segmentChars: 768, declarations: 48, characters: 24000, symbols: 128 });
  const SYMBOL_SOURCE = "(?:\\\\(?:mathbb|mathcal|mathfrak|mathrm|mathbf|mathit|mathsf|mathtt|boldsymbol|bm)(?![A-Za-z])\\s*(?:\\{\\s*(?:\\\\[A-Za-z]+|[A-Za-z])\\s*\\}|(?:\\\\[A-Za-z]+|[A-Za-z]))|\\{\\s*(?:\\\\[A-Za-z]+|[A-Za-z])\\s*\\}|(?:\\\\[A-Za-z]+|[A-Za-z]))";
  const SYMBOL = SYMBOL_SOURCE;
  const STYLED_SYMBOL = new RegExp("^\\\\(mathbb|mathcal|mathfrak|mathrm|mathbf|mathit|mathsf|mathtt|boldsymbol|bm)(?![A-Za-z])\\s*(?:\\{\\s*((?:\\\\[A-Za-z]+|[A-Za-z]))\\s*\\}|((?:\\\\[A-Za-z]+|[A-Za-z])))$");
  const GROUPED_SYMBOL = new RegExp("^\\{\\s*((?:\\\\[A-Za-z]+|[A-Za-z]))\\s*\\}$");
  const NUMBER_SETS = new Set(["\\mathbb{N}", "\\mathbb{Z}", "\\mathbb{Q}", "\\mathbb{R}", "\\mathbb{C}"]);
  const OPERATORS = new Set(["\\sum", "\\prod", "\\coprod", "\\bigcup", "\\bigcap", "\\lim", "\\limsup", "\\liminf", "\\int", "\\iint", "\\sup", "\\inf", "\\max", "\\min"]);
  const clamp = (value, low = -1, high = 1) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0));
  function canonicalSymbol(text) {
    if (typeof text !== "string") return "";
    text = text.trim();
    const styled = STYLED_SYMBOL.exec(text);
    if (styled) return "\\" + styled[1] + "{" + (styled[2] || styled[3]).replace(/\s+/g, "") + "}";
    const grouped = GROUPED_SYMBOL.exec(text);
    return (grouped ? grouped[1] : text).replace(/\s+/g, "");
  }
  const canonical = canonicalSymbol;
  const category = (type) => /^(?:group|ring|field|algebra|groupElement)$/.test(type) ? "algebra" : /^(?:integer|index)$/.test(type) ? "scalar" : /^(?:set|function|scalar)$/.test(type) ? type : "unknown";

  function escaped(text, at) {
    let n = 0;
    while (at > 0 && text[--at] === "\\") n++;
    return n % 2 === 1;
  }

  function visible(text, limit) {
    if (typeof text !== "string") return "";
    text = text.slice(-limit);
    return text.replace(/(^|[^\\])(?:\\\\)*%[^\r\n]*/g, (value) => " ".repeat(value.length));
  }

  function atoms(text) {
    return Array.from(text.matchAll(new RegExp(SYMBOL, "g")), (match) => canonical(match[0]));
  }

  function indexContext(prefix) {
    const text = visible(prefix, LIMITS.prefix);
    const stack = [];
    const pending = new Map();
    let trailing = null;
    function details(at, start, braced) {
      const before = text.slice(Math.max(0, at - 100), at).trimEnd();
      const matches = Array.from(before.matchAll(new RegExp(SYMBOL, "g")));
      const last = matches[matches.length - 1];
      const base = last && last.index + last[0].length === before.length ? canonical(last[0]) : "";
      const content = text.slice(start + (braced ? 1 : 0));
      const variableMatch = content.match(new RegExp("^\\s*(" + SYMBOL + ")(?=\\s*(?:[=<>+\\-]|\\\\(?:in|leq?|geq?)\\b|$))"));
      const bound = OPERATORS.has(base) || /(?:=|\\(?:in|leq?|geq?)\b)/.test(content);
      return { active: true, braced, base, content, variable: variableMatch ? canonical(variableMatch[1]) : null, bound,
        expected: bound ? "bound" : !braced ? "symbol" : /^\s*\d[\d\s+\-]*$/.test(content) ? "integer" : "expression" };
    }
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      if (character === "\\") {
        i++;
        if (/[A-Za-z]/.test(text[i] || "")) while (/[A-Za-z]/.test(text[i + 1] || "")) i++;
        continue;
      }
      if (character === "_") {
        let start = i + 1;
        while (start < text.length && /\s/.test(text[start])) start++;
        if (start === text.length || /^\\[A-Za-z]*$/.test(text.slice(start))) trailing = { at: i, start, braced: false };
        else if (text[start] === "{") pending.set(start, { at: i, start, braced: true });
      } else if (character === "{") stack.push(pending.get(i) || null);
      else if (character === "}") stack.pop();
    }
    if (trailing) return details(trailing.at, trailing.start, false);
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return details(stack[i].at, stack[i].start, true);
    return null;
  }

  function classifyExpression(text, symbols) {
    text = visible(text, 1024);
    symbols = symbols && typeof symbols === "object" ? symbols : Object.create(null);
    const index = indexContext(text);
    if (index) return { kind: "index", confidence: 0.98, labels: ["index"], index };
    const scores = { set: 0, algebra: 0, function: 0, scalar: 0 };
    if (/\\(?:mathbb\s*\{\s*[NZQRC]\s*\}|in\b|notin\b|subset(?:eq|neq)?\b|supset(?:eq)?\b|cup\b|cap\b|setminus\b|emptyset\b|varnothing\b)|\\\{/.test(text)) scores.set = 0.9;
    if (/\\(?:oplus|otimes|cong|trianglelefteq|unlhd|lhd)\b|\\operatorname\s*\{(?:Hom|Aut|End|Gal)\}/.test(text)) scores.algebra = 0.72;
    if (/\\(?:mapsto|circ)\b|(?:[A-Za-z]|\\[A-Za-z]+)\s*:\s*[^:]{0,100}\\(?:to|rightarrow)\b/.test(text)) scores.function = 0.9;
    if (/(?:[A-Za-z]|\\[A-Za-z]+)\s*\(/.test(text)) scores.function = Math.max(scores.function, 0.58);
    if (/(?:^|[^A-Za-z])\d+(?:$|[^A-Za-z])|\\(?:frac|sqrt|sin|cos|log|exp)\b/.test(text)) scores.scalar = 0.48;
    if (/[+*=]/.test(text)) scores.scalar = Math.max(scores.scalar, 0.24);
    for (const symbol of atoms(text)) {
      if (NUMBER_SETS.has(symbol)) scores.set = Math.max(scores.set, 0.95);
      const evidence = symbols[symbol];
      const kind = category(evidence?.type);
      if (kind !== "unknown") scores[kind] = Math.max(scores[kind], clamp(evidence.confidence, 0, 1) * 0.92);
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const labels = ranked.filter((entry) => entry[1] >= 0.35).map((entry) => entry[0]);
    if (!ranked[0][1] || ranked[0][1] < 0.3) return { kind: "unknown", confidence: 0, labels, index: null };
    return { kind: ranked[0][0], confidence: ranked[0][1], labels, index: null };
  }

  function analyze(context = {}) {
    const prefix = visible(context.prefix, LIMITS.prefix);
    const symbols = Object.create(null);
    const records = [];
    const ancestors = new Set(Array.isArray(context.ancestorIds) ? context.ancestorIds.slice(0, 64) : []);
    const cursor = Number.isFinite(context.cursor) ? context.cursor : Infinity;
    let scannedCharacters = prefix.length;
    let symbolCount = 0;
    let truncated = typeof context.prefix === "string" && context.prefix.length > LIMITS.prefix;
    const tierOf = (record) => Number.isFinite(record.itemTier) ? clamp(record.itemTier, 0, 2) : context.itemId != null && record.itemId === context.itemId ? 2 : record.itemId != null && ancestors.has(record.itemId) ? 1 : 0;
    function add(text, itemTier, order, source) {
      if (scannedCharacters >= LIMITS.characters) { truncated = true; return; }
      const available = Math.min(source === "declaration" ? LIMITS.prefix : LIMITS.segmentChars, LIMITS.characters - scannedCharacters);
      const value = visible(text, available);
      scannedCharacters += value.length;
      if (value) records.push({ text: value, itemTier, order, source });
    }
    const declarations = Array.isArray(context.declarations) ? context.declarations.slice(0, LIMITS.declarations).sort((a, b) => tierOf(b || {}) - tierOf(a || {})) : [];
    for (let i = 0; i < Math.min(declarations.length, LIMITS.declarations); i++) {
      const record = declarations[i];
      if (!record || typeof record.text !== "string" || Number.isFinite(record.start) && record.start >= cursor) continue;
      let text = record.text;
      if (Number.isFinite(record.start) && Number.isFinite(record.end) && record.end > cursor) text = text.slice(0, Math.max(0, cursor - record.start));
      add(text, tierOf(record), Number.isFinite(record.start) ? record.start : i, "declaration");
    }
    if (Array.isArray(context.declarations) && context.declarations.length > LIMITS.declarations) truncated = true;
    const segments = Array.isArray(context.segments) ? context.segments.slice(0, LIMITS.segments).sort((a, b) => tierOf(b || {}) - tierOf(a || {})) : [];
    for (let i = 0; i < Math.min(segments.length, LIMITS.segments); i++) {
      const record = segments[i];
      if (!record || typeof record.text !== "string" || Number.isFinite(record.start) && record.start >= cursor) continue;
      let text = record.text;
      if (Number.isFinite(record.start) && Number.isFinite(record.end) && record.end > cursor) text = text.slice(0, Math.max(0, cursor - record.start));
      add(text, tierOf(record), Number.isFinite(record.start) ? record.start : i, "math");
    }
    if (Array.isArray(context.segments) && context.segments.length > LIMITS.segments) truncated = true;
    records.push({ text: prefix, itemTier: context.itemId == null ? 0 : 2, order: cursor, source: "prefix" });
    records.sort((a, b) => a.itemTier - b.itemTier || a.order - b.order);

    function remember(symbol, type, confidence, record, explicit = false) {
      symbol = canonical(symbol);
      if (!symbol || symbol.length > 80) return;
      if (NUMBER_SETS.has(symbol)) { type = "set"; confidence = 1; }
      const previous = symbols[symbol];
      if (!previous && symbolCount >= LIMITS.symbols) { truncated = true; return; }
      const next = { type, confidence, itemTier: record.itemTier, explicit, order: record.order };
      if (!previous) { symbols[symbol] = next; symbolCount++; return; }
      if (next.itemTier < previous.itemTier) return;
      if (next.itemTier > previous.itemTier) { symbols[symbol] = next; return; }
      if (previous.explicit && !explicit) return;
      if (explicit && !previous.explicit || explicit && record.order >= previous.order) { symbols[symbol] = next; return; }
      if (previous.type === type || previous.type === "unknown") {
        if (confidence >= previous.confidence) symbols[symbol] = next;
      } else if (Math.abs(previous.confidence - confidence) < 0.12 && category(previous.type) !== category(type)) {
        symbols[symbol] = { ...next, type: "unknown", confidence: 0.25, ambiguous: true };
      } else if (confidence > previous.confidence) symbols[symbol] = next;
    }

    for (const record of records) {
      for (const symbol of atoms(record.text)) if (NUMBER_SETS.has(symbol)) remember(symbol, "set", 1, record);
      const prose = record.text.replace(/\$/g, " ").replace(/\\[()[\]]/g, " ").replace(/\\text(?:rm)?\s*\{([^{}]*)\}/g, "$1");
      const declaration = new RegExp("(?<![A-Za-z\\\\])(" + SYMBOL + ")\\s+(?:be|is|denotes?|are)\\s+(?:(?:a|an|the|abelian|finite|infinite|commutative|nonzero)\\s+)*(group|ring|field|algebra|set|function|map|scalar|integer|real(?: number)?|complex(?: number)?)\\b", "gi");
      for (const match of prose.matchAll(declaration)) {
        const word = match[2].toLowerCase();
        remember(match[1], /^(?:real|complex|scalar)/.test(word) ? "scalar" : word === "map" ? "function" : word, 0.97, record, true);
      }
      const setDefinition = new RegExp("(" + SYMBOL + ")\\s*(?::=|=|\\\\coloneqq)\\s*\\\\(?:left\\s*)?\\\\?\\{", "g");
      for (const match of record.text.matchAll(setDefinition)) remember(match[1], "set", 0.96, record, true);
      const functionDefinition = new RegExp("(" + SYMBOL + ")\\s*:\\s*(" + SYMBOL + ")\\s*\\\\(?:to|rightarrow)\\b\\s*(" + SYMBOL + ")", "g");
      for (const match of record.text.matchAll(functionDefinition)) {
        remember(match[1], "function", 0.97, record, true);
        remember(match[2], "set", 0.75, record);
        remember(match[3], "set", 0.75, record);
      }
      const subset = new RegExp("(" + SYMBOL + ")\\s*\\\\(?:subset(?:eq|neq)?|supset(?:eq)?)\\b\\s*(" + SYMBOL + ")", "g");
      for (const match of record.text.matchAll(subset)) {
        remember(match[1], "set", 0.88, record);
        remember(match[2], "set", 0.88, record);
      }
    }
    for (const record of records) {
      const membership = new RegExp("(" + SYMBOL + ")(?:_\\s*(?:\\{[^{}]{0,40}\\}|[A-Za-z0-9]))?\\s*\\\\(?:in|notin)\\b\\s*(" + SYMBOL + ")", "g");
      for (const match of record.text.matchAll(membership)) {
        const member = canonical(match[1]);
        const container = canonical(match[2]);
        const evidence = symbols[container];
        if (NUMBER_SETS.has(container)) remember(member, /[NZ]\}$/.test(container) ? "integer" : "scalar", 0.94, record);
        else if (evidence && /^(?:group|ring|field|algebra)$/.test(evidence.type)) remember(member, "groupElement", 0.8, record);
        remember(container, "set", 0.72, record);
      }
      const indexed = new RegExp("(" + SYMBOL + ")_\\s*(?:\\{\\s*(" + SYMBOL + ")(?:\\s*[+\\-]\\s*\\d+)?\\s*\\}|([A-Za-z]))", "g");
      for (const match of record.text.matchAll(indexed)) remember(match[2] || match[3], "index", 0.55, record);
    }
    const result = classifyExpression(prefix, symbols);
    return { ...result, symbols, diagnostics: { scannedCharacters, segmentCount: records.length - 1, truncated } };
  }

  function candidateFeatures(candidate, context = {}) {
    const classification = context.classification || analyze(context);
    const prefix = visible(context.prefix, 1024);
    const suffix = typeof candidate === "string" ? candidate : candidate?.fullText ?? candidate?.insertText ?? "";
    const text = typeof suffix === "string" ? suffix.slice(0, 600) : "";
    const proposed = classifyExpression(text, classification.symbols);
    let categoryMatch = 0;
    if (classification.kind !== "unknown" && classification.kind !== "index" && proposed.kind !== "unknown" && proposed.kind !== "index") {
      categoryMatch = classification.kind === proposed.kind ? classification.confidence * proposed.confidence : (classification.labels || []).includes(proposed.kind) ? 0.2 : -0.25 * classification.confidence * proposed.confidence;
    }
    let indexFit = 0;
    if (classification.index?.active) {
      let fragment = text;
      if (classification.index.braced) {
        let depth = 1;
        const existing = classification.index.content || "";
        for (let i = 0; i < existing.length; i++) if (!escaped(existing, i)) depth += existing[i] === "{" ? 1 : existing[i] === "}" ? -1 : 0;
        for (let i = 0; i < text.length; i++) {
          if (!escaped(text, i)) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
          if (!depth) { fragment = text.slice(0, i + 1); break; }
        }
      }
      indexFit = fragment.trim() ? 0.75 : 0;
      if (/(?:^|[^\\])_\s*_/.test((classification.index.content || "") + fragment)) indexFit = -1;
      else if (/[\r\n$]/.test(fragment) || /\\(?:begin|end|section|item)\b/.test(fragment)) indexFit = -0.6;
      else if (/\\(?:cup|cap|oplus|otimes|subset(?:eq)?)\b/.test(fragment)) indexFit = classification.index.bound ? -0.15 : -0.35;
      else if (/[=<>]|\\(?:in|leq?|geq?)\b/.test(fragment)) indexFit = classification.index.bound ? 0.9 : 0.25;
      else if (/^[\s{}A-Za-z0-9,+\-=]*$/.test(fragment)) indexFit = 0.95;
    }
    let expected = null;
    if (/\\(?:in|notin|subset(?:eq|neq)?|supset(?:eq)?)\s*$/.test(prefix)) expected = "set";
    else if (/\\circ\s*$/.test(prefix)) expected = "function";
    else if (classification.index?.active && /(?:=|[+\-])\s*$/.test(classification.index.content || "")) expected = "scalar";
    else if (classification.kind !== "unknown" && classification.kind !== "index") expected = classification.kind;
    let symbolTypeMatch = 0;
    const mentioned = atoms(text).map((symbol) => NUMBER_SETS.has(symbol) ? { type: "set", confidence: 1 } : classification.symbols?.[symbol]).filter((evidence) => evidence && category(evidence.type) !== "unknown");
    if (expected && mentioned.length) {
      symbolTypeMatch = mentioned.reduce((total, evidence) => {
        const type = category(evidence.type);
        const compatible = type === expected || expected === "set" && type === "algebra";
        return total + (compatible ? 0.8 : -0.35) * evidence.confidence;
      }, 0) / mentioned.length;
    }
    return { categoryMatch: clamp(categoryMatch), indexFit: clamp(indexFit), symbolTypeMatch: clamp(symbolTypeMatch) };
  }

  function tokenWeight(token, historyText, classification) {
    if (typeof token !== "string" || !classification) return 1;
    const prefix = typeof historyText === "string" ? historyText.slice(-1024) : "";
    let current = classification;
    if (classification.index?.active && prefix.includes("_") && !indexContext(prefix)) current = { ...classifyExpression(prefix, classification.symbols), symbols: classification.symbols };
    const features = candidateFeatures({ insertText: token }, { prefix, classification: current });
    return clamp(1 + 0.18 * features.categoryMatch + 0.18 * features.indexFit + 0.12 * features.symbolTypeMatch, 0.65, 1.35);
  }

  return Object.freeze({ VERSION, LIMITS, SYMBOL_SOURCE, canonicalSymbol, analyze, classifyExpression, candidateFeatures, tokenWeight });
});
