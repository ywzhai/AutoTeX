'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Engine = require('../extension/engine.js');
const Context = require('../extension/context.js');
const Predictor = require('../extension/predictor.js');

const createEngine = (settings = {}) => Engine.createEngine({ model: Predictor.createUntrainedArtifact(), ...settings });

test('structural completions work without invoking the classifier or token predictor', () => {
  const unexpected = () => { throw new Error('Ordinary autocomplete was invoked for a structural sequence'); };
  const sandbox = { module: { exports: {} }, require(name) {
    if (name === './context.js') return Context;
    if (name === './classifier.js') return { analyze: unexpected, candidateFeatures: unexpected };
    if (name === './predictor.js') return { createPredictor: () => ({ candidates: unexpected,
      prepareCandidates: unexpected, rank: unexpected, feedback: unexpected }) };
    if (name === './model.js') return {};
    throw new Error('Unexpected dependency: ' + name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/engine.js'), 'utf8'), sandbox);
  const engine = sandbox.module.exports.createEngine();
  for (const [text, expected] of [['$x_1,x_2', ',\\ldots,x_n'], ['$a_1b_1+a_2b_', '2+\\cdots+a_nb_n']]) {
    const direct = engine.suggestSequence(text, text.length);
    assert.equal(direct.insertText, expected);
    const collected = engine.collectCandidates(text, text.length);
    assert.equal(collected.candidates.length, 1);
    assert.equal(collected.candidates[0].kind, 'sequence');
    assert.equal(engine.rankCandidates(collected.candidates, collected.context)[0].insertText, expected);
    assert.equal(engine.suggestAlternatives(text, text.length).length, 1);
    assert.equal(engine.suggest(text, text.length).insertText, expected);
    assert.equal(engine.feedback(direct, true), false);
    assert.equal(engine.feedback(direct, false), false);
  }
});

test('structural selection wins over prediction scores and source-item ranking', () => {
  const sequence = { kind: 'sequence', insertText: '+\\cdots+x_n', itemTier: 0, score: 0 };
  const generated = { kind: 'prediction', insertText: '+q', itemTier: 2, score: 1 };
  const expression = { kind: 'expression', insertText: '+q', itemTier: 2, score: 1 };
  for (const learned of [false, true]) {
    assert.equal(Engine.selectCandidate([generated, expression, sequence], 1, learned), sequence);
  }
});

test('corpus ranking and document feedback cannot replace a recognized sequence', () => {
  const artifact = { ...Predictor.createUntrainedArtifact(), trained: true,
    ranker: { features: [...Predictor.FEATURE_NAMES],
      weights: Predictor.FEATURE_NAMES.map((name) => name === 'sourceSequence' ? -100 : name === 'sourceExpression' ? 100 : 0),
      means: Predictor.FEATURE_NAMES.map(() => 0), scales: Predictor.FEATURE_NAMES.map(() => 1), bias: 0 },
    training: { recommendedThreshold: 1 } };
  assert.equal(Predictor.validateArtifact(artifact), true);
  const engine = createEngine({ model: artifact });
  const text = '$x_1,x_2+q$\n$x_1,x_2';
  for (let i = 0; i < 5; i++) {
    const ordinary = engine.suggest(text, text.length, { sequences: false });
    assert.ok(ordinary && ordinary.kind !== 'sequence');
    assert.equal(engine.feedback(ordinary, true), true);
    const sequence = engine.suggest(text, text.length);
    assert.equal(sequence.kind, 'sequence');
    assert.equal(sequence.insertText, ',\\ldots,x_n');
    assert.equal(sequence._feedback, undefined);
    assert.equal(sequence.score, undefined, 'Structural completion does not claim a model probability');
    const state = engine.calibrationState();
    assert.equal(engine.feedback(sequence, false), false);
    assert.deepEqual(engine.calibrationState(), state);
    assert.deepEqual(engine.suggestAlternatives(text, text.length).map((candidate) => candidate.kind), ['sequence']);
  }
});

test('list and ordinary autocomplete switches remain independent', () => {
  const engine = createEngine();
  const text = '$x_1,x_2+q$\n$x_1,x_2';
  assert.equal(engine.suggest(text, text.length, { expressions: false }).kind, 'sequence');
  assert.notEqual(engine.suggest(text, text.length, { sequences: false }).kind, 'sequence');
  assert.equal(engine.suggest(text, text.length, { sequences: false, expressions: false }), null);
  assert.equal(engine.suggestSequence(text, text.length, { sequences: false }), null);
  assert.equal(engine.suggestSequence(text, text.length, { enabled: false }), null);
  for (const outside of ['$x_1,x_2$ prose', '$\\text{x_1,x_2', '% $x_1,x_2']) {
    assert.equal(engine.suggestSequence(outside, outside.length), null, outside);
  }
});

test('structural collection stays compatible with offline feature extraction and shared selection', () => {
  const engine = createEngine();
  const text = '$x_1+x_2';
  const collected = engine.collectCandidates(text, text.length);
  const ranked = engine.rankCandidates(collected.candidates, collected.context);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]._feedback, undefined);
  const values = Predictor.featureValues(ranked[0], collected.context);
  assert.equal(values.length, Predictor.FEATURE_NAMES.length);
  assert.ok(values.every(Number.isFinite));
  assert.equal(Engine.selectCandidate(ranked, 1, true).insertText, engine.suggest(text, text.length).insertText);
});
