'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../extension/engine.js');

function suggestion(marked, settings = {}) {
  const cursor = marked.indexOf('|');
  assert.ok(cursor >= 0, 'Fixture needs a cursor marker');
  const text = marked.slice(0, cursor) + marked.slice(cursor + 1);
  return createEngine({ expressions: false, ...settings }).suggest(text, cursor);
}
function suffix(marked, settings) { return suggestion(marked, settings)?.insertText; }

test('automatic final indices follow n, k, j, i and fall back to n when all are used', () => {
  for (const [used, endpoint] of [['', 'n'], ['n=', 'k'], ['n+k=', 'j'], ['n+k+j=', 'i'], ['n+k+j+i=', 'n']]) {
    const result = suggestion('$' + used + 'a_1+a_2+...|$');
    assert.equal(result?.insertText, '+a_' + endpoint, used);
    assert.equal(result.endpointSource, 'default', 'An automatic alternative is not a configured setting');
  }
  assert.equal(suffix('$a_1n_1+a_2n_2+...|$'), '+a_kn_k');
  assert.equal(suffix('$a_1n_1k_1+a_2n_2k_2+...|$'), '+a_jn_jk_j');
  assert.equal(suffix('$a_1n_1k_1j_1+a_2n_2k_2j_2+...|$'), '+a_in_ik_ij_i');
});

test('collision checks use the whole current math region, not other equations or prose', () => {
  assert.equal(suffix('$a_1+a_2+...|=n+k+j$'), '+a_i');
  assert.equal(suffix('Prose n k j i. $n+k+j+i$\n$a_1+a_2+...|$'), '+a_n');
  assert.equal(suffix('$a_1+a_2+...|$\n$n+k+j+i$'), '+a_n');
  assert.equal(suffix(String.raw`\begin{enumerate}\item $n+k+j+i$\item $a_1+a_2+...|$\end{enumerate}`), '+a_n');
});

test('LaTeX control words and masked text do not reserve endpoint letters', () => {
  assert.equal(suffix(String.raw`$\sin(t)+\ln(u)+\int f(t)=a_1+a_2+...|$`), '+a_n');
  assert.equal(suffix(String.raw`$x\in A=a_1+a_2+...|$`), '+a_n');
  assert.equal(suffix(String.raw`$\nu+\kappa+\iota=a_1+a_2+...|$`), '+a_n');
  assert.equal(suffix(String.raw`$\text{n k j i}=a_1+a_2+...|$`), '+a_n');
  assert.equal(suffix('$% n k j i\na_1+a_2+...|$'), '+a_n');
  assert.equal(suffix(String.raw`$\operatorname{sin}(x)=a_1+a_2+...|$`), '+a_n');
  assert.equal(suffix(String.raw`$a_1+a_2+...|\label{n_k_j_i}$`), '+a_n');
});

test('styled variables and plain subscript variables reserve their letters', () => {
  assert.equal(suffix(String.raw`$\mathbf{n}+\mathit{k}+\mathrm{j}=a_1+a_2+...|$`), '+a_i');
  assert.equal(suffix('$x_n+y_k+z_j=a_1+a_2+...|$'), '+a_i');
  assert.equal(suffix('$N+K+J+I=a_1+a_2+...|$'), '+a_n', 'Math variables are case-sensitive');
});

test('typed, document-supported and explicitly configured endpoints retain priority', () => {
  assert.equal(suffix('$a_1n_1+a_2n_2+...+a_mn_|$'), 'm');
  assert.equal(suffix('$a_1n_1+a_2n_2+\\cdots+a_Mn_M$\n$a_1n_1+a_2n_2+...|$'), '+a_Mn_M');
  assert.equal(suffix('$a_in_i,1\\le i\\le M$\n$a_1n_1+a_2n_2+...|$'), '+a_Mn_M');
  assert.equal(suffix('$a_1n_1+a_2n_2+...|$', { sequenceEnd: 'm' }), '+a_mn_m');
  assert.equal(suffix('$a_1n_1+a_2n_2+...|$', { sequenceEnd: '10' }), '+a_{10}n_{10}');
  assert.equal(suffix('$a_1n_1+a_2n_2+...|$', { sequenceEnd: 'n' }), '+a_kn_k');
});
