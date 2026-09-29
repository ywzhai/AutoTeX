"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TOKENIZER_VERSION, SCHEMA_VERSION, CLASSIFIER_VERSION, FEATURE_NAMES, END_TOKEN, tokenize, buildNgrams,
  validateArtifact, createUntrainedArtifact, createPredictor, validateCandidate, featureValues,
} = require("../extension/predictor.js");

function segments(values, itemId = "current") {
  return values.map((text, index) => ({ text, itemId, start: index * 100, end: index * 100 + text.length }));
}

function trainedArtifact(weights = {}) {
  return {
    ...createUntrainedArtifact(),
    trained: true,
    ranker: {
      features: [...FEATURE_NAMES],
      weights: FEATURE_NAMES.map((name) => weights[name] || 0),
      bias: 0,
      means: FEATURE_NAMES.map(() => 0),
      scales: FEATURE_NAMES.map(() => 1),
    },
  };
}

test("tokenizer preserves exact source offsets and LaTeX command boundaries", () => {
  const text = "\\alpha  x_{12}+\\% \r\n\\sin x+\\sinx";
  const tokens = tokenize(text);
  assert.deepEqual(tokens.map((token) => token.value), [
    "\\alpha", " ", "x", "_", "{", "12", "}", "+", "\\%", " ", "\n", "\\sin", " ", "x", "+", "\\sinx",
  ]);
  assert.equal(tokens.map((token) => text.slice(token.start, token.end)).join(""), text);
  assert.deepEqual(tokens[1], { value: " ", start: 6, end: 8 });
  assert.notDeepEqual(tokenize("\\sin x").map((token) => token.value), tokenize("\\sinx").map((token) => token.value));
});

test("tokenizer distinguishes escaped braces and handles Unicode offsets", () => {
  const text = "\\{𝑥\\}\\theta\tz";
  const tokens = tokenize(text);
  assert.deepEqual(tokens.map((token) => token.value), ["\\{", "𝑥", "\\}", "\\theta", " ", "z"]);
  assert.equal(tokens[1].end - tokens[1].start, 2);
  assert.equal(tokens.map((token) => text.slice(token.start, token.end)).join(""), text);
  assert.deepEqual(tokenize(null), []);
});

test("ngram counts are serializable with explicit segment boundaries", () => {
  const model = buildNgrams(["x+y", "x+z"], { order: 5 });
  assert.equal(model.order, 5);
  assert.equal(model.smoothing, 3);
  assert.deepEqual(model.contexts.find((entry) => entry.context.join("") === "x+").next, [["y", 1], ["z", 1]]);
  assert.ok(model.contexts.some((entry) => entry.next.some(([token]) => token === END_TOKEN)));
  assert.equal(model.contexts.some((entry) => entry.context.includes(END_TOKEN)), false);
  assert.ok(validateArtifact(createUntrainedArtifact(JSON.parse(JSON.stringify(model)))));
});

test("pruning preserves original totals and obeys explicit resource limits", () => {
  const model = buildNgrams(["x+a", "x+b", "x+c", "x+d", "x+e"], {
    maxContexts: 4, maxSuccessors: 2, maxTokens: 12,
  });
  assert.ok(model.contexts.length <= 4);
  assert.ok(model.contexts.every((entry) => entry.next.length <= 2));
  assert.ok(model.contexts.every((entry) => entry.total >= entry.next.reduce((sum, pair) => sum + pair[1], 0)));
  assert.ok(validateArtifact(createUntrainedArtifact(model)));
  const filtered = buildNgrams(["x+y", "x+y", "a+b"], { minCount: 2 });
  assert.ok(filtered.contexts.every((entry) => entry.context.length === 0 || entry.total >= 2));
});

test("offline ngram token budgets can exceed the browser default without silently dropping later segments", () => {
  const input = Array.from({ length: 17000 }, () => "x+x");
  input.push("\\rare+z");
  const model = buildNgrams(input, { maxTokens: 60000, maxContexts: 100 });
  assert.ok(model.contexts.some((entry) => entry.next.some(([token]) => token === "\\rare")));
});

test("default untrained predictor uses document evidence without a packaged corpus", () => {
  const predictor = createPredictor();
  assert.equal(predictor.valid, true);
  assert.equal(predictor.trained, false);
  const candidates = predictor.candidates({
    prefix: "x_i+", itemId: "current", segments: segments(["x_i+y_i"]),
  });
  assert.equal(candidates[0].insertText, "y_i");
  assert.equal(candidates[0].kind, "prediction");
  assert.equal(candidates[0].itemTier, 2);
  assert.equal(candidates[0].features.sameItem, 1);
  assert.ok(candidates.every((candidate) => Number.isFinite(candidate.score)));
  assert.ok(candidates.every((candidate) => FEATURE_NAMES.every((name) => Number.isFinite(candidate.features[name]))));
});

test("empty shipped model with ngrams:null still enables local adaptation", () => {
  const artifact = { schemaVersion: 1, trained: false, tokenizerVersion: TOKENIZER_VERSION, ngrams: null, ranker: null };
  assert.ok(validateArtifact(artifact));
  assert.ok(createPredictor(artifact).candidates({
    prefix: "x+", segments: segments(["x+y"]), itemId: "current",
  }).some((candidate) => candidate.insertText === "y"));
});

test("same-item evidence beats much more frequent formulas in other items", () => {
  const document = [
    ...segments(["x_i+y_i"], "here"),
    ...segments(Array(40).fill("x_i+z_i"), "elsewhere"),
  ];
  const candidates = createPredictor().candidates({ prefix: "x_i+", itemId: "here", segments: document });
  assert.equal(candidates[0].insertText, "y_i");
  assert.equal(candidates[0].itemTier, 2);
});

test("ancestor evidence is preferred when the current item has no matching examples", () => {
  const document = [
    ...segments(["x_i+y_i"], "parent"),
    ...segments(Array(20).fill("x_i+z_i"), "other"),
  ];
  const candidates = createPredictor().candidates({
    prefix: "x_i+", itemId: "child", ancestorIds: ["parent"], segments: document,
  });
  assert.equal(candidates[0].insertText, "y_i");
  assert.equal(candidates[0].itemTier, 1);
  assert.equal(candidates[0].features.parentItem, 1);
});

test("packaged ngrams can generate short continuations absent from the active document", () => {
  const artifact = createUntrainedArtifact(buildNgrams(["a_i+b_i", "x_i+b_i"]));
  const candidates = createPredictor(artifact).candidates({ prefix: "q_i+", segments: [] });
  assert.ok(candidates.some((candidate) => candidate.insertText === "b_i"));
  assert.ok(candidates.every((candidate) => candidate.itemTier === 0));
});

test("partial control words finish without inserting a space inside the command", () => {
  const candidates = createPredictor().candidates({
    prefix: "\\fra", itemId: "current", segments: segments(["\\frac{a}{b}"]),
  });
  assert.equal(candidates[0].insertText, "c{a}{b}");
  assert.equal("\\fra" + candidates[0].insertText, "\\frac{a}{b}");
});

test("rendering preserves required spaces after control words and avoids duplicate typed whitespace", () => {
  const predictor = createPredictor();
  const document = segments(["\\sin x+1"]);
  assert.equal(predictor.candidates({ prefix: "\\sin", itemId: "current", segments: document })[0].insertText, " x+1");
  const afterSpace = predictor.candidates({ prefix: "\\sin  ", itemId: "current", segments: document });
  assert.equal(afterSpace[0].insertText, "x+1");
  assert.equal("\\sin  " + afterSpace[0].insertText, "\\sin  x+1");
});

test("right-hand closing braces are borrowed without duplicating document text", () => {
  const candidates = createPredictor().candidates({
    prefix: "\\fra", right: "}", itemId: "current", segments: segments(["\\frac{a}{b}"]),
  });
  const complete = candidates.find((candidate) => candidate.fullText === "c{a}{b}");
  assert.ok(complete);
  assert.equal(complete.insertText, "c{a}{b");
  assert.equal("\\fra" + complete.insertText + "}", "\\frac{a}{b}");
});

test("unknown corpus macros are not invented but document-defined usage can be reused", () => {
  const artifact = createUntrainedArtifact(buildNgrams(["x_i+\\mystery{z}"]));
  const predictor = createPredictor(artifact);
  assert.ok(predictor.candidates({ prefix: "x_i+", segments: [] }).every((candidate) => !candidate.fullText.includes("\\mystery")));
  assert.ok(predictor.candidates({
    prefix: "x_i+", segments: segments(["x_i+\\mystery{z}"]), itemId: "current",
  }).some((candidate) => candidate.fullText.includes("\\mystery")));
});

test("candidate validation rejects math delimiters comments unbalanced groups and incomplete arguments", () => {
  for (const suffix of ["$", "\\(", "\\)", "\\[", "\\]", "% comment", "{x", "}x", "\\frac{a}", "+", "_", "^", "\\input{x}"]) {
    assert.equal(validateCandidate({ fullText: suffix }, { prefix: "x+" }), false, suffix);
  }
  assert.equal(validateCandidate({ fullText: "(" }, { prefix: "\\" }), false);
  assert.equal(validateCandidate({ fullText: "c{a}{b}" }, { prefix: "\\fra" }), true);
  assert.equal(validateCandidate({ fullText: "\\alpha" }, { prefix: "x+" }), true);
});

test("the generator never emits a math mode delimiter from malformed corpus content", () => {
  const artifact = createUntrainedArtifact(buildNgrams(["x+$", "x+\\[y\\]", "x+\\(y\\)", "x+z"]));
  const candidates = createPredictor(artifact).candidates({ prefix: "x+" });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => !/\$|\\[()[\]]/.test(candidate.fullText)));
});

test("generation is bounded and does not produce an unsolicited continuation with no context", () => {
  const predictor = createPredictor();
  const document = segments(["x_i+y_i+z_i+x_i+y_i+z_i"]);
  const candidates = predictor.candidates({
    prefix: "x_i+", itemId: "current", segments: document, maxCandidates: 2, maxTokens: 3,
  });
  assert.ok(candidates.length <= 2);
  assert.ok(candidates.every((candidate) => tokenize(candidate.fullText).length <= 3));
  assert.deepEqual(predictor.candidates({ prefix: "", segments: document }), []);
  assert.deepEqual(predictor.candidates({ prefix: "q", segments: [] }), []);
});

test("replacing document segments removes old local evidence instead of accumulating it", () => {
  const predictor = createPredictor();
  assert.equal(predictor.candidates({ prefix: "x+", itemId: "current", segments: segments(["x+y"]) })[0].insertText, "y");
  assert.equal(predictor.candidates({ prefix: "x+", itemId: "current", segments: segments(["x+z"]) })[0].insertText, "z");
  predictor.reset();
  assert.deepEqual(predictor.candidates({ prefix: "x+", segments: [] }), []);
});

test("trained logistic coefficients and feature scaling are applied exactly", () => {
  const artifact = trainedArtifact({ sourceSequence: 2 });
  artifact.ranker.bias = -1;
  artifact.ranker.means[FEATURE_NAMES.indexOf("sourceSequence")] = 0.25;
  artifact.ranker.scales[FEATURE_NAMES.indexOf("sourceSequence")] = 0.5;
  const ranked = createPredictor(artifact).rank([
    { insertText: "y", kind: "expression", itemTier: 0 },
    { insertText: "z", kind: "sequence", itemTier: 0 },
  ], { prefix: "x+" });
  assert.equal(ranked[0].kind, "sequence");
  assert.ok(Math.abs(ranked[0].score - 1 / (1 + Math.exp(-2))) < 1e-12);
  assert.ok(Math.abs(ranked[1].score - 1 / (1 + Math.exp(2))) < 1e-12);
});

test("hard item scope cannot be overridden by learned scores and ranking preserves input metadata", () => {
  const artifact = trainedArtifact({ sourceExpression: 100 });
  const input = [
    { insertText: "global", kind: "expression", itemTier: 0, features: { custom: 42 } },
    { insertText: "local", kind: "grammar", itemTier: 2, features: { sameItem: 1 } },
  ];
  const ranked = createPredictor(artifact).rank(input, { prefix: "x+" });
  assert.equal(ranked[0].insertText, "local");
  assert.equal(ranked[1].features.custom, 42);
  assert.equal(input[0].score, undefined);
  assert.equal(input[0].insertText, "global");
  assert.deepEqual(featureValues(ranked[0], { prefix: "x+" }).length, FEATURE_NAMES.length);
});

test("malformed models fail closed for generation while legacy candidates retain baseline ranking", () => {
  const base = createUntrainedArtifact(buildNgrams(["x+y"]));
  const malformed = [
    null,
    { ...base, schemaVersion: 999 },
    { ...base, tokenizerVersion: "different" },
    { ...base, trained: true },
    { ...base, ngrams: { ...base.ngrams, order: 9 } },
    { ...base, ngrams: { ...base.ngrams, smoothing: NaN } },
    { ...base, ngrams: { ...base.ngrams, contexts: [{ context: [], total: 1, next: [["x", 2]] }] } },
    { ...base, ngrams: { ...base.ngrams, contexts: [{ context: [], total: 1, next: [["x", -1]] }] } },
    { ...base, ngrams: { ...base.ngrams, contexts: [{ context: [], total: 1, next: [["\0", 1]] }] } },
    { ...trainedArtifact(), ranker: { ...trainedArtifact().ranker, weights: [1] } },
    { ...trainedArtifact(), ranker: { ...trainedArtifact().ranker, scales: FEATURE_NAMES.map(() => 0) } },
  ];
  for (const artifact of malformed) {
    assert.equal(validateArtifact(artifact), false);
    const predictor = createPredictor(artifact);
    assert.equal(predictor.valid, false);
    assert.equal(predictor.trained, false);
    assert.deepEqual(predictor.candidates({ prefix: "x+", segments: segments(["x+y"]) }), []);
    assert.equal(predictor.rank([{ insertText: "y", kind: "expression" }], { prefix: "x+" }).length, 1);
  }
});

test("duplicate model contexts and mismatched feature order are rejected", () => {
  const base = createUntrainedArtifact(buildNgrams(["x+y"]));
  base.ngrams.contexts.push(base.ngrams.contexts[0]);
  assert.equal(validateArtifact(base), false);
  const artifact = trainedArtifact();
  artifact.ranker.features.reverse();
  assert.equal(validateArtifact(artifact), false);
});


test("model schema requires current classifier features and rejects stale trained artifacts", () => {
  const current = trainedArtifact({ categoryMatch: 1, indexFit: 2, symbolTypeMatch: 3 });
  assert.equal(current.schemaVersion, SCHEMA_VERSION);
  assert.equal(current.classifierVersion, CLASSIFIER_VERSION);
  assert.equal(validateArtifact(current), true);
  const legacyRanker = Object.fromEntries(Object.entries(current.ranker).map(([key, value]) =>
    [key, Array.isArray(value) ? value.slice(0, 15) : value]));
  assert.equal(validateArtifact({ ...current, schemaVersion: 1, ranker: legacyRanker }), false);
  assert.equal(validateArtifact({ ...current, ranker: legacyRanker }), false);
  assert.equal(validateArtifact({ ...current, classifierVersion: "autotex-context-old" }), false);
  assert.equal(validateArtifact({ ...current, classifierVersion: undefined }), false);
  assert.equal(validateArtifact({
    schemaVersion: 1, tokenizerVersion: TOKENIZER_VERSION, trained: false,
    ngrams: buildNgrams(["x+y"]), ranker: null,
  }), true);
  const stale = createPredictor({ ...current, schemaVersion: 1, ranker: legacyRanker });
  assert.deepEqual(stale.candidates({ prefix: "x+", segments: segments(["x+y"]) }), []);
  assert.equal(stale.rank([{ insertText: "y", kind: "expression" }], { prefix: "x+" }).length, 1);
});

test("ordinary set and arithmetic commands remain available without corpus examples", () => {
  for (const suffix of ["\\not\\in A", "\\mid n", "\\gcd(a,b)", "\\bigcup_{i=1}^{n}A_i"]) {
    assert.equal(validateCandidate({ fullText: suffix }, { prefix: "x" }), true, suffix);
  }
  assert.equal(validateCandidate({ fullText: "\\not" }, { prefix: "x" }), false);
});

function typedContext(prefix) {
  return {
    prefix, itemId: "current",
    segments: segments([
      "A \\subseteq \\mathbb{R}",
      "B \\subseteq \\mathbb{R}",
      "x \\in \\mathbb{R}",
    ]),
  };
}

test("baseline prefers a declared set over a scalar after intersection", () => {
  const ranked = createPredictor().rank([
    { insertText: "x", kind: "prediction", itemTier: 2 },
    { insertText: "B", kind: "prediction", itemTier: 2 },
  ], typedContext("A \\cap "));
  assert.equal(ranked[0].insertText, "B");
  assert.ok(ranked[0].features.categoryMatch > 0);
  assert.ok(ranked[0].features.symbolTypeMatch > 0);
  assert.ok(ranked[1].features.symbolTypeMatch < 0);
  assert.equal(ranked.length, 2, "Type evidence is a preference, not a hard prohibition");
});

test("index ranking prefers a numeric increment while generation completes a balanced subscript", () => {
  const predictor = createPredictor();
  const context = { prefix: "a_{i+", itemId: "current", segments: segments(["a_{i+1}"]) };
  const ranked = predictor.rank([
    { insertText: "\\cup B}", kind: "prediction", itemTier: 2 },
    { insertText: "1}", kind: "prediction", itemTier: 2 },
  ], context);
  assert.equal(ranked[0].insertText, "1}");
  assert.ok(ranked[0].features.indexFit > ranked[1].features.indexFit);
  const candidates = predictor.candidates({ ...context, maxTokens: 2 });
  assert.equal(candidates[0].fullText, "1}");
  assert.equal(validateCandidate(candidates[0], context), true);
});

test("type guidance reaches beam generation and keeps legal group intersections", () => {
  const Classifier = require("../extension/classifier.js");
  const context = typedContext("A \\cap ");
  const classification = Classifier.analyze(context);
  const artifact = createUntrainedArtifact(buildNgrams(["A \\cap B", "A \\cap x"]));
  const candidates = createPredictor(artifact).candidates({
    prefix: context.prefix, classification, segments: [], maxTokens: 1, maxCandidates: 8,
  });
  assert.equal(candidates[0].insertText, "B");
  assert.ok(candidates.some((candidate) => candidate.insertText === "x"));

  const groupContext = {
    prefix: "G \\cap ", itemId: "current",
    segments: segments(["G \\cap H"]),
    declarations: [{ text: "G is a group. H is a group.", itemId: "current" }],
    maxTokens: 1,
  };
  assert.ok(createPredictor().candidates(groupContext).some((candidate) => candidate.insertText === "H"));
});

test("classifier feature vectors agree with trained scoring and refresh when context changes", () => {
  const artifact = trainedArtifact({ categoryMatch: 2, indexFit: 3, symbolTypeMatch: 4 });
  artifact.ranker.bias = -0.2;
  for (const name of ["categoryMatch", "indexFit", "symbolTypeMatch"]) {
    const at = FEATURE_NAMES.indexOf(name);
    artifact.ranker.means[at] = 0.1;
    artifact.ranker.scales[at] = 2;
  }
  const predictor = createPredictor(artifact);
  const original = { insertText: "B", kind: "expression", itemTier: 2, semanticScore: 7,
    features: { categoryMatch: -1, indexFit: -1, symbolTypeMatch: -1, custom: 42 } };
  const context = typedContext("A \\cap ");
  const ranked = predictor.rank([original], context)[0];
  const values = featureValues(original, context);
  assert.equal(values.length, 18);
  assert.deepEqual(FEATURE_NAMES.map((name) => ranked.features[name]), values);
  const logit = artifact.ranker.bias + values.reduce((sum, value, at) =>
    sum + artifact.ranker.weights[at] * (value - artifact.ranker.means[at]) / artifact.ranker.scales[at], 0);
  assert.ok(Math.abs(ranked.score - 1 / (1 + Math.exp(-logit))) < 1e-12);
  assert.ok(ranked.features.categoryMatch > 0, "Previously cached features do not override the current type");
  assert.equal(ranked.semanticScore, 7);
  assert.equal(ranked.features.custom, 42);
  const reranked = predictor.rank([ranked], typedContext("x+"))[0];
  assert.ok(reranked.features.categoryMatch < ranked.features.categoryMatch);
  assert.ok(reranked.features.symbolTypeMatch < 0);
  assert.equal(original.features.categoryMatch, -1, "The caller's candidate is not mutated");
});

test("unknown symbol types remain neutral instead of being inferred from letter names", () => {
  const values = featureValues({ insertText: "R", kind: "prediction" }, { prefix: "G", segments: [] });
  for (const name of ["categoryMatch", "indexFit", "symbolTypeMatch"]) {
    assert.equal(values[FEATURE_NAMES.indexOf(name)], 0, name);
  }
});
