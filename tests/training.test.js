'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Predictor = require('../extension/predictor.js');
const Training = require('../scripts/train-model.cjs');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autotex-training-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(directory, name, text) {
  const filename = path.join(directory, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, text, 'utf8');
}

// Artificial documents exercise the pipeline only, never serve as shipped model data.
function fixtureCorpus(directory) {
  const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  for (let index = 0; index < letters.length; index++) {
    const letter = letters[index];
    write(directory, letter + '.tex', String.raw`\begin{enumerate}
\item $\frac{x+y}{z}$ and $\frac{x+y}{w}$.
$\sum_{i=1}^{n} x_i$ followed by $\sum_{i=1}^{n} y_i$.
\item $${letter}_1 + ${letter}_2 = ${index + 2}$.
$${letter}_1 + ${letter}_2 = ${index + 2}$.
$\mathcal{${letter}}^{${index + 1}} = \left(${letter}^2 + ${index + 7}\right)$.
$\partial ${letter} / \partial t = ${index + 9}${letter} + ${index + 3}$.
\end{enumerate}`);
  }
}

test('training CLI rejects ambiguous or invalid arguments', () => {
  assert.equal(Training.parseArguments(['--help']).help, true);
  const defaults = Training.parseArguments([]);
  assert.equal(defaults.input, path.resolve(__dirname, '../dataset'));
  assert.equal(defaults.output, path.resolve(__dirname, '../artifacts/model.json'));
  assert.equal(Training.parseArguments(['--prepare']).output, path.resolve(__dirname, '../artifacts/prepared.json'));
  const overrides = Training.parseArguments(['--input', 'data with spaces', '--output', 'custom output.json']);
  assert.equal(overrides.input, 'data with spaces');
  assert.equal(overrides.output, 'custom output.json');
  assert.throws(() => Training.parseArguments(['--input']), /Missing value/);
  assert.throws(() => Training.parseArguments(['--unknown']), /Unknown/);
  assert.throws(() => Training.parseArguments(['--input', 'data', '--output', 'model.js']), /\.json/);
  assert.throws(() => Training.parseArguments(['--input', 'data', '--output', 'model.json', '--order', '6']), /between 1 and 5/);
  assert.throws(() => Training.parseArguments(['--input', 'data', '--output', 'model.json', '--epochs', 'NaN']), /integer/);
  assert.throws(() => Training.parseArguments(['--input', 'data', '--output', 'model.json', '--prepare', '--browser-output', 'model.js']), /cannot/);
});

test('separate folders with main.tex names and spaces remain distinct document families', (t) => {
  const directory = temporary(t);
  const input = path.join(directory, 'dataset with spaces');
  for (const [index, name] of ['Answer One', 'Answer Two', 'Answer Three', 'Answer Four'].entries()) {
    write(input, name + '/main.tex', '$x=' + (index + 1) + '$');
  }
  const corpus = Training.loadCorpus(input, Training.DEFAULTS);
  assert.equal(corpus.documents.length, 4);
  assert.equal(corpus.duplicateDocuments, 0);
  assert.deepEqual(corpus.documents.map((document) => document.relative).sort(),
    ['Answer Four/main.tex', 'Answer One/main.tex', 'Answer Three/main.tex', 'Answer Two/main.tex']);
  const grouped = Training.splitCorpus(corpus, Training.DEFAULTS.seed);
  assert.equal(grouped.groupCount, 4);
  assert.ok(Object.values(grouped.splits).every((documents) => documents.length === 1));
});

test('corpus extraction excludes prose, comments, literals and prose commands inside math', (t) => {
  const directory = temporary(t);
  write(directory, 'one.tex', String.raw`PROSESECRET
% $COMMENTSECRET$
\begin{verbatim}$LITERALSECRET$\end{verbatim}
$x + \text{TEXTSECRET} y$
\[\frac{a}{b}\]`);
  write(directory, 'plain.tex', 'No mathematics here.');
  const corpus = Training.loadCorpus(directory, Training.DEFAULTS);
  assert.equal(corpus.documents.length, 1);
  assert.equal(corpus.emptyDocuments, 1);
  const values = corpus.documents[0].segments.map((segment) => segment.text).join('');
  assert.doesNotMatch(values, /SECRET|\\text/);
  assert.match(values, /\\frac/);
});

test('exact duplicates, near duplicates and project families never cross splits', (t) => {
  const directory = temporary(t);
  fixtureCorpus(directory);
  const original = fs.readFileSync(path.join(directory, 'a.tex'), 'utf8');
  write(directory, 'copy.tex', original.replaceAll(' ', '  ') + '\n% another paper version');
  const long = '$' + Array.from({ length: 80 }, (_, i) => 'v_{' + i + '}').join('+') + '$';
  write(directory, 'family/first.tex', long);
  write(directory, 'family/second.tex', '$unique = 517$');
  write(directory, 'near.tex', long.replace('v_{79}', 'w_{79}'));
  const corpus = Training.loadCorpus(directory, Training.DEFAULTS);
  assert.equal(corpus.duplicateDocuments, 1);
  const grouped = Training.splitCorpus(corpus, 42);
  const familySplits = [];
  for (const [name, documents] of Object.entries(grouped.splits)) {
    for (const document of documents) if (document.relative.startsWith('family/') || document.relative === 'near.tex') familySplits.push(name);
  }
  assert.equal(new Set(familySplits).size, 1);
  assert.equal(familySplits.length, 3);
  const repeat = Training.splitCorpus(corpus, 42);
  assert.deepEqual(Object.values(grouped.splits).map((docs) => docs.map((doc) => doc.mathHash)),
    Object.values(repeat.splits).map((docs) => docs.map((doc) => doc.mathHash)));
});

test('contained substantial excerpts stay together while lower-overlap documents remain independent', (t) => {
  const directory = temporary(t);
  const terms = (symbol, count, offset = 0) => Array.from({ length: count }, (_, i) => '$' + symbol + '_{' + (i + offset) + '}$').join('\n');
  const excerpt = terms('q', 35);
  write(directory, 'short/main.tex', excerpt);
  write(directory, 'long/main.tex', excerpt + '\n' + terms('r', 130));
  write(directory, 'lower-overlap/main.tex', terms('q', 27) + '\n' + terms('w', 18));
  write(directory, 'independent-a.tex', '$a=1$');
  write(directory, 'independent-b.tex', '$b=2$');
  write(directory, 'independent-c.tex', '$c=3$');
  const corpus = Training.loadCorpus(directory, Training.DEFAULTS);
  assert.equal(corpus.documents.length, 6, 'retain both the short and long documents');
  const grouped = Training.splitCorpus(corpus, 42);
  assert.equal(grouped.groupCount, 5, 'only the contained short/long pair merges');
  const splitFor = (result, filename) => Object.entries(result.splits).find(([, documents]) => documents.some((doc) => doc.relative === filename))[0];
  assert.equal(splitFor(grouped, 'short/main.tex'), splitFor(grouped, 'long/main.tex'));
  assert.ok(Array.from({ length: 12 }, (_, seed) => Training.splitCorpus(corpus, seed))
    .some((result) => splitFor(result, 'lower-overlap/main.tex') !== splitFor(result, 'short/main.tex')),
  'a document with substantially lower containment remains an independent family');
});

test('reordered shared formulas do not pass the excerpt containment guard', (t) => {
  const directory = temporary(t);
  const equations = Array.from({ length: 35 }, (_, i) => '$q_{' + i + '}$');
  const extra = Array.from({ length: 130 }, (_, i) => '$r_{' + i + '}$');
  write(directory, 'short.tex', equations.join('\n'));
  write(directory, 'reordered-long.tex', [...equations].reverse().concat(extra).join('\n'));
  write(directory, 'independent-a.tex', '$a=1$');
  write(directory, 'independent-b.tex', '$b=2$');
  const corpus = Training.loadCorpus(directory, Training.DEFAULTS);
  assert.equal(Training.splitCorpus(corpus, 42).groupCount, 4);
});

test('a few shared formulas do not trigger containment grouping', (t) => {
  const directory = temporary(t);
  const terms = (count) => Array.from({ length: count }, (_, i) => 'v_{' + i + '}').join('+');
  write(directory, 'short.tex', '$' + terms(6) + '$');
  write(directory, 'long.tex', '$' + terms(100) + '$');
  write(directory, 'independent-a.tex', '$a=1$');
  write(directory, 'independent-b.tex', '$b=2$');
  const corpus = Training.loadCorpus(directory, Training.DEFAULTS);
  assert.equal(Training.splitCorpus(corpus, 42).groupCount, 4);
});

test('training refuses insufficient independent families', (t) => {
  const directory = temporary(t);
  for (let i = 0; i < 5; i++) write(directory, 'one-project/' + i + '.tex', '$x=' + i + '$');
  assert.throws(() => Training.splitCorpus(Training.loadCorpus(directory, Training.DEFAULTS), 1), /at least 4 distinct/);
});

test('L2 logistic ranker learns from features and handles constant dimensions', () => {
  const vector = (first) => Predictor.FEATURE_NAMES.map((_, i) => i === 0 ? first : 0);
  const examples = Array.from({ length: 20 }, () => ({ rows: [
    { features: vector(2), label: 1, chars: 10, scopeTier: 0 },
    { features: vector(-2), label: 0, chars: 10, scopeTier: 0 }
  ] }));
  const { ranker } = Training.trainRanker(examples, { ...Training.DEFAULTS, epochs: 25 });
  assert.ok(Training.probability(examples[0].rows[0], ranker) > 0.9);
  assert.ok(Training.probability(examples[0].rows[1], ranker) < 0.1);
  assert.ok(ranker.scales.every((value) => value > 0 && Number.isFinite(value)));
  assert.throws(() => Training.trainRanker([{ rows: [examples[0].rows[0]] }], Training.DEFAULTS), /both matching and non-matching/);
});

test('simulated typing never passes hidden or future source to candidate generation', (t) => {
  const directory = temporary(t);
  const text = String.raw`\item $\frac{x+y}{z}$ Later $FUTURESECRET$`;
  write(directory, 'one.tex', text);
  const corpus = Training.loadCorpus(directory, Training.DEFAULTS);
  const calls = [];
  const engine = { collectCandidates(visible, cursor) {
    calls.push({ visible, cursor });
    assert.equal(visible.length, cursor);
    assert.equal(visible, text.slice(0, cursor));
    return { candidates: [], context: { prefix: visible, classification: { kind: 'index' } } };
  } };
  const samples = Training.generateExamples(corpus.documents, null, { ...Training.DEFAULTS, maxSamples: 1000 }, engine);
  assert.equal(samples.sampledByCategory.index, samples.sampledCursors, 'preserve visible-context category even without candidates');
  assert.equal(samples.examples.length, 0);
  assert.ok(calls.length > 5);
  assert.ok(calls.some((call) => call.visible.endsWith('\\fr')), 'sample cursors inside control words');
  assert.ok(calls.filter((call) => call.cursor < text.indexOf('Later')).every((call) => !call.visible.includes('FUTURE')));
  assert.ok(calls.every((call) => call.cursor < text.length));
});

test('completion labels preserve command boundaries and reconstruct partial commands', () => {
  assert.equal(Training.candidateMatches('', '\\sin x', '\\sinx'), false);
  assert.equal(Training.candidateMatches('', '\\sinx', '\\sin x'), false);
  assert.equal(Training.candidateMatches('\\si', 'n x', 'n x + y'), true);
  assert.equal(Training.candidateMatches('\\si', 'nx', 'n x + y'), false);
  assert.equal(Training.candidateMatches('\\fra', 'c{x}{y}', 'c{ x }{ y } + z'), true);
  assert.equal(Training.candidateMatches('x', ' + y', '+y+z'), true);
});

test('evaluation keeps reliable completions visible and reports actual outcomes by category and source', () => {
  const Engine = require('../extension/engine.js');
  const dimensions = Predictor.FEATURE_NAMES.length;
  const ranker = { features: [...Predictor.FEATURE_NAMES], weights: Array(dimensions).fill(0),
    bias: -8, means: Array(dimensions).fill(0), scales: Array(dimensions).fill(1) };
  const row = (extra = {}) => ({ features: Array(dimensions).fill(0), label: 1, chars: 1,
    insertText: 'n', itemTier: 2, scopeTier: 2, kind: 'prediction', reliable: false,
    semanticScore: 0, legacyScore: 0, ...extra });
  const samples = { sampledCursors: 5,
    sampledByCategory: { index: 1, set: 1, algebra: 1, function: 0, scalar: 1, unknown: 1 },
    examples: [
      { category: 'index', rows: [row({ label: 0 }), row({ kind: 'index', reliable: true, semanticScore: 3 })] },
      { category: 'set', rows: [row({ kind: 'expression', legacyScore: 7 }), row({ label: 0 })] },
      { category: 'algebra', rows: [row()] },
      { category: 'scalar', rows: [row({ kind: 'sequence', label: 0 })] }
    ] };
  const metrics = Training.evaluate(samples, ranker, 0.95);
  assert.equal(metrics.shown, 3, 'a rejecting learned threshold gates only generated suggestions');
  assert.equal(metrics.matching, 2);
  assert.equal(metrics.mismatching, 1);
  assert.equal(metrics.bySource.reliable.shown, 3);
  assert.equal(metrics.bySource.generated.shown, 0);
  assert.equal(metrics.byCategory.index.matching, 1);
  assert.equal(metrics.byCategory.set.matching, 1);
  assert.equal(metrics.byCategory.algebra.shown, 0);
  assert.equal(metrics.byCategory.scalar.mismatching, 1);
  assert.equal(metrics.byCategory.unknown.sampledCursors, 1);
  assert.equal(metrics.byCategory.unknown.coverage, 0);
  const selected = samples.examples.map((example) =>
    Engine.selectCandidate(example.rows.map((candidate) => ({ ...candidate, score: Training.probability(candidate, ranker) })), 0.95));
  assert.equal(selected.filter(Boolean).length, metrics.shown);
  assert.equal(selected.filter((candidate) => candidate?.label).length, metrics.matching);
  const curve = Training.thresholdCurve(samples, ranker);
  assert.equal(curve.length, 20);
  assert.equal(curve[0].threshold, 0);
  assert.equal(curve.at(-1).threshold, 0.95);
  assert.equal(curve[0].metrics.bySource.generated.shown, 1);
  assert.deepEqual(curve.at(-1).metrics, metrics);
});

test('prepare and train produce reproducible validated artifacts without copying source documents', (t) => {
  const directory = temporary(t);
  const input = path.join(directory, 'data');
  fixtureCorpus(input);
  const options = { ...Training.DEFAULTS, input, output: path.join(directory, 'model.json'),
    browserOutput: path.join(directory, 'model.js'), minCount: 1, maxSamples: 150, epochs: 4 };
  const prepared = Training.train({ ...options, prepare: true, output: path.join(directory, 'prepared.json'), browserOutput: undefined });
  assert.equal(prepared.preparation.documents, 8);
  assert.equal(prepared.artifact, undefined);
  const generationArtifacts = [];
  const generationSamples = [];
  const progress = [];
  const first = Training.train(options, { onProgress: (message) => progress.push(message), generateExamples(documents, artifact, settings) {
    generationArtifacts.push(artifact);
    const samples = Training.generateExamples(documents, artifact, settings);
    generationSamples.push(samples);
    return samples;
  } });
  assert.match(progress[0], /Reading LaTeX/);
  assert.ok(progress.some((message) => message.includes('Loaded 8 mathematical documents')));
  assert.match(progress.at(-1), /Writing model/);
  assert.doesNotMatch(progress.join(' '), /\\begin|\\frac|\\sum/);
  assert.deepEqual(generationArtifacts.map((artifact) => artifact.trained), [false, true, true],
    'validation and test shortlists use the fitted deployment ranker');
  assert.deepEqual(generationArtifacts[1].ranker, first.artifact.ranker);
  assert.deepEqual(generationArtifacts[2].ranker, first.artifact.ranker);
  assert.equal(first.artifact.trained, true);
  assert.equal(first.artifact.schemaVersion, Predictor.SCHEMA_VERSION);
  assert.equal(first.artifact.classifierVersion, Predictor.CLASSIFIER_VERSION);
  assert.deepEqual(first.artifact.ranker.features.slice(-3), ['categoryMatch', 'indexFit', 'symbolTypeMatch']);
  assert.equal(first.report.classifierVersion, first.artifact.classifierVersion);
  assert.equal(first.report.thresholdSource, 'validation');
  assert.deepEqual(first.report.validationThresholdCurve, Training.thresholdCurve(generationSamples[1], first.artifact.ranker));
  assert.equal(first.report.recommendedThreshold, Training.tuneThreshold(generationSamples[1], first.artifact.ranker));
  assert.equal(Object.hasOwn(first.report, 'testThresholdCurve'), false);
  assert.deepEqual(Object.keys(first.report.test.byCategory), Training.CATEGORIES);
  assert.equal(Object.values(first.report.test.byCategory).reduce((sum, category) => sum + category.sampledCursors, 0), first.report.test.sampledCursors);
  assert.equal(Predictor.validateArtifact(first.artifact), true);
  assert.ok(first.report.ranker.positives > 0);
  assert.ok(first.report.ranker.negatives > 0);
  assert.ok(first.report.test.sampledCursors > 0);
  const output = fs.readFileSync(options.output, 'utf8');
  assert.equal(first.report.serializedModelBytes, Buffer.byteLength(output, 'utf8'));
  const heldOut = Training.splitCorpus(Training.loadCorpus(input, options), options.seed).splits.test;
  const deployedSamples = Training.generateExamples(heldOut, first.artifact, options);
  assert.deepEqual(first.report.test,
    Training.evaluate(deployedSamples, first.artifact.ranker, first.report.recommendedThreshold),
    'held-out report matches candidate generation with the exported model');
  Training.train(options);
  assert.equal(fs.readFileSync(options.output, 'utf8'), output);
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(options.browserOutput, 'utf8'), sandbox);
  assert.equal(sandbox.AutoTexModel.trained, true);
  assert.equal(sandbox.module.exports, sandbox.AutoTexModel);
  assert.doesNotMatch(JSON.stringify(first.report), /\\begin|\\frac|\\sum/);
  assert.equal(first.report.corpus.splits.test.documents, 1);
});
