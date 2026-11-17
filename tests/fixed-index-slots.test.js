'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../extension/engine.js');

function result(marked, settings = {}) {
  const cursor = marked.indexOf('|');
  assert.ok(cursor >= 0);
  const text = marked.slice(0, cursor) + marked.slice(cursor + 1);
  return createEngine({ expressions: false, ...settings }).suggest(text, cursor);
}
function suffix(marked, settings) { return result(marked, settings)?.insertText; }

test('fixed subscript slots survive while the observed numeric slots advance together', () => {
  for (const [input, expected] of [
    [String.raw`$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...|$`, '+r_nf(x_n,y_j)'],
    [String.raw`$r_1f(x_1,y_7)+r_2f(x_2,y_7)|$`, String.raw`+\cdots+r_nf(x_n,y_7)`],
    [String.raw`$r_1f(x_1,y_1)+r_2f(x_2,y_1)|$`, String.raw`+\cdots+r_nf(x_n,y_1)`],
    [String.raw`$a_1b_7+a_2b_7|$`, String.raw`+\cdots+a_nb_7`],
    [String.raw`$a_7b_1+a_7b_2|$`, String.raw`+\cdots+a_7b_n`],
    [String.raw`$a_1a_2+a_2a_2|$`, String.raw`+\cdots+a_na_2`],
    [String.raw`$a_1a_2 a_2a_2|$`, String.raw` \cdots a_na_2`],
    [String.raw`$a_1a_1+a_1a_2|$`, String.raw`+\cdots+a_1a_n`],
    [String.raw`$a_jb_1,a_jb_2|$`, String.raw`,\ldots,a_jb_n`],
    [String.raw`$a_jb_1 a_jb_2|$`, String.raw` \cdots a_jb_n`],
    [String.raw`$r_1f(x_1,y_j)r_2f(x_2,y_j)|$`, String.raw`\cdots r_nf(x_n,y_j)`],
    [String.raw`$p_1^{k_j}p_2^{k_j}|$`, String.raw`\cdots p_n^{k_j}`],
    [String.raw`$\frac{a_1}{b_j}+\frac{a_2}{b_j}|$`, String.raw`+\cdots+\frac{a_n}{b_j}`],
    [String.raw`$r_{1}f(x_1,y_{ j + 1 })+r_{2}f(x_2,y_{ j + 1 })|$`, String.raw`+\cdots+r_{n}f(x_n,y_{ j + 1 })`],
  ]) {
    assert.equal(result(input)?.kind, 'sequence', input);
    assert.equal(suffix(input), expected, input);
  }
  assert.equal(suffix('$r_1f(x_1,y_j)+r_2f(x_2,y_j)|$', { sequenceEnd: '3' }), '+r_3f(x_3,y_j)');
});

test('proven fixed slots stay fixed through partial third terms and endpoints', () => {
  for (const [input, expected] of [
    [String.raw`$r_1f(x_1,y_j)+r_2f(x_|)$`, String.raw`2,y_j)+\cdots+r_nf(x_n,y_j`],
    [String.raw`$r_1f(x_1,y_1)+r_2f(x_2,y_1)+r_3f(x_|)$`, String.raw`3,y_1)+\cdots+r_nf(x_n,y_1`],
    [String.raw`$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...+r_mf(x_m,y_|)$`, 'j'],
    [String.raw`$a_jb_1+a_jb_2+...+a_jb_|$`, 'n'],
    [String.raw`$a_jb_1 a_jb_|$`, String.raw`2 \cdots a_jb_n`],
    [String.raw`$a_1a_2 a_2a_|$`, String.raw`2 \cdots a_na_2`],
    [String.raw`$a_1b_7 a_2|$`, String.raw`b_7 \cdots a_nb_7`],
    [String.raw`$a_7b_1+a_7b_|$`, String.raw`2+\cdots+a_7b_n`],
    [String.raw`$r_7f(x_1,y_7)+r_7f(x_|)$`, String.raw`2,y_7)+\cdots+r_7f(x_n,y_7`],
    [String.raw`$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...+r_mf(x_|)$`, 'm,y_j'],
    [String.raw`$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...+r_{m|$`, '}f(x_m,y_j)'],
  ]) assert.equal(suffix(input), expected, input);
});

test('document endpoint evidence must preserve the same fixed slots', () => {
  const active = String.raw`$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...|$`;
  for (const evidence of [
    String.raw`$r_1f(x_1,y_j)+r_2f(x_2,y_j)+\cdots+r_Mf(x_M,y_j)$`,
    String.raw`$r_1f(x_1,y_j)+r_2f(x_2,y_j)+r_3f(x_3,y_j)+\cdots+r_Mf(x_M,y_j)$`,
    String.raw`$r_if(x_i,y_j),1\le i\le M$`,
  ]) assert.equal(suffix(evidence + '\n' + active), '+r_Mf(x_M,y_j)', evidence);
  for (const evidence of [
    String.raw`$r_1f(x_1,y_k)+r_2f(x_2,y_k)+\cdots+r_Mf(x_M,y_k)$`,
    String.raw`$r_1f(x_1,y_j)+r_2f(x_2,y_j)+\cdots+r_Mf(x_M,y_k)$`,
    String.raw`$r_if(x_i,y_k),1\le i\le M$`,
    String.raw`$r_if(x_j,y_j),1\le i\le M$`,
  ]) assert.equal(suffix(evidence + '\n' + active), '+r_nf(x_n,y_j)', evidence);
  assert.equal(suffix('$a_7b_i,1\\le i\\le M$\n$a_7b_1+a_7b_2|$'), String.raw`+\cdots+a_7b_M`);
});

test('fixed slots and one synchronized increment must hold across the entire numeric run', () => {
  for (const input of [
    '$a_jb_1+a_kb_2|$', '$a_1b_2+a_2b_3|$', '$a_jb_1+a_jb_3|$', '$a_jb_1+a_jb_1|$',
    '$a_1a_2 a_2a_2 a_4a_2|$', '$a_1a_2 a_2a_2 a_4a_|$',
    '$r_1f(x_1,y_j)+r_2f(x_2,y_k)|$',
    '$r_1f(x_1,y_k)+r_2f(x_2,y_j)+r_3f(x_3,y_j)|$',
    '$r_1f(x_1,y_7)+r_2f(x_2,y_8)|$',
    '$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...+r_mf(x_n,y_j)|$',
    '$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...+r_mf(x_m,y_k)|$',
  ]) assert.equal(result(input), null, input);
});
