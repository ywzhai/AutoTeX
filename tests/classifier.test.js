"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const C = require("../extension/classifier.js");

function context(prefix, segments = [], extra = {}) {
  return { prefix, itemId: "current", ancestorIds: ["parent"], segments: segments.map((value, i) => typeof value === "string" ? { text: value, itemId: "current", start: i * 100, end: i * 100 + value.length } : value), cursor: 10000, ...extra };
}

test("browser UMD and CommonJS expose the versioned classifier", () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(require.resolve("../extension/classifier.js"), "utf8"), sandbox);
  assert.equal(sandbox.AutoTexClassifier.VERSION, "autotex-context-v1");
  assert.equal(C.VERSION, sandbox.AutoTexClassifier.VERSION);
});

test("plain letters and unknown commands have no assumed mathematical type", () => {
  for (const prefix of ["R", "N", "G", "A", "x", "\\mygroup", "\\mathbb{X}"]) {
    const result = C.analyze(context(prefix));
    assert.equal(result.kind, "unknown", prefix);
    assert.equal(result.symbols[prefix], undefined);
  }
  assert.equal(C.analyze(context("g", [], { declarations: [{ text: "Something is a group" }] })).kind, "unknown");
});

test("number systems require explicit blackboard-bold notation", () => {
  for (const letter of ["N", "Z", "Q", "R", "C"]) {
    const symbol = `\\mathbb{${letter}}`;
    const result = C.analyze(context(symbol));
    assert.equal(result.kind, "set");
    assert.equal(result.symbols[symbol].type, "set");
  }
  const result = C.analyze(context("x", ["x \\in \\mathbb{R}"]));
  assert.equal(result.symbols.x.type, "scalar");
  assert.equal(C.analyze(context("n", ["n \\in \\mathbb{N}"])).symbols.n.type, "integer");
});

test("set definitions, subsets, and function signatures infer symbols", () => {
  const result = C.analyze(context("f", ["A=\\{1,2\\}", "B \\subseteq A", "f:A \\to B"]));
  assert.equal(result.symbols.A.type, "set");
  assert.equal(result.symbols.B.type, "set");
  assert.equal(result.symbols.f.type, "function");
  assert.equal(result.kind, "function");
  assert.equal(C.analyze(context("A", ["A = \\left\\{1,2\\right\\}"])).symbols.A.type, "set");
});

test("command substrings cannot masquerade as membership or arrows", () => {
  const result = C.analyze(context("G", ["x \\inG", "f:A \\toB", "A \\subseteqG"]));
  assert.equal(result.symbols.G, undefined);
  assert.equal(result.symbols.f, undefined);
});

test("scoped natural-language declarations override distant and sibling meanings", () => {
  const result = C.analyze(context("G", [{ text: "G \\in \\mathbb{R}", itemId: "sibling" }], {
    declarations: [
      { text: "Let $G$ be a set", itemTier: 0 },
      { text: "Let $G$ be a ring", itemTier: 1 },
      { text: "Let $G$ be a group", itemTier: 2 },
    ],
  }));
  assert.equal(result.symbols.G.type, "group");
  assert.equal(result.symbols.G.itemTier, 2);
  assert.equal(result.kind, "algebra");
  const reversed = C.analyze(context("G", ["G \\in \\mathbb{R}"], { declarations: [{ text: "G is a group", itemTier: 0 }] }));
  assert.equal(reversed.symbols.G.type, "scalar");
});

test("membership inherits declared algebraic structure without guessing uppercase names", () => {
  const result = C.analyze(context("g", ["g \\in G"], { declarations: [{ text: "Let $G$ be an abelian group", itemTier: 2 }] }));
  assert.equal(result.symbols.G.type, "group");
  assert.equal(result.symbols.g.type, "groupElement");
  assert.equal(result.kind, "algebra");
  assert.equal(C.analyze(context("g", ["g \\in G"])).symbols.g, undefined);
});

test("conflicting equal-scope indirect evidence remains uncertain", () => {
  const result = C.analyze(context("G", ["G \\subseteq A", "G \\in \\mathbb{R}"]));
  assert.equal(result.symbols.G.type, "unknown");
  assert.equal(result.symbols.G.ambiguous, true);
  assert.equal(result.kind, "unknown");
});

test("future segments and declarations do not leak into classification", () => {
  const result = C.analyze(context("G", [
    { text: "G \\in \\mathbb{R}", start: 200, end: 220, itemId: "current" },
    { text: "G is a group", start: 99, end: 111, itemId: "current" },
  ], { cursor: 100, declarations: [{ text: "G is a set", start: 110, end: 121, itemTier: 2 }] }));
  assert.equal(result.kind, "unknown");
  assert.equal(result.symbols.G, undefined);
});

test("observed subscript variables add only weak index evidence", () => {
  const result = C.analyze(context("i", ["x_i+y_{i+1}"]));
  assert.equal(result.symbols.i.type, "index");
  assert.ok(result.symbols.i.confidence < 0.7);
  assert.equal(result.symbols.x, undefined);
});

test("index detection handles whitespace, symbols, and open braced indices", () => {
  for (const prefix of ["x_", "x_  ", "x_{", "x_ { i + ", "\\alpha_{i+", "\\mathbf{x}_{j"]) {
    const result = C.analyze(context(prefix));
    assert.equal(result.kind, "index", prefix);
    assert.equal(result.index.active, true);
  }
  const result = C.analyze(context("\\alpha_{ i + "));
  assert.equal(result.index.base, "\\alpha");
  assert.equal(result.index.content, " i + ");
  assert.equal(result.index.variable, "i");
});

test("completed subscripts and escaped underscores leave index context", () => {
  for (const prefix of ["x_i", "x_1", "x_\\alpha ", "x_{i}", "x_{i} ", "x_{i}+y", "x\\_", "x\\_{i", "x_{i_{j}}", "x_{i\\}j}"]) {
    const result = C.analyze(context(prefix));
    assert.notEqual(result.kind, "index", prefix);
    assert.equal(result.index, null, prefix);
  }
  assert.equal(C.analyze(context("x\\\\_{i")).kind, "index");
});

test("nested scripts choose the innermost open subscript and restore outer context", () => {
  assert.equal(C.analyze(context("x_{a_{j")).index.base, "a");
  const result = C.analyze(context("x_{a_{j}+1"));
  assert.equal(result.index.base, "x");
  assert.equal(result.index.content, "a_{j}+1");
});

test("sum and membership limits recognize bound syntax without requiring equals", () => {
  for (const prefix of ["\\sum_{", "\\sum_{i=", "\\prod_{j \\in I", "\\lim_{n \\to"]) {
    const index = C.analyze(context(prefix)).index;
    assert.equal(index.bound, true, prefix);
    assert.equal(index.expected, "bound", prefix);
  }
  assert.equal(C.analyze(context("x_{12")).index.expected, "integer");
});

test("comments do not create declarations or active indices", () => {
  assert.equal(C.analyze(context("x % G is a group x_{")).kind, "unknown");
  const result = C.analyze(context("G", ["% G is a group"]));
  assert.equal(result.symbols.G, undefined);
  assert.equal(C.analyze(context("x\\%+y_{")).kind, "index");
});

test("set features prefer observed sets while retaining finite scores for crossovers", () => {
  const ctx = context("A \\cap ", ["A \\subseteq \\mathbb{R}", "B \\subseteq \\mathbb{R}", "x \\in \\mathbb{R}"]);
  ctx.classification = C.analyze(ctx);
  const good = C.candidateFeatures({ insertText: "B" }, ctx);
  const other = C.candidateFeatures({ insertText: "x" }, ctx);
  assert.ok(good.categoryMatch > other.categoryMatch);
  assert.ok(good.symbolTypeMatch > other.symbolTypeMatch);
  assert.ok(C.tokenWeight("x", ctx.prefix, ctx.classification) > 0);
});

test("index features respect the closing brace and discriminate index continuations", () => {
  const ctx = context("a_{i+");
  ctx.classification = C.analyze(ctx);
  const good = C.candidateFeatures({ fullText: "1}+A \\cup B" }, ctx);
  const poor = C.candidateFeatures({ fullText: "\\cup B}" }, ctx);
  assert.ok(good.indexFit > poor.indexFit);
  assert.ok(good.indexFit > 0);
  assert.notEqual(C.candidateFeatures({ fullText: "1}\nA" }, ctx).indexFit, -1);
  assert.notEqual(C.candidateFeatures({ fullText: "\\begin{smallmatrix}i\\end{smallmatrix}}" }, ctx).indexFit, -1);
  assert.equal(C.candidateFeatures({ fullText: "j__k}" }, ctx).indexFit, -1);
});

test("token weights stop applying index preferences after its closing brace", () => {
  const classification = C.analyze(context("a_{i+"));
  const after = C.tokenWeight("\\cup", "a_{i+1}", classification);
  const fresh = C.tokenWeight("\\cup", "a_{i+1}", { ...C.classifyExpression("a_{i+1}", classification.symbols), symbols: classification.symbols });
  assert.equal(after, fresh);
});

test("all features and weights remain bounded for uncertain or malformed inputs", () => {
  for (const prefix of ["G", "x_{", "A \\cap ", "\\sum_{i="]) {
    const ctx = context(prefix);
    ctx.classification = C.analyze(ctx);
    for (const suffix of ["R", "\\cup", "}", "\\frac{1}{2}", "__", "\n", "\\customThing"]) {
      for (const value of Object.values(C.candidateFeatures({ insertText: suffix }, ctx))) assert.ok(Number.isFinite(value) && value >= -1 && value <= 1);
      const weight = C.tokenWeight(suffix, prefix, ctx.classification);
      assert.ok(weight >= 0.65 && weight <= 1.35);
    }
  }
  assert.equal(C.tokenWeight(null, "", null), 1);
});

test("analysis is bounded on huge documents and does not mutate caller records", () => {
  const segment = Object.freeze({ text: "a".repeat(20000), itemId: "other", start: 0, end: 20000 });
  const segments = Object.freeze(new Array(100000).fill(segment));
  const declaration = Object.freeze({ text: "Let $G$ be a group", itemTier: 2 });
  const result = C.analyze(context("G", segments, { declarations: [declaration] }));
  assert.equal(result.kind, "algebra");
  assert.ok(result.diagnostics.scannedCharacters <= C.LIMITS.characters);
  assert.ok(result.diagnostics.segmentCount <= C.LIMITS.segments + C.LIMITS.declarations);
  assert.equal(result.diagnostics.truncated, true);
  assert.equal(segments[0], segment);
});

test("adversarial nested scripts have bounded parsing cost", () => {
  const prefix = "x_{".repeat(1400);
  const started = performance.now();
  for (let i = 0; i < 30; i++) assert.equal(C.analyze(context(prefix)).kind, "index");
  assert.ok(performance.now() - started < 1500, "bounded 4K parsing should not repeatedly rescan every nested subscript");
});


test("unfinished unbraced control words remain indices until a lexical delimiter", () => {
  for (const prefix of ["x_\\", "x_\\al", "x_\\alpha"]) {
    const result = C.analyze(context(prefix));
    assert.equal(result.kind, "index", prefix);
    assert.equal(result.index.braced, false);
    assert.equal(result.index.base, "x");
  }
  for (const prefix of ["x_\\alpha ", "x_\\alpha+", "x_\\alpha}"]) assert.equal(C.analyze(context(prefix)).index, null, prefix);
});

test("unbraced style commands infer known number sets without splitting unknown macros", () => {
  assert.equal(C.analyze(context("\\mathbb R")).kind, "set");
  assert.equal(C.analyze(context("x", ["x \\in \\mathbb R"])).symbols.x.type, "scalar");
  assert.equal(C.analyze(context("\\mathbbR")).kind, "unknown");
  assert.equal(C.analyze(context("R")).kind, "unknown");
});


test("scoped declaration windows preserve evidence near the beginning of a long item", () => {
  const result = C.analyze(context("G", [], { declarations: [{ text: "Let $G$ be a group. " + "Further discussion. ".repeat(150), itemTier: 2 }] }));
  assert.equal(result.symbols.G.type, "group");
  assert.equal(result.kind, "algebra");
  assert.ok(result.diagnostics.scannedCharacters <= C.LIMITS.characters);
});


test("shared atom parser normalizes every existing styled base without erasing style", () => {
  const pattern = new RegExp("^(" + C.SYMBOL_SOURCE + ")_(\\d+)$");
  for (const style of ["mathbb", "mathcal", "mathfrak", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "boldsymbol", "bm"]) {
    for (const atom of ["x", "\\alpha"]) {
      const canonical = "\\" + style + "{" + atom + "}";
      for (const value of [canonical, "\\" + style + " " + atom, "\\" + style + "{ " + atom + " }"]) {
        assert.equal(C.canonicalSymbol(value), canonical, value);
        assert.equal(C.canonicalSymbol(C.canonicalSymbol(value)), canonical, value);
        assert.equal(C.analyze(context(value + "_{")).index.base, canonical, value);
        const match = pattern.exec(value + "_2");
        assert.ok(match, value);
        assert.equal(match.length, 3, "SYMBOL_SOURCE must not change caller capture groups");
        assert.equal(match[2], "2");
      }
    }
  }
  assert.notEqual(C.canonicalSymbol("R"), C.canonicalSymbol("\\mathbb R"));
  assert.notEqual(C.canonicalSymbol("\\mathbf x"), C.canonicalSymbol("\\mathit x"));
});

test("shared atom parser handles braced plain atoms and preserves control-word boundaries", () => {
  for (const value of ["x", "{x}", "{ x }"]) {
    assert.equal(C.canonicalSymbol(value), "x");
    assert.equal(C.analyze(context(value + "_{")).index.base, "x");
  }
  for (const value of ["\\alpha", "{\\alpha}"]) {
    assert.equal(C.canonicalSymbol(value), "\\alpha");
    assert.equal(C.analyze(context(value + "_{")).index.base, "\\alpha");
  }
  assert.equal(C.canonicalSymbol("\\mathbf\\alpha"), "\\mathbf{\\alpha}");
  assert.equal(C.canonicalSymbol("\\mathbbR"), "\\mathbbR");
  assert.equal(C.analyze(context("\\mathbbR_{")).index.base, "\\mathbbR");
  assert.equal(C.canonicalSymbol(null), "");
});
