'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Context = require('../extension/context.js');
const { createEngine } = require('../extension/engine.js');

function at(marked) {
  const cursor = marked.indexOf('|');
  const parsed = Context.analyzeDocument(marked.replace('|', ''));
  return Context.contextAt(parsed, cursor);
}

test('math gates inline/display/environments and excludes their surrounding prose', () => {
  for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]'],
    ['\\begin{equation*}', '\\end{equation*}'], ['\\begin{align}', '\\end{align}']]) {
    assert.ok(at(open + 'x+y|' + close));
    assert.equal(at(open + 'x+y' + close + ' prose|'), null);
    assert.ok(at(open + 'x+y|'));
  }
});

test('nested text arguments and literal/comment content never activate the model', () => {
  for (const marked of ['$\\text{word {x+y}|}$', '$\\operatorname{arcs|}$', '$\\label{eq:x|}$',
    '% $x+y|$', '\\verb+$x+y|$+', '\\begin{minted}{tex}$x+y|$\\end{minted}', '\\$x+y|']) {
    assert.equal(at(marked), null, marked);
  }
  assert.ok(at('$\\text{price $5} + x+y|$'));
  assert.ok(at('\\textbf{The equation $x+y|$ holds.}'));
});

test('current item returns after a nested list and ends at next sibling or list end', () => {
  const text = String.raw`\begin{enumerate}
\item[A] $a=1$
\begin{itemize}\item $b=2$\item $c=3$\end{itemize}
$d=4$
\item $e=5$
\end{enumerate}
$f=6$`;
  const parsed = Context.analyzeDocument(text);
  const scopes = ['a=1','b=2','c=3','d=4','e=5','f=6'].map((s) => Context.contextAt(parsed, text.indexOf(s) + s.length));
  assert.deepEqual(scopes.map((s) => s.itemId), [1, 2, 3, 1, 4, null]);
  assert.deepEqual(scopes[1].ancestorIds, [1]);
  assert.equal(Context.scopeTier(parsed, text.indexOf('b=2'), text.indexOf('a=1')), 1);
  assert.equal(Context.scopeTier(parsed, text.indexOf('b=2'), text.indexOf('c=3')), 0);
  assert.equal(Context.scopeTier(parsed, text.indexOf('d=4'), text.indexOf('a=1')), 2);
});

test('bare items, unfinished lists and optional labels retain the answer scope', () => {
  const bare = at('\\item $a=1$ \\item $b=2|');
  assert.equal(bare.itemId, 2);
  assert.equal(at('\\begin{enumerate}\\item[{$[a]$}] $x+y|').itemId, 1);
});

test('fake item commands in definitions comments text and math do not split answers', () => {
  const text = String.raw`\newcommand{\fake}{\item}
\begin{enumerate}\item $a=1$
% \item
\verb+\item+
$\text{\item} + b=2$
$\item+c$
$d=4$\end{enumerate}`;
  const parsed = Context.analyzeDocument(text);
  assert.equal(parsed.items.length, 1);
  assert.equal(Context.contextAt(parsed, text.indexOf('d=4') + 3).itemId, 1);
});

test('training segments omit prose and never teach transitions across a text argument', () => {
  const text = '$a=1\\text{secret answer}b=2$ prose $c=3$';
  const parsed = Context.analyzeDocument(text);
  assert.deepEqual(Context.mathSegments(parsed).map((s) => s.text.trim()), ['a=1','b=2','c=3']);
  assert.deepEqual(Context.mathSegments(parsed, text.indexOf('c=3') + 3).map((s) => s.text.trim()), ['a=1','b=2']);
});

test('alignment intertext and simple text boxes do not activate mathematical completion', () => {
  for (const command of ['intertext', 'shortintertext', 'hbox', 'vbox', 'fbox', 'makebox']) {
    const marked = '\\begin{align} a&=b \\\\ \\' + command + '{where {x_1,x_2|}} c&=d \\end{align}';
    assert.equal(at(marked), null, command);
    const cursor = marked.indexOf('|'), text = marked.replace('|', '');
    assert.equal(createEngine().suggest(text, cursor), null, command + ' must not suggest a sequence in prose');
    const parsed = Context.analyzeDocument(text);
    const segments = Context.mathSegments(parsed);
    assert.equal(segments.some((segment) => segment.text.includes('where') || segment.text.includes('x_1')), false);
    assert.ok(Context.contextAt(parsed, text.indexOf('c&=d') + 4), 'Math resumes after ' + command);
    assert.equal(parsed.clean.length, text.length, 'Masking must preserve offsets');
  }
});

test('grouped nested lists keep distinct items and return to their parent scope', () => {
  const marked = String.raw`\begin{enumerate}\item Main $p=0$
{\small\begin{enumerate}
\item $f(x)=x+1$. Also $f(x)=x+1$.
\item $f(x)=x+2$. Therefore $f(x)|$.
\end{enumerate}}
$q=0$\end{enumerate}`;
  const cursor = marked.indexOf('|'), text = marked.replace('|', '');
  const parsed = Context.analyzeDocument(text);
  assert.equal(parsed.items.length, 3);
  assert.equal(Context.contextAt(parsed, cursor).itemId, 3);
  assert.deepEqual(Context.contextAt(parsed, cursor).ancestorIds, [1]);
  assert.equal(Context.contextAt(parsed, text.indexOf('q=0') + 3).itemId, 1);
  assert.equal(createEngine().suggest(text, cursor).insertText, '=x+2');
  const wrapped = at('{\\small\\begin{enumerate}\\item $a=1$\\item $a+|$\\end{enumerate}}');
  assert.equal(wrapped.itemId, 2);
});

test('definition bodies with fake begin and item commands do not create list scopes', () => {
  const fake = String.raw`\begin{enumerate}\item fake\end{enumerate}`;
  const definitions = [
    String.raw`\newcommand{\fake}[1][{\item}]{` + fake + '}',
    String.raw`\renewcommand*\fake[1]{` + fake + '}',
    String.raw`\providecommand{\fake}{` + fake + '}',
    String.raw`\DeclareRobustCommand{\fake}{` + fake + '}',
    ...['def', 'gdef', 'edef', 'xdef'].map((name) => '\\' + name + String.raw`\fake#1{` + fake + '}'),
    String.raw`\newenvironment{fake}[1]{` + fake + '}{' + fake + '}',
    String.raw`\NewDocumentCommand{\fake}{m O{\item}}{` + fake + '}',
    String.raw`\NewDocumentEnvironment{fake}{m}{` + fake + '}{' + fake + '}',
    String.raw`\let\fake=\item`,
    String.raw`\futurelet\fake\item\next`,
  ];
  for (const definition of definitions) {
    const text = '{' + definition + '}\\begin{enumerate}\\item $a=1$ {\\textbf{\\item}} $b=2$\\end{enumerate}';
    const parsed = Context.analyzeDocument(text);
    assert.equal(parsed.items.length, 1, definition);
    assert.equal(Context.contextAt(parsed, text.indexOf('b=2') + 3).itemId, 1, definition);
  }
});
