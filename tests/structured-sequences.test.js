'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../extension/engine.js');

function completion(marked, overrides = {}) {
  const cursor = marked.lastIndexOf('|');
  assert.ok(cursor >= 0);
  return createEngine({ expressions: false, ...overrides }).suggest(marked.slice(0, cursor) + marked.slice(cursor + 1), cursor);
}

function suffix(marked, overrides) { return completion(marked, overrides)?.insertText; }

test('whole function terms keep coefficients and every synchronized argument index', () => {
  for (const [input, expected] of [
    [String.raw`$r_1f(x_1)+r_2f(x_2)|$`, String.raw`+\cdots+r_nf(x_n)`],
    [String.raw`$r_1f(x_1)+r_2f(x_2)+...|$`, String.raw`+r_nf(x_n)`],
    [String.raw`$f(x_1),f(x_2)|$`, String.raw`,\ldots,f(x_n)`],
    [String.raw`$r_1f(x_1)r_2f(x_2)|$`, String.raw`\cdots r_nf(x_n)`],
    [String.raw`$f(x_1) \subseteq f(x_2)|$`, String.raw` \subseteq \cdots \subseteq f(x_n)`],
    [String.raw`$r_{1}f(x_1,y_{1}) + r_{2}f(x_2,y_{2})|$`, String.raw` + \cdots + r_{n}f(x_n,y_{n})`],
    [String.raw`$r_1f(g(x_1),h(y_1))+r_2f(g(x_2),h(y_2))|$`, String.raw`+\cdots+r_nf(g(x_n),h(y_n))`],
    [String.raw`$c r_1f(x_1)+c r_2f(x_2)|$`, String.raw`+\cdots+c r_nf(x_n)`],
    [String.raw`$r_1f(x_1^2+3)+r_2f(x_2^2+3)|$`, String.raw`+\cdots+r_nf(x_n^2+3)`],
    [String.raw`$r_1f(x)+r_2f(x)|$`, String.raw`+\cdots+r_nf(x)`],
    [String.raw`$f'(x_1)+f'(x_2)|$`, String.raw`+\cdots+f'(x_n)`],
  ]) {
    const result = completion(input);
    assert.equal(result?.kind, 'sequence', input);
    assert.equal(result.insertText, expected, input);
  }
});

test('balanced groups and command arguments remain part of each repeated term', () => {
  for (const [input, expected] of [
    [String.raw`$r_1(x_1+y_1)+r_2(x_2+y_2)|$`, String.raw`+\cdots+r_n(x_n+y_n)`],
    [String.raw`$(x_1+y_1)+(x_2+y_2)|$`, String.raw`+\cdots+(x_n+y_n)`],
    [String.raw`$(x_1)(x_2)|$`, String.raw`\cdots(x_n)`],
    [String.raw`$\left(x_1\right)\left(x_2\right)|$`, String.raw`\cdots\left(x_n\right)`],
    [String.raw`$r_1f[x_1]+r_2f[x_2]|$`, String.raw`+\cdots+r_nf[x_n]`],
    [String.raw`$r_1\left(x_1+y_1\right)+r_2\left(x_2+y_2\right)|$`, String.raw`+\cdots+r_n\left(x_n+y_n\right)`],
    [String.raw`$f\bigl(x_1\bigr)+f\bigl(x_2\bigr)|$`, String.raw`+\cdots+f\bigl(x_n\bigr)`],
    [String.raw`$\bigl|x_1\bigr|+\bigl|x_2\bigr||$`, String.raw`+\cdots+\bigl|x_n\bigr|`],
    [String.raw`$\frac{a_1}{b_1}+\frac{a_2}{b_2}|$`, String.raw`+\cdots+\frac{a_n}{b_n}`],
    [String.raw`$\frac{r_1f(x_1)}{q_1}+\frac{r_2f(x_2)}{q_2}|$`, String.raw`+\cdots+\frac{r_nf(x_n)}{q_n}`],
    [String.raw`$\sqrt[3]{x_1}+\sqrt[3]{x_2}|$`, String.raw`+\cdots+\sqrt[3]{x_n}`],
    [String.raw`$f(x_1+x_2|)$`, String.raw`+\cdots+x_n`],
    [String.raw`$\bigl(a_1,a_2|$`, String.raw`,\ldots,a_n\bigr)`],
    [String.raw`$\left\langle a_1,a_2|$`, String.raw`,\ldots,a_n\right\rangle`],
  ]) assert.equal(suffix(input), expected, input);
});

test('partial function terms and endpoints finish with existing paired closers intact', () => {
  for (const [input, expected] of [
    [String.raw`$r_1f(x_1)+r_|$`, String.raw`2f(x_2)+\cdots+r_nf(x_n)`],
    [String.raw`$r_1f(x_1)+r_2f(x_|$`, String.raw`2)+\cdots+r_nf(x_n)`],
    [String.raw`$r_1f(x_1)+r_2f(x_|)$`, String.raw`2)+\cdots+r_nf(x_n`],
    [String.raw`$r_1f(x_1)+r_2f(x_2)+...+r_nf(x_|)$`, 'n'],
    [String.raw`$r_1f(x_1)+r_2f(x_2)+...+r_mf(x_|)$`, 'm'],
    [String.raw`$r_1f(x_1)+r_2f(x_2)+...+r_{m}|$`, String.raw`f(x_m)`],
    [String.raw`$\frac{a_1}{b_1}+\frac{a_2}{b_|}$`, String.raw`2}+\cdots+\frac{a_n}{b_n`],
  ]) assert.equal(suffix(input), expected, input);
  assert.equal(completion(String.raw`$r_1f(x_1)+r_2f(x_2)+...+r_{m|}$`), null,
    'A suffix insertion must not leave an extra paired brace after the function');
  assert.equal(suffix(String.raw`$r_1f(x_1)+r_2f(x_2)|$`, { sequenceEnd: '3' }), '+r_3f(x_3)');
});

test('endpoint evidence matches the whole function term, including nested arguments', () => {
  const active = String.raw`$r_1f(x_1)+r_2f(x_2)+...|$`;
  for (const evidence of [
    String.raw`$r_1f(x_1)+r_2f(x_2)+\cdots+r_Mf(x_M)$`,
    String.raw`$r_1f(x_1)+r_2f(x_2)+r_3f(x_3)+\cdots+r_Mf(x_M)$`,
    String.raw`$r_if(x_i),1\le i\le M$`,
  ]) assert.equal(suffix(evidence + '\n' + active), '+r_Mf(x_M)', evidence);
  for (const evidence of [
    String.raw`$f(x_i),1\le i\le M$`,
    String.raw`$r_if(x_j),1\le i\le M$`,
    String.raw`$q_ir_if(x_i),1\le i\le M$`,
    String.raw`$g(r_if(x_i)),1\le i\le M$`,
    String.raw`$r_1f(x_1)+r_2f(x_2)+\cdots+r_Mg(x_M)$`,
    String.raw`$r_1f(x_1)+r_2f(x_2)+\cdots+r_Mf(x_N)$`,
  ]) assert.equal(suffix(evidence + '\n' + active), '+r_nf(x_n)', evidence);
});

test('mismatched function terms never become a misleading last-argument list', () => {
  for (const input of [
    String.raw`$r_1f(x_1)+r_2g(x_2)|$`,
    String.raw`$r_1f(x_1)+r_2f(x_3)|$`,
    String.raw`$r_1f(x_2)+r_2f(x_2)+r_3f(x_3)|$`,
    String.raw`$r_1f(x_1,y_1)+r_2f(x_2,y_3)|$`,
    String.raw`$r_1f(x_1^2)+r_2f(x_2^3)|$`,
    String.raw`$r_1f(x_1)+r_2f(x_2)+...+r_nf(x_m)|$`,
    String.raw`$r_1f(x_1]+r_2f(x_2)|$`,
    String.raw`$r_1f(\text{first}x_1)+r_2f(\text{first}x_2)|$`,
  ]) assert.equal(completion(input), null, input);
});
