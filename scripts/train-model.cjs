#!/usr/bin/env node
'use strict';

// Offline only: reads TeX as text; never executes TeX or contacts a service.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { analyzeDocument, mathSegments } = require('../extension/context.js');
const Predictor = require('../extension/predictor.js');
const Engine = require('../extension/engine.js');
const { createEngine } = Engine;

const DEFAULTS = Object.freeze({ seed: 1729, order: 5, minCount: 2, maxContexts: 12000,
  maxSuccessors: 16, maxSamples: 64, epochs: 40, maxDocumentBytes: 5000000 });
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SPLITS = ['train', 'rank', 'validation', 'test'];
const CATEGORIES = Object.freeze(['index', 'set', 'algebra', 'function', 'scalar', 'unknown']);
const categoryName = (value) => CATEGORIES.includes(value) ? value : 'unknown';
const sourceName = (candidate) => candidate.reliable || ['expression', 'sequence'].includes(candidate.kind) ? 'reliable' : 'generated';
const GROUPING = Object.freeze({ version: 2, shingleSize: 5, jaccard: 0.85,
  minimumContainmentShingles: 100, containment: 0.9,
  minimumSegmentTokens: 5, minimumContainedSegments: 10, orderedSegmentCoverage: 0.9 });
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function randomGenerator(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ value >>> 15, 1 | value);
    result ^= result + Math.imul(result ^ result >>> 7, 61 | result);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function parseArguments(args) {
  const options = { ...DEFAULTS };
  const numbers = { '--seed': 'seed', '--order': 'order', '--min-count': 'minCount',
    '--max-contexts': 'maxContexts', '--max-successors': 'maxSuccessors',
    '--max-samples': 'maxSamples', '--epochs': 'epochs', '--max-document-bytes': 'maxDocumentBytes' };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--help' || name === '-h') { options.help = true; continue; }
    if (name === '--prepare') { options.prepare = true; continue; }
    if (!['--input', '--output', '--browser-output', ...Object.keys(numbers)].includes(name)) {
      throw new Error('Unknown argument: ' + name);
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + name);
    const key = numbers[name] || name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = numbers[name] ? Number(value) : value;
    if (numbers[name] && (!Number.isSafeInteger(options[key]) || options[key] < (key === 'seed' ? 0 : 1))) {
      throw new Error(name + ' must be ' + (key === 'seed' ? 'a non-negative' : 'a positive') + ' integer.');
    }
  }
  if (options.help) return options;
  options.input ||= path.join(REPOSITORY_ROOT, 'dataset');
  options.output ||= path.join(REPOSITORY_ROOT, 'artifacts', options.prepare ? 'prepared.json' : 'model.json');
  if (options.order > 5) throw new Error('--order must be between 1 and 5.');
  if (options.maxContexts > 100000) throw new Error('--max-contexts must not exceed 100000.');
  if (options.maxSuccessors > 128) throw new Error('--max-successors must not exceed 128.');
  if (options.seed > 0xFFFFFFFF) throw new Error('--seed must fit an unsigned 32-bit integer.');
  if (path.extname(options.output).toLowerCase() !== '.json') throw new Error('--output must name a .json file.');
  if (options.browserOutput && path.extname(options.browserOutput).toLowerCase() !== '.js') {
    throw new Error('--browser-output must name a .js file.');
  }
  if (options.prepare && options.browserOutput) throw new Error('--browser-output cannot be used with --prepare.');
  return options;
}

function texFiles(directory) {
  const result = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => lexical(a.name, b.name))) {
      const filename = path.join(current, entry.name);
      // Do not follow directory or file links outside the explicitly supplied dataset.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && /\.tex$/i.test(entry.name)) result.push(filename);
    }
  }
  walk(directory);
  return result;
}

function tokenKey(text) {
  return Predictor.tokenize(text).filter((token) => !/^\s+$/.test(token.value)).map((token) => token.value);
}

function shingles(tokens) {
  const result = new Set();
  for (let i = 0; i + GROUPING.shingleSize <= tokens.length; i++) {
    result.add(sha(JSON.stringify(tokens.slice(i, i + GROUPING.shingleSize))).slice(0, 16));
  }
  return result;
}

function loadCorpus(input, options = DEFAULTS, onProgress = () => {}) {
  const directory = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(directory).isDirectory()) throw new Error('--input must be a directory.');
  const documents = [];
  let emptyDocuments = 0;
  let duplicateDocuments = 0;
  const byMathHash = new Map();
  const files = texFiles(directory);
  for (const [fileIndex, filename] of files.entries()) {
    if (fileIndex % 100 === 0) onProgress('Reading document ' + (fileIndex + 1) + '/' + files.length + '...');
    if (fs.statSync(filename).size > options.maxDocumentBytes) {
      throw new Error('A TeX file exceeds --max-document-bytes: ' + path.relative(directory, filename));
    }
    const text = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
    const parsed = analyzeDocument(text);
    const extracted = mathSegments(parsed).map((segment) => ({ segment, tokens: tokenKey(segment.text) }))
      .filter((entry) => entry.tokens.length > 0);
    if (!extracted.length) { emptyDocuments++; continue; }
    const segments = extracted.map((entry) => entry.segment);
    const normalized = extracted.map((entry) => entry.tokens);
    const mathHash = sha(JSON.stringify(normalized));
    const relative = path.relative(directory, filename).split(path.sep).join('/');
    // One top-level directory represents one paper/project. Flat files are separate families.
    const family = relative.includes('/') ? relative.split('/')[0] : relative;
    if (byMathHash.has(mathHash)) {
      byMathHash.get(mathHash).families.add(family);
      duplicateDocuments++;
      continue;
    }
    const document = { text, segments, sourceHash: sha(text), mathHash, families: new Set([family]),
      relative };
    byMathHash.set(mathHash, document);
    documents.push(document);
  }
  if (!documents.length) throw new Error('No non-empty mathematical regions were found in the .tex files.');
  return { documents, emptyDocuments, duplicateDocuments };
}

function orderedCoverage(shorter, longer) {
  if (shorter.length < GROUPING.minimumContainedSegments) return 0;
  const positions = new Map();
  longer.forEach((key, index) => {
    if (!positions.has(key)) positions.set(key, []);
    positions.get(key).push(index);
  });
  // Longest common subsequence via an increasing sequence of matching positions.
  // Reverse each occurrence list so one short segment cannot match more than once.
  const tails = [];
  for (const key of shorter) {
    const matches = positions.get(key) || [];
    for (let index = matches.length - 1; index >= 0; index--) {
      const position = matches[index];
      let low = 0, high = tails.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (tails[middle] < position) low = middle + 1;
        else high = middle;
      }
      tails[low] = position;
    }
  }
  return tails.length / shorter.length;
}

// Keep exact 64-bit SHA shingle identities in packed buffers rather than millions
// of JS Map/Set entries. Histogram intersections are safe upper bounds, so the
// prefilter cannot discard a pair that passes the original grouping rules.
function packShingles(tokens) {
  const values = tokens.length >= 20 ? [...shingles(tokens)].sort() : [];
  const high = new Uint32Array(values.length), low = new Uint32Array(values.length);
  const buckets = new Uint32Array(1024);
  for (let i = 0; i < values.length; i++) {
    high[i] = Number.parseInt(values[i].slice(0, 8), 16);
    low[i] = Number.parseInt(values[i].slice(8), 16);
    buckets[high[i] >>> 22]++;
  }
  return { high, low, buckets, size: values.length };
}

function shingleIntersection(left, right, required) {
  let upper = 0;
  for (let bucket = 0; bucket < left.buckets.length; bucket++) {
    upper += Math.min(left.buckets[bucket], right.buckets[bucket]);
  }
  if (upper < required) return 0;
  let a = 0, b = 0, common = 0;
  while (a < left.size && b < right.size) {
    if (common + Math.min(left.size - a, right.size - b) < required) return 0;
    if (left.high[a] === right.high[b] && left.low[a] === right.low[b]) { common++; a++; b++; }
    else if (left.high[a] < right.high[b] || left.high[a] === right.high[b] && left.low[a] < right.low[b]) a++;
    else b++;
  }
  return common;
}

function splitCorpus(corpus, seed, onProgress = () => {}) {
  const documents = corpus.documents.slice().sort((a, b) => lexical(a.mathHash, b.mathHash));
  const segmentKeys = [];
  const parent = documents.map((_, index) => index);
  const find = (index) => {
    while (index !== parent[index]) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  const unite = (a, b) => { parent[find(b)] = find(a); };
  const families = new Map();
  const segmentPostings = new Map();
  const documentShingles = [];
  documents.forEach((document, index) => {
    if (index % 100 === 0) onProgress('Grouping document ' + (index + 1) + '/' + documents.length + '...');
    for (const family of document.families) {
      if (families.has(family)) unite(index, families.get(family));
      else families.set(family, index);
    }
    const normalized = document.segments.map((segment) => tokenKey(segment.text));
    const keys = normalized.filter((tokens) => tokens.length >= GROUPING.minimumSegmentTokens)
      .map((tokens) => sha(JSON.stringify(tokens)));
    segmentKeys.push(keys);
    const counts = new Map();
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
    const sharedSegments = new Map();
    for (const [key, count] of counts) {
      for (const [previous, previousCount] of segmentPostings.get(key) || []) {
        sharedSegments.set(previous, (sharedSegments.get(previous) || 0) + Math.min(count, previousCount));
      }
    }
    const current = packShingles(normalized.flat());
    for (let previous = 0; previous < index; previous++) {
      if (find(index) === find(previous)) continue;
      const before = documentShingles[previous];
      const smaller = Math.min(current.size, before.size);
      const larger = Math.max(current.size, before.size);
      const shortIndex = current.size <= before.size ? index : previous;
      const longIndex = shortIndex === index ? previous : index;
      const shortSegments = segmentKeys[shortIndex];
      const mayBeNear = larger > 0 && smaller / larger >= GROUPING.jaccard;
      const mayBeContained = smaller >= GROUPING.minimumContainmentShingles &&
        shortSegments.length >= GROUPING.minimumContainedSegments &&
        (sharedSegments.get(previous) || 0) / shortSegments.length >= GROUPING.orderedSegmentCoverage;
      if (!mayBeNear && !mayBeContained) continue;
      const required = Math.min(
        mayBeNear ? Math.ceil(GROUPING.jaccard * (current.size + before.size) / (1 + GROUPING.jaccard)) : Infinity,
        mayBeContained ? Math.ceil(GROUPING.containment * smaller) : Infinity);
      const common = shingleIntersection(current, before, required);
      const union = current.size + before.size - common;
      const nearDuplicate = mayBeNear && union > 0 && common / union >= GROUPING.jaccard;
      const containedVersion = mayBeContained && common / smaller >= GROUPING.containment &&
        orderedCoverage(shortSegments, segmentKeys[longIndex]) >= GROUPING.orderedSegmentCoverage;
      if (nearDuplicate || containedVersion) unite(index, previous);
    }
    documentShingles.push(current);
    for (const [key, count] of counts) {
      if (!segmentPostings.has(key)) segmentPostings.set(key, []);
      segmentPostings.get(key).push([index, count]);
    }
  });
  const grouped = new Map();
  documents.forEach((document, index) => {
    const key = find(index);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(document);
  });
  const groups = [...grouped.values()].sort((a, b) => lexical(a[0].mathHash, b[0].mathHash));
  if (groups.length < 4) {
    throw new Error('Training needs at least 4 distinct document families after duplicate/project grouping; found ' + groups.length + '. Put each independent project in its own top-level directory, or use distinct flat .tex files.');
  }
  const shuffled = shuffle(groups, randomGenerator(seed));
  const rankCount = Math.max(1, Math.floor(groups.length * 0.2));
  const validationCount = Math.max(1, Math.floor(groups.length * 0.1));
  const testCount = Math.max(1, Math.floor(groups.length * 0.1));
  const trainCount = groups.length - rankCount - validationCount - testCount;
  const splits = Object.fromEntries(SPLITS.map((name) => [name, []]));
  let offset = 0;
  for (const [name, count] of [['train', trainCount], ['rank', rankCount], ['validation', validationCount], ['test', testCount]]) {
    splits[name] = shuffled.slice(offset, offset + count).flat();
    offset += count;
  }
  return { splits, groupCount: groups.length };
}

// Misra-Gries admits frequent contexts anywhere in the corpus. Its counters are
// used only to choose a bounded shortlist; a second full pass exports exact
// successor counts for that shortlist. Corpus order never locks out late data.
function buildCorpusNgrams(segments, options, onProgress = () => {}) {
  const capacity = options.maxContexts * 4;
  const shortlist = new Map();
  let decrement = 0;
  function visit(callback, phase) {
    let processed = 0;
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const tokens = Predictor.tokenize(segments[segmentIndex]).map((token) => token.value);
      if (tokens.some((token) => !token.length || token.length > 128 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(token))) continue;
      tokens.push('<eos>');
      for (let position = 0; position < tokens.length; position++) {
        for (let length = 0; length < options.order && length <= position; length++) {
          callback(JSON.stringify(tokens.slice(position - length, position)), tokens[position]);
        }
      }
      processed += tokens.length - 1;
      if (segmentIndex % 20000 === 0) onProgress(phase + ': ' + processed.toLocaleString('en-US') + ' tokens...');
    }
  }
  visit((key) => {
    if (key === '[]') return;
    if (shortlist.has(key)) shortlist.set(key, shortlist.get(key) + 1);
    else if (shortlist.size < capacity) shortlist.set(key, decrement + 1);
    else {
      decrement++;
      for (const [context, count] of shortlist) if (count <= decrement) shortlist.delete(context);
    }
  }, 'Selecting corpus contexts');
  const counts = new Map([['[]', { total: 0, next: new Map() }]]);
  for (const key of shortlist.keys()) counts.set(key, { total: 0, next: new Map() });
  shortlist.clear();
  visit((key, next) => {
    const entry = counts.get(key);
    if (!entry) return;
    entry.total++;
    entry.next.set(next, (entry.next.get(next) || 0) + 1);
  }, 'Recounting corpus contexts');
  const contexts = [...counts].filter(([key, entry]) => key === '[]' || entry.total >= options.minCount)
    .sort(([keyA, a], [keyB, b]) => (keyA === '[]' ? -1 : keyB === '[]' ? 1 : b.total - a.total) || keyA.localeCompare(keyB))
    .slice(0, options.maxContexts)
    .map(([key, entry]) => ({ context: JSON.parse(key), total: entry.total,
      next: [...entry.next].filter(([, count]) => key === '[]' || count >= options.minCount)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, options.maxSuccessors) }))
    .filter((entry) => entry.next.length > 0);
  return { order: options.order, smoothing: 3, contexts };
}

function samplePositions(document, maxSamples, random) {
  const positions = new Set();
  for (const segment of document.segments) {
    for (const token of Predictor.tokenize(segment.text)) {
      const end = segment.start + token.end;
      if (!/^\s+$/.test(token.value) && end < segment.end) positions.add(end);
      // Include realistic cursors inside command words and multi-digit numbers.
      if (/^\\[A-Za-z]{3,}$/.test(token.value)) positions.add(segment.start + token.start + Math.max(3, Math.floor(token.value.length / 2)));
      else if (/^\d{2,}$/.test(token.value)) positions.add(segment.start + token.start + 1);
    }
  }
  // Reserve a few cursors in the first formula to measure initial suggestions
  // as well as completions after document evidence accumulates.
  const all = [...positions].sort((a, b) => a - b);
  const first = document.segments[0];
  const initial = shuffle(all.filter((cursor) => cursor > first.start && cursor < first.end), random)
    .slice(0, Math.max(1, Math.floor(maxSamples / 4)));
  const selected = new Set(initial);
  return initial.concat(shuffle(all.filter((cursor) => !selected.has(cursor)), random)
    .slice(0, Math.max(0, maxSamples - initial.length))).sort((a, b) => a - b);
}

function candidateMatches(prefix, insertion, continuation) {
  // Tokenize with left context so a cursor inside a control word reconstructs the command.
  // Compare token arrays, not concatenated strings: `\\sin x` is distinct from `\\sinx`.
  const candidateTokens = tokenKey(prefix + insertion);
  const targetTokens = tokenKey(prefix + continuation);
  return tokenPrefixMatches(candidateTokens, targetTokens);
}

function tokenPrefixMatches(candidateTokens, targetTokens) {
  return candidateTokens.length <= targetTokens.length &&
    candidateTokens.every((token, index) => token === targetTokens[index]);
}

function generateExamples(documents, artifact, options, engine = createEngine({ model: artifact })) {
  const random = randomGenerator(options.seed ^ 0x9E3779B9);
  const examples = [];
  const scoringPredictor = Predictor.createPredictor(artifact);
  const sampledByStage = { cold: 0, warm: 0 };
  const sampledByCategory = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  let sampledCursors = 0;
  for (const [documentIndex, document] of documents.entries()) {
    engine.reset?.();
    if (documentIndex % 10 === 0) options.onProgress?.('Sampling document ' + (documentIndex + 1) + '/' + documents.length + ' (' + sampledCursors + ' cursors)...');
    for (const cursor of samplePositions(document, options.maxSamples, random)) {
      const segment = document.segments.find((entry) => entry.start < cursor && cursor < entry.end);
      if (!segment) continue;
      const continuation = segment.text.slice(cursor - segment.start);
      if (!tokenKey(continuation).length) continue;
      sampledCursors++;
      const stage = segment === document.segments[0] ? 'cold' : 'warm';
      sampledByStage[stage]++;
      // Simulated append: neither the answer nor any later text enters retrieval/local counts.
      const visible = document.text.slice(0, cursor);
      const collected = engine.collectCandidates(visible, visible.length);
      const category = categoryName(collected?.context?.classification?.kind);
      sampledByCategory[category]++;
      if (!collected) continue;
      const rows = [];
      const targetTokens = tokenKey(collected.context.prefix + continuation);
      const ranked = engine.rankCandidates ? engine.rankCandidates(collected.candidates, collected.context) :
        scoringPredictor.rank(collected.candidates, collected.context);
      for (const candidate of ranked) {
        if (!tokenKey(candidate.insertText || '').length) continue;
        const features = Predictor.featureValues(candidate, collected.context);
        if (features.length !== Predictor.FEATURE_NAMES.length || features.some((value) => !Number.isFinite(value))) {
          throw new Error('Candidate feature schema or numeric value is invalid.');
        }
        rows.push({ features, runtimeScore: candidate.score, label: Number(tokenPrefixMatches(tokenKey(collected.context.prefix + candidate.insertText), targetTokens)), chars: candidate.insertText.length,
          scopeTier: candidate.scopeTier ?? candidate.itemTier ?? 0,
          itemTier: candidate.itemTier ?? candidate.scopeTier ?? 0, insertText: candidate.insertText,
          kind: candidate.kind, reliable: Boolean(candidate.reliable),
          legacyScore: candidate.legacyScore ?? 0, semanticScore: candidate.semanticScore ?? 0 });
      }
      if (rows.length) examples.push({ rows, category, stage });
    }
  }
  return { examples, sampledCursors, sampledByCategory, sampledByStage };
}

const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, value))));

function trainRanker(examples, options) {
  const rows = examples.flatMap((example) => example.rows);
  const positives = rows.filter((row) => row.label).length;
  if (!positives || positives === rows.length) {
    throw new Error('Ranker training requires both matching and non-matching candidates. Add more varied documents or increase --max-samples; found ' + positives + ' positives and ' + (rows.length - positives) + ' negatives.');
  }
  const dimensions = Predictor.FEATURE_NAMES.length;
  const means = Array(dimensions).fill(0);
  const scales = Array(dimensions).fill(0);
  for (const row of rows) for (let i = 0; i < dimensions; i++) means[i] += row.features[i] / rows.length;
  for (const row of rows) for (let i = 0; i < dimensions; i++) scales[i] += (row.features[i] - means[i]) ** 2 / rows.length;
  for (let i = 0; i < dimensions; i++) scales[i] = scales[i] > 1e-16 ? Math.sqrt(scales[i]) : 1;
  const normalized = rows.map((row) => ({ label: row.label, features: row.features.map((value, i) => (value - means[i]) / scales[i]) }));
  const weights = Array(dimensions).fill(0);
  let bias = Math.log(positives / (rows.length - positives));
  const random = randomGenerator(options.seed);
  const l2 = 0.001;
  for (let epoch = 0; epoch < options.epochs; epoch++) {
    const learningRate = 0.05 / Math.sqrt(1 + epoch);
    for (const row of shuffle(normalized, random)) {
      const score = bias + weights.reduce((sum, weight, i) => sum + weight * row.features[i], 0);
      const error = sigmoid(score) - row.label;
      for (let i = 0; i < dimensions; i++) weights[i] -= learningRate * (error * row.features[i] + l2 * weights[i]);
      bias -= learningRate * error;
    }
  }
  return { ranker: { features: [...Predictor.FEATURE_NAMES], weights, bias, means, scales },
    counts: { examples: examples.length, candidates: rows.length, positives, negatives: rows.length - positives } };
}

function probability(row, ranker) {
  let score = ranker.bias;
  for (let i = 0; i < ranker.weights.length; i++) score += ranker.weights[i] * (row.features[i] - ranker.means[i]) / ranker.scales[i];
  return sigmoid(score);
}

function emptyMetrics(sampledCursors) {
  return { sampledCursors, cursorsWithCandidates: 0, cursorsWithMatchingCandidate: 0,
    shown: 0, matching: 0, mismatching: 0, matchingCharacters: 0 };
}

function finishMetrics(metrics) {
  return { ...metrics, precision: metrics.shown ? metrics.matching / metrics.shown : null,
    coverage: metrics.sampledCursors ? metrics.shown / metrics.sampledCursors : 0 };
}

function recordCandidates(metrics, rows) {
  if (rows.length) metrics.cursorsWithCandidates++;
  if (rows.some((row) => row.label)) metrics.cursorsWithMatchingCandidate++;
}

function recordSelection(metrics, selected) {
  if (!selected) return;
  metrics.shown++;
  if (selected.label) { metrics.matching++; metrics.matchingCharacters += selected.chars; }
  else metrics.mismatching++;
}

function evaluate(samples, ranker, threshold = 0) {
  const totals = samples.sampledByCategory ? { ...samples.sampledByCategory } :
    Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  if (!samples.sampledByCategory) {
    for (const example of samples.examples) totals[categoryName(example.category)]++;
    totals.unknown += Math.max(0, samples.sampledCursors - samples.examples.length);
  }
  const overall = emptyMetrics(samples.sampledCursors);
  const byCategory = Object.fromEntries(CATEGORIES.map((category) => [category, emptyMetrics(totals[category] || 0)]));
  const byStage = Object.fromEntries(['cold', 'warm'].map((stage) => [stage, emptyMetrics(samples.sampledByStage?.[stage] || 0)]));
  const bySource = { reliable: emptyMetrics(samples.sampledCursors), generated: emptyMetrics(samples.sampledCursors) };
  for (const example of samples.examples) {
    const category = byCategory[categoryName(example.category)];
    const rows = example.rows.map((row) => ({ ...row, score: ranker ? probability(row, ranker) : row.runtimeScore }));
    rows.sort((a, b) => (b.itemTier ?? b.scopeTier ?? 0) - (a.itemTier ?? a.scopeTier ?? 0) ||
      b.score - a.score || b.chars - a.chars || (a.insertText || '').localeCompare(b.insertText || ''));
    recordCandidates(overall, rows);
    recordCandidates(category, rows);
    if (byStage[example.stage]) recordCandidates(byStage[example.stage], rows);
    for (const source of Object.keys(bySource)) recordCandidates(bySource[source], rows.filter((row) => sourceName(row) === source));
    // Share the exact deployed selection policy, including reliable-provider fallback
    // and winning-item priority. The learned gate applies to generated candidates.
    const selected = Engine.selectCandidate(rows, threshold, Boolean(ranker));
    recordSelection(overall, selected);
    recordSelection(category, selected);
    if (byStage[example.stage]) recordSelection(byStage[example.stage], selected);
    if (selected) recordSelection(bySource[sourceName(selected)], selected);
  }
  return { ...finishMetrics(overall),
    byStage: Object.fromEntries(Object.entries(byStage).map(([name, metrics]) => [name, finishMetrics(metrics)])),
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([name, metrics]) => [name, finishMetrics(metrics)])),
    bySource: Object.fromEntries(Object.entries(bySource).map(([name, metrics]) => [name, finishMetrics(metrics)])) };
}

function thresholdCurve(samples, ranker) {
  return Array.from({ length: 20 }, (_, step) => {
    const threshold = step / 20;
    const metrics = evaluate(samples, ranker, threshold);
    return { threshold, utility: metrics.matchingCharacters - metrics.mismatching * 16, metrics };
  });
}

function bestThreshold(curve) {
  let result = { threshold: 0.5, utility: -Infinity };
  for (const point of curve) {
    if (point.utility > result.utility || point.utility === result.utility && point.threshold > result.threshold) result = point;
  }
  return result.threshold;
}

function tuneThreshold(samples, ranker) {
  return bestThreshold(thresholdCurve(samples, ranker));
}

function summarize(corpus, grouped, options) {
  return { format: 'autotex-corpus-preparation-v1', tokenizerVersion: Predictor.TOKENIZER_VERSION,
    seed: options.seed, grouping: GROUPING, documents: corpus.documents.length, families: grouped.groupCount,
    duplicateDocuments: corpus.duplicateDocuments, emptyDocuments: corpus.emptyDocuments,
    splits: Object.fromEntries(SPLITS.map((name) => [name, { documents: grouped.splits[name].length,
      sourceHashes: grouped.splits[name].map((document) => document.sourceHash).sort(),
      mathHashes: grouped.splits[name].map((document) => document.mathHash).sort() }])) };
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value) + '\n', 'utf8');
}

function train(options, dependencies = {}) {
  const collectExamples = dependencies.generateExamples || generateExamples;
  const onProgress = dependencies.onProgress || (() => {});
  onProgress('Reading LaTeX documents...');
  const corpus = loadCorpus(options.input, options, onProgress);
  onProgress('Loaded ' + corpus.documents.length + ' mathematical documents; removed ' + corpus.duplicateDocuments + ' duplicates and skipped ' + corpus.emptyDocuments + ' files without mathematics.');
  const grouped = splitCorpus(corpus, options.seed, onProgress);
  const preparation = summarize(corpus, grouped, options);
  onProgress('Split ' + grouped.groupCount + ' document families: ' + SPLITS.map((name) => name + '=' + grouped.splits[name].length).join(', ') + '.');
  if (options.prepare) { writeJson(options.output, preparation); return { preparation }; }
  const segments = grouped.splits.train.flatMap((document) => document.segments.map((segment) => segment.text));
  const trainingTokens = segments.reduce((sum, segment) => sum + Predictor.tokenize(segment).length, 0);
  onProgress('Building order-' + options.order + ' n-grams from ' + trainingTokens + ' tokens...');
  const ngrams = buildCorpusNgrams(segments, options, onProgress);
  const sampleSettings = { ...options, onProgress };
  const initial = Predictor.createUntrainedArtifact(ngrams);
  if (!Predictor.validateArtifact(initial)) throw new Error('Generated n-gram artifact failed runtime validation.');
  onProgress('Generating ranker examples from ' + grouped.splits.rank.length + ' documents...');
  const rankSamples = collectExamples(grouped.splits.rank, initial, sampleSettings);
  onProgress('Fitting ranker from ' + rankSamples.examples.length + ' sampled cursors...');
  const fitted = trainRanker(rankSamples.examples, options);
  // Candidate generation itself ranks/truncates its beam. Evaluate with the fitted
  // ranker already installed, exactly as the deployed extension generates its shortlist.
  const fittedArtifact = { ...initial, trained: true, ranker: fitted.ranker };
  onProgress('Collecting validation examples from ' + grouped.splits.validation.length + ' documents...');
  const validation = collectExamples(grouped.splits.validation, fittedArtifact, sampleSettings);
  onProgress('Collecting test examples from ' + grouped.splits.test.length + ' documents...');
  const test = collectExamples(grouped.splits.test, fittedArtifact, sampleSettings);
  if (!validation.examples.length || !test.examples.length) {
    throw new Error('Validation and test documents must produce candidates. Add representative mathematical documents or increase --max-samples.');
  }
  const validationThresholdCurve = thresholdCurve(validation, fitted.ranker);
  const threshold = bestThreshold(validationThresholdCurve);
  const artifact = { ...fittedArtifact,
    training: { ...preparation, settings: { order: options.order, minCount: options.minCount,
      maxContexts: options.maxContexts, maxSuccessors: options.maxSuccessors, maxSamples: options.maxSamples,
      epochs: options.epochs }, trainingTokens, rankerExamples: fitted.counts, recommendedThreshold: threshold } };
  if (!Predictor.validateArtifact(artifact)) throw new Error('Trained artifact failed runtime validation.');
  onProgress('Collecting untrained baseline on the same held-out test cursors...');
  const baseline = collectExamples(grouped.splits.test, Predictor.createUntrainedArtifact(), sampleSettings);
  const report = { format: 'autotex-training-report-v3', tokenizerVersion: Predictor.TOKENIZER_VERSION,
    schemaVersion: initial.schemaVersion, classifierVersion: initial.classifierVersion,
    corpus: preparation, trainingTokens, ngramContexts: ngrams.contexts.length,
    serializedModelBytes: Buffer.byteLength(JSON.stringify(artifact) + '\n', 'utf8'), ranker: fitted.counts,
    recommendedThreshold: threshold, thresholdSource: 'validation', validationThresholdCurve,
    validation: evaluate(validation, fitted.ranker, threshold),
    test: evaluate(test, fitted.ranker, threshold),
    baseline: evaluate(baseline, null, 0),
    corpusCounting: 'Bounded Misra-Gries context selection over the full training split followed by exact successor recounting.',
    stages: { cold: 'Cursors in the first mathematical segment, before any prior formula is available.',
      warm: 'Cursors in later mathematical segments, using only earlier visible document text.' },
    evaluation: 'Simulated append with token-normalized prefix matching and no acceptance/rejection feedback; not a mathematical-correctness or real-user-acceptance measurement.' };
  onProgress('Writing model and held-out evaluation report...');
  writeJson(options.output, artifact);
  writeJson(options.output.replace(/\.json$/i, '.report.json'), report);
  if (options.browserOutput) {
    fs.mkdirSync(path.dirname(path.resolve(options.browserOutput)), { recursive: true });
    const content = '// Generated offline by scripts/train-model.cjs. Contains corpus-derived model data.\n' +
      '(function(root){\n"use strict";\nconst model=' + JSON.stringify(artifact) + ';\n' +
      'if(typeof module==="object"&&module.exports)module.exports=model;\nroot.AutoTexModel=model;\n})(typeof globalThis!=="undefined"?globalThis:this);\n';
    fs.writeFileSync(options.browserOutput, content, 'utf8');
  }
  return { artifact, report };
}

const HELP = `AutoTeX offline training (Node.js; no external dependencies)
  node scripts/train-model.cjs [options]

  --input <directory>       Dataset directory (default: this repository's dataset/)
  --output <file.json>      Model JSON (default: artifacts/model.json; prepared.json with --prepare)
  --prepare                 Validate, deduplicate and split only; do not train
  --browser-output <file.js> Also write a browser/CommonJS model bundle
  --seed <integer>           Deterministic split/training seed (default 1729)
  --order <1..5>             N-gram order (default 5)
  --min-count <integer>      Prune rare counts (default 2)
  --max-contexts <integer>   Maximum exported contexts (default 12000)
  --max-successors <integer> Maximum next tokens per context (default 16)
  --max-samples <integer>    Simulated cursors per document (default 64)
  --epochs <integer>         Ranker training passes (default 40)
  --max-document-bytes <n>   Reject larger TeX files (default 5000000)
`;

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else {
      const result = train(options, { onProgress: (message) => process.stdout.write(message + '\n') });
      if (result.preparation) process.stdout.write('Prepared ' + result.preparation.documents + ' documents in ' + result.preparation.families + ' families. No model trained.\n');
      else process.stdout.write('Trained ' + result.report.ngramContexts + ' contexts and a ' + Predictor.FEATURE_NAMES.length + '-feature ranker. Model and held-out report written.\n');
    }
  } catch (error) {
    process.stderr.write('AutoTeX training: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { DEFAULTS, GROUPING, CATEGORIES, parseArguments, loadCorpus, splitCorpus, samplePositions,
  buildCorpusNgrams, generateExamples, trainRanker, probability, evaluate, thresholdCurve, tuneThreshold, train, tokenKey, candidateMatches };
