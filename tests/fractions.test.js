'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../extension/engine.js');
const { createUntrainedArtifact } = require('../extension/predictor.js');
const engine = createEngine({ model: createUntrainedArtifact() });

function expand(marked) {
  const cursor = marked.indexOf('|');
  const text = marked.replace('|', '');
  const edit = engine.fractionEdit(text, cursor);
  if (!edit) return null;
  const result = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return result.slice(0, edit.anchor) + '|' + result.slice(edit.anchor);
}

test('fractions use the contiguous typed block and place the cursor in the denominator', () => {
  for (const [input, expected] of [
    ['$PQ|$', '$\\frac{PQ}{|}$'],
    ['$A + B+C|$', '$A + \\frac{B+C}{|}$'],
    ['$A+B+C|$', '$\\frac{A+B+C}{|}$'],
    ['$A\tPQ|$', '$A\t\\frac{PQ}{|}$'],
    ['$A\nPQ|$', '$A\n\\frac{PQ}{|}$'],
    ['$PQ|+R$', '$\\frac{PQ}{|}+R$'],
    ['$\\alpha_1+x_{i}|$', '$\\frac{\\alpha_1+x_{i}}{|}$'],
    ['$\\sqrt{PQ}|$', '$\\frac{\\sqrt{PQ}}{|}$'],
    ['$\\frac{P}{Q}|$', '$\\frac{\\frac{P}{Q}}{|}$'],
  ]) assert.equal(expand(input), expected, input);
});

test('fractions preserve math delimiters, enclosing groups, and alignment structure', () => {
  for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]'],
    ['\\begin{equation}', '\\end{equation}'], ['\\begin{align}', '\\end{align}']]) {
    assert.equal(expand(open + 'PQ|' + close), open + '\\frac{PQ}{|}' + close);
  }
  for (const [input, expected] of [
    ['\\[PQ|', '\\[\\frac{PQ}{|}'],
    ['$\\sqrt{PQ|}$', '$\\sqrt{\\frac{PQ}{|}}$'],
    ['$\\frac{P}{Q|}$', '$\\frac{P}{\\frac{Q}{|}}$'],
    ['$\\left(PQ|\\right)$', '$\\left(\\frac{PQ}{|}\\right)$'],
    ['$\\left[PQ\\right]|$', '$\\frac{\\left[PQ\\right]}{|}$'],
    ['$\\{PQ\\}|$', '$\\frac{\\{PQ\\}}{|}$'],
    ['\\begin{align}A&B+C|\\end{align}', '\\begin{align}A&\\frac{B+C}{|}\\end{align}'],
    ['\\begin{align}A\\\\[2pt]PQ|\\end{align}', '\\begin{align}A\\\\[2pt]\\frac{PQ}{|}\\end{align}'],
    ['$\\begin{matrix}PQ|\\end{matrix}$', '$\\begin{matrix}\\frac{PQ}{|}\\end{matrix}$'],
  ]) assert.equal(expand(input), expected, input);
});

test('fractions leave excluded contexts and unsafe or empty blocks alone', () => {
  for (const input of ['PQ|', '% $PQ|$', '$\\text{PQ|}$', '$\\operatorname{PQ|}$',
    '$\\label{PQ|}$', '\\begin{verbatim}$PQ|$\\end{verbatim}', '$|$', '$PQ |$',
    '$PQ\n|$', '$PQ\\|$', '$\\sqrt{A B}|$', '$A B\\right)|$', '$PQ}|$', '$\\frac{|}$']) {
    assert.equal(expand(input), null, input);
  }
  for (const cursor of [-1, 100, 0.5, NaN]) assert.equal(engine.fractionEdit('$PQ$', cursor), null);
  assert.equal(engine.fractionEdit(null, 0), null);
});

test('fractions preserve required and optional math environment headers', () => {
  for (const [environment, header] of [
    ['array', '{cc}'], ['array', '[t]{c c}'], ['array', '{>{\\mathbf}c}'],
    ['subarray', '{c}'], ['alignedat', '[t]{2}'], ['matrix*', '[r]'], ['pmatrix*', '[r]'], ['aligned', '[b]'],
  ]) {
    const opening = '$\\begin{' + environment + '}' + header;
    const closing = '\\end{' + environment + '}$';
    assert.equal(expand(opening + 'PQ|' + closing), opening + '\\frac{PQ}{|}' + closing);
  }
  for (const environment of ['alignat', 'alignat*']) {
    const opening = '\\begin{' + environment + '} {2}';
    const closing = '\\end{' + environment + '}';
    assert.equal(expand(opening + 'PQ|' + closing), opening + '\\frac{PQ}{|}' + closing);
  }
  assert.equal(expand('$\\begin{array}{cc}P&Q\\end{array}R+S|$'),
    '$\\begin{array}{cc}P&Q\\end{array}\\frac{R+S}{|}$');
  assert.equal(expand('$\\begin{array}{cc}P&Q\\end{array} R+S|$'),
    '$\\begin{array}{cc}P&Q\\end{array} \\frac{R+S}{|}$');
  for (const marked of ['$\\begin{array}{c|c}PQ\\end{array}$', '$\\begin{array}[t|]{cc}PQ\\end{array}$',
    '$\\begin{array}{cc|$', '$\\begin{array}PQ|$', '\\begin{alignat}{2|}PQ\\end{alignat}']) {
    assert.equal(expand(marked), null, marked);
  }
});

test('fractions do not detach spaced delimiters or middle delimiters from their commands', () => {
  for (const marked of ['$\\left (PQ|\\right)$', '$\\left(PQ\\right )|$', '$\\bigl (PQ|$',
    '$\\Bigg [PQ|$', '$\\left(P\\middle\\vert Q\\right)|$']) {
    assert.equal(expand(marked), null, marked);
  }
  assert.equal(expand('$\\left(P\\middle\\vert Q|\\right)$'), '$\\left(P\\middle\\vert \\frac{Q}{|}\\right)$');
  assert.equal(expand('$\\left(P\\middle\\vert{}Q|\\right)$'), null);
  assert.equal(expand('$\\left(P\\middle\\vert{}Q\\right)|$'), '$\\frac{\\left(P\\middle\\vert{}Q\\right)}{|}$');
});

test('fractions do not replace unbraced arguments of commands separated by whitespace', () => {
  for (const marked of ['$\\sqrt PQ|$', '$\\sqrt[3] PQ|$', '$\\frac{A} B|$', '$\\dfrac A B|$',
    '$\\frac{A} {B}|$', '$\\mathbf PQ|$', '$\\overset{a} B|$']) {
    assert.equal(expand(marked), null, marked);
  }
  assert.equal(expand('$\\sqrt{A} PQ|$'), '$\\sqrt{A} \\frac{PQ}{|}$');
  assert.equal(expand('$\\frac{A}{B} PQ|$'), '$\\frac{A}{B} \\frac{PQ}{|}$');
  assert.equal(expand('$\\frac{A}{B + PQ|}$'), '$\\frac{A}{B + \\frac{PQ}{|}}$');
});
