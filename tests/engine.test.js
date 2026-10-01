'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine: createRuntimeEngine, DEFAULT_SETTINGS } = require('../extension/engine.js');
const Predictor = require('../extension/predictor.js');
// Deterministic rule fixtures should not change whenever the shipped corpus is retrained.
const createEngine = (settings = {}) => createRuntimeEngine({ model: Predictor.createUntrainedArtifact(), ...settings });

function suggest(marked, settings) {
  const cursor = marked.indexOf('|');
  assert.notEqual(cursor, -1, 'Fixture requires a cursor marker');
  return createEngine(settings).suggest(marked.replace('|', ''), cursor);
}

function suffix(marked, settings) {
  return suggest(marked, settings)?.insertText;
}

test('exports immutable sensible defaults and suffix-only API', () => {
  assert.equal(DEFAULT_SETTINGS.sequenceEnd, 'n');
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  const result = suggest('$a^2 + b^2 = c^2$ Later $a^2|$');
  assert.equal(result.kind, 'expression');
  assert.equal(result.insertText, ' + b^2 = c^2');
});

test('reuses expressions in each math delimiter', () => {
  for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]'], ['\\begin{equation}', '\\end{equation}']]) {
    assert.equal(suffix(open + '\\frac{a+b}{c}' + close + ' Then ' + open + '\\fra|' + close), 'c{a+b}{c}');
  }
});

test('reuses alignment rows excluding labels and alignment markers', () => {
  const input = '\\begin{align}\nf(x) &= x^2 + 1 \\\\ \\label{eq:one}\ng(x) &= \\sin x + 2\n\\end{align}\n$f(x)|$';
  assert.equal(suffix(input), ' = x^2 + 1');
});

test('uses earlier rows within the active alignment environment', () => {
  assert.equal(suffix('\\begin{align}\na^2 + b^2 &= c^2 \\\\\na^2|\n\\end{align}'), ' + b^2 = c^2');
});

test('supports cursor in middle of document and suppresses already-present suffix', () => {
  assert.equal(suffix('$x^2|$\nLater: $x^2 + y^2$'), ' + y^2');
  assert.equal(suggest('$x^2 + y^2$\n$x^2| + y^2$'), null);
});

test('preserves typed whitespace while matching flexible source whitespace', () => {
  assert.equal(suffix('$x^2 + y^2$\n$x^2+|$'), ' y^2');
  assert.equal(suffix('$x^2 + y^2$\n$x^2 |$'), '+ y^2');
});

test('finds repeated subexpressions after an equality', () => {
  assert.equal(suffix('$f(x)=\\frac{x+1}{x-1}$\n$g(x)=\\fra|$'), 'c{x+1}{x-1}');
});

test('does not reuse current incomplete occurrence or suggestions from prose', () => {
  assert.equal(suggest('$\\fra|$'), null);
  assert.equal(suggest('The previous words were repeated. The previous|'), null);
  assert.equal(suggest('$x^2 + y^2$\nOrdinary prose x^2|'), null);
});

test('no suggestion within LaTeX comments or text inside math', () => {
  assert.equal(suggest('$x^2 + y^2$\n% $x^2|'), null);
  assert.equal(suggest('$x_1,x_2$\n$\\text{x_1,x_2|}$'), null);
  assert.equal(suggest('% $x^2 + y^2$\n$x^2|$'), null);
});

test('escaped dollars do not open math', () => {
  assert.equal(suggest('Price \\$x_1,x_2|'), null);
});

test('handles incomplete display math while the user is typing', () => {
  assert.equal(suffix('\\[x^2+y^2\\]\n\\[x^2|'), '+y^2');
});

test('completes consecutive indexed variables respecting comma spaces', () => {
  assert.equal(suffix('$x_1,x_2|$'), ',\\ldots,x_n');
  assert.equal(suffix('$x_1, x_2|$'), ', \\ldots, x_n');
  assert.equal(suffix('$x_0, x_1, x_2|$'), ', \\ldots, x_n');
  assert.equal(suffix('$x_1,x_2,|$'), '\\ldots,x_n');
  assert.equal(suffix('$x_1, x_2, |$'), '\\ldots, x_n');
});

test('closes obvious sequence groups and respects editor-paired delimiters', () => {
  assert.equal(suffix('$' + '{x_1,x_2|$'), ',\\ldots,x_n}');
  assert.equal(suffix('$' + '{x_1,x_2|}$'), ',\\ldots,x_n');
  assert.equal(suffix('$\\{x_1, x_2|\\}$'), ', \\ldots, x_n');
  assert.equal(suffix('$\\left\\{x_1,x_2|$'), ',\\ldots,x_n\\right\\}');
  assert.equal(suffix('$(x_1,x_2|)$'), ',\\ldots,x_n');
});

test('supports braced indices Greek variables and styled variable bases', () => {
  assert.equal(suffix('$x_{1}, x_{2}|$'), ', \\ldots, x_{n}');
  assert.equal(suffix('$\\alpha_1,\\alpha_2|$'), ',\\ldots,\\alpha_n');
  assert.equal(suffix('$\\mathbf{x}_{1}, \\mathbf{x}_{2}|$'), ', \\ldots, \\mathbf{x}_{n}');
  assert.equal(suffix('$' + '{x}_1,{x}_2|$'), ',\\ldots,{x}_n');
});

test('completes a sufficiently clear partial second index', () => {
  assert.equal(suffix('$x_1,x_|$'), '2,\\ldots,x_n');
  assert.equal(suffix('$x_{1}, x_{|$'), '2}, \\ldots, x_{n}');
  assert.equal(suffix('$x_{1}, x_{2|}$'), '}, \\ldots, x_{n');
  assert.equal(suggest('$x_1,y_|$'), null);
  assert.equal(suggest('$x_1,x_{3|$'), null);
});

test('rejects nonconsecutive indices unrelated variables and ordinary commas', () => {
  for (const input of ['$x_1,x_3|$', '$x_1,y_2|$', '$x_3,x_2|$', '$x_1, x_5, x_6|$', '$one,two|$']) {
    assert.equal(suggest(input), null, input);
  }
});

test('infers endpoint and dots style from a previous matching list', () => {
  const result = suggest('$x_1,x_2,\\cdots,x_m$\n$x_1, x_2|$');
  assert.equal(result.insertText, ', \\cdots, x_m');
  assert.equal(result.endpointSource, 'previous-list');
  assert.equal(suffix('$x_{1},x_{2},\\ldots,x_{N}$\n$x_1,x_2|$'), ',\\ldots,x_N');
});

test('does not borrow endpoint from an unrelated variable', () => {
  assert.equal(suffix('$y_1,y_2,\\ldots,y_m$\n$x_1,x_2|$'), ',\\ldots,x_n');
});

test('infers a nearby bound only for the same indexed variable', () => {
  assert.equal(suffix('$x_i, 1 \\le i \\le m$\n$x_1,x_2|$'), ',\\ldots,x_m');
  assert.equal(suffix('$x_j, j=1,\\ldots,N$\n$x_1,x_2|$'), ',\\ldots,x_N');
  assert.equal(suffix('$y_i, 1 \\le i \\le m$\n$x_1,x_2|$'), ',\\ldots,x_n');
});

test('finite endpoints use document evidence or explicit settings; omit dots for one remaining term', () => {
  assert.equal(suffix('$x_1,x_2,\\ldots,x_3$\n$x_1,x_2|$'), ',x_3');
  assert.equal(suffix('$x_1,x_2,\\ldots,x_9$\n$x_1,x_2|$'), ',\\ldots,x_9');
  assert.equal(suffix('$x_1,x_2|$', { sequenceEnd: '10' }), ',\\ldots,x_{10}');
  assert.equal(suffix('$x_1,x_2|$', { sequenceEnd: 3 }), ',x_3');
  assert.equal(suffix('$x_1,x_2|$', { sequenceEnd: '999' }), ',\\ldots,x_{999}');
  assert.equal(suffix('$x_1,x_2|$', { sequenceEnd: '1000' }), ',\\ldots,x_n');
  assert.equal(suffix('$x_1,x_2|$', { sequenceEnd: '2' }), ',\\ldots,x_n');
});

test('respects controls maximum length and safe endpoint configuration', () => {
  assert.equal(suggest('$x_1,x_2|$', { enabled: false }), null);
  assert.equal(suggest('$x_1,x_2|$', { sequences: false }), null);
  assert.equal(suggest('$x^2+y^2$ $x^2|$', { expressions: false }), null);
  assert.equal(suggest('$x^2+y^2$ $x^2|$', { minPrefix: 4 }), null);
  assert.equal(suggest('$x_1,x_2|$', { maxSuggestionLength: 3 }), null);
  assert.equal(suffix('$x_1,x_2|$', { sequenceEnd: 'N' }), ',\\ldots,x_N');
  assert.equal(suffix('$x_1,x_2|$', { sequenceEnd: 'm-1' }), ',\\ldots,x_{m-1}');
});

test('engine can be reused after text changes deletion settings overrides and reset', () => {
  const engine = createEngine();
  let text = '$x^2+y^2$\n$x^2';
  assert.equal(engine.suggest(text, text.length).insertText, '+y^2');
  text = '$x^2+z^2$\n$x^2';
  assert.equal(engine.suggest(text, text.length).insertText, '+z^2');
  assert.equal(engine.suggest(text.slice(0, -1), text.length - 1), null);
  assert.equal(engine.suggest(text, text.length, { enabled: false }), null);
  engine.reset();
  assert.equal(engine.suggest(text, text.length).insertText, '+z^2');
});

test('invalid input is ignored', () => {
  const engine = createEngine();
  assert.equal(engine.suggest(null, 0), null);
  assert.equal(engine.suggest('$x_1,x_2$', -1), null);
  assert.equal(engine.suggest('$x_1,x_2$', 100), null);
  assert.equal(engine.suggest('$x_1,x_2$', 2.5), null);
});

test('handles a substantial document without changing suggestions', () => {
  const body = Array.from({ length: 2000 }, (_, i) => 'Paragraph ' + i + '. $a_{' + i + '} = ' + i + ' + 1$\n').join('');
  assert.equal(suffix(body + '$x^2+y^2$\n$x^2|'), '+y^2');
});

test('nested text groups and escaped-percent comments do not produce completions', () => {
  assert.equal(suggest('$\\text{x_{1},x_2|}$'), null);
  assert.equal(suggest('\\% percent % $x^2+y^2$\n$x^2|$'), null);
});

test('subexpression reuse does not copy unmatched closing parentheses', () => {
  assert.equal(suffix('$f(abc+def)=0$ $abc|$'), '+def');
});

test('does not complete over an unrelated remainder of an existing token', () => {
  assert.equal(suggest('$\\frac{x}{y}$ $\\fra|zzz$'), null);
  assert.equal(suffix('$\\frac{x}{y}$ $\\fra|{x}{y}$'), 'c');
});

test('reuses a previous row in an unfinished math environment', () => {
  assert.equal(suffix('\\begin{align}\nx^2+y^2 \\\\\nx^2|'), '+y^2');
});

test('ignores math syntax inside literal and listing environments', () => {
  for (const env of ['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment']) {
    const open = '\\begin{' + env + '}';
    const close = '\\end{' + env + '}';
    assert.equal(suggest(open + '$x_1,x_2|' + close), null, env);
    assert.equal(suggest(open + '$x^2+y^2$' + close + '\n$x^2|$'), null, env);
    assert.equal(suffix(open + '$unclosed' + close + '\n$x_1,x_2|$'), ',\\ldots,x_n', env);
    assert.equal(suggest(open + '$x_1,x_2|'), null, env);
  }
});

test('ignores inline literal commands even inside math', () => {
  assert.equal(suggest('\\verb+$x_1,x_2|+'), null);
  assert.equal(suggest('$x_1,x_2\\verb+abc|+$'), null);
  assert.equal(suggest('\\lstinline[language=TeX]+$x_1,x_2|+'), null);
  assert.equal(suggest('\\verb+$x^2+y^2$+ $x^2|$'), null);
  assert.equal(suffix('\\verb+%+ $x_1,x_2|$'), ',\\ldots,x_n');
});

test('commented literal commands cannot hide subsequent genuine math', () => {
  assert.equal(suffix('% \\begin{verbatim}\n$x^2+y^2$ $x^2|$'), '+y^2');
});

test('command reuse requires an actual command boundary', () => {
  assert.equal(suggest('$\\\\frac{x}{y}$ $\\fra|$'), null);
  assert.equal(suffix('$a\\frac{x}{y}$ $\\fra|$'), 'c{x}{y}');
});

test('partial braced index completion produces balanced final text with a paired brace', () => {
  const marked = '$x_{1}, x_{2|}$';
  const cursor = marked.indexOf('|');
  const text = marked.replace('|', '');
  const result = suggest(marked);
  assert.equal(text.slice(0, cursor) + result.insertText + text.slice(cursor), '$x_{1}, x_{2}, \\ldots, x_{n}$');
});

test("nearby bounds preserve supported offsets instead of dropping trailing arithmetic", () => {
  const lower = suggest("$x_i, 1 \\le i \\le n-1$\n$x_1,x_2|$");
  assert.equal(lower.insertText, ",\\ldots,x_{n-1}");
  assert.equal(lower.endpointSource, "nearby-bound");
  assert.equal(suffix("$x_j, j=1,\\ldots,m+1$\n$x_1,x_2|$"), ",\\ldots,x_{m+1}");
  assert.equal(suffix("$x_i, 1 \\leq i \\leq N - 2$\n$x_1,x_2|$"), ",\\ldots,x_{N - 2}");
});

test("unsupported nearby bound expressions cannot be truncated into false evidence", () => {
  for (const end of ["n-k", "n+1+k", "n^2", "n_{k}", "n/2", "n\\cdot 2", "2n", "10-1", "\\nu+1"]) {
    const result = suggest("$x_i, 1 \\le i \\le " + end + "$\n$x_1,x_2|$", { sequenceEnd: "M" });
    assert.equal(result.insertText, ",\\ldots,x_M", end);
    assert.equal(result.endpointSource, "configured", end);
  }
});

test('current item wins over more frequent formulas in other answers', () => {
  const marked = String.raw`\begin{enumerate}
\item $f(x)=x+1$ $f(x)=x+1$ $f(x)=x+1$
\item $f(x)=x+2$ Some reasoning. $f(x)|$
\item $f(x)=x+1$
\end{enumerate}`;
  assert.equal(suffix(marked), '=x+2');
});

test('subitems prefer their own notation, then parent, and exclude sibling evidence from the parent scope', () => {
  const start = String.raw`\begin{enumerate}\item $f(x)=x+1$
\begin{enumerate}\item $f(x)=x+2$`;
  assert.equal(suffix(start + ' $f(x)|$'), '=x+2');
  assert.equal(suffix(start + String.raw`\item $f(x)|$\end{enumerate}\end{enumerate}`), '=x+1');
  assert.equal(suffix(start + String.raw`\end{enumerate} $f(x)|$\end{enumerate}`), '=x+1');
});

test('an answer-local bound outweighs a complete indexed list from another item', () => {
  const marked = String.raw`\begin{enumerate}
\item $x_1,x_2,\ldots,x_N$
\item $x_i,1\le i\le m$ $x_1,x_2|$
\end{enumerate}`;
  const result = suggest(marked);
  assert.equal(result.insertText, ',\\ldots,x_m');
  assert.equal(result.endpointSource, 'nearby-bound');
});

test('scope changes after edits, and training collection shares the runtime math gate', () => {
  const engine = createEngine();
  for (const value of ['2', '3']) {
    const text = String.raw`\item $f(x)=x+1$\item $f(x)=x+` + value + '$ $f(x)';
    assert.equal(engine.suggest(text, text.length).insertText, '=x+' + value);
    const collection = engine.collectCandidates(text, text.length);
    assert.equal(collection.context.itemId, 2);
    assert.ok(collection.candidates.some((candidate) => candidate.insertText === '=x+' + value && candidate.itemTier === 2));
  }
  assert.equal(engine.collectCandidates('$a+b$ prose', 11), null);
  assert.equal(engine.isMathContext('$x+y$ after', 11), false);
});

test('no trained artifact is required for document prediction and invalid models preserve existing completions', () => {
  const engine = createEngine({ model: { schemaVersion: -1 } });
  assert.equal(engine.suggest('$x^2+y^2$ $x^2', 14)?.insertText, '+y^2');
});

test('masked prose does not turn a reused expression into a dangling operator suggestion', () => {
  const result = suggest('$x+a+\\text{hello}+b$ $x+a|$');
  assert.notEqual(result?.insertText.trim(), '+');
});


test('learned confidence cannot suppress document-supported formulas and sequences', () => {
  const Predictor = require('../extension/predictor.js');
  const artifact = { ...Predictor.createUntrainedArtifact(), trained:true,
    ranker: {features:[...Predictor.FEATURE_NAMES], weights:Predictor.FEATURE_NAMES.map(()=>0),
      means:Predictor.FEATURE_NAMES.map(()=>0), scales:Predictor.FEATURE_NAMES.map(()=>1), bias:-30},
    training:{recommendedThreshold:0.99} };
  assert.equal(Predictor.validateArtifact(artifact), true);
  for (const marked of ['$f(x)=x^2+1$ then $f(x)|$', '$\\{x_1,x_2|$']) {
    assert.equal(suffix(marked, {model:artifact}), suffix(marked));
  }
});

test('shared selection keeps item priority and applies confidence only to generated candidates', () => {
  const {selectCandidate} = require('../extension/engine.js');
  const reuse = {kind:'expression',itemTier:2,insertText:' + y',score:0.001,semanticScore:0,legacyScore:2};
  const generated = {kind:'prediction',itemTier:2,insertText:' + z',score:0.9,semanticScore:0};
  assert.equal(selectCandidate([generated,reuse],0.95), reuse);
  assert.equal(selectCandidate([generated],0.95), null);
  assert.equal(selectCandidate([generated],0.85), generated);
  const otherItem = {...reuse,itemTier:0};
  assert.equal(selectCandidate([otherItem,generated],0.85), generated);
  assert.equal(selectCandidate([otherItem,generated],0.95), otherItem);
});

test('trained selection ranks all providers while retaining scope and below-threshold reuse', () => {
  const { selectCandidate } = require('../extension/engine.js');
  const reuse = { insertText: 'reuse', kind: 'expression', score: 0.2, itemTier: 2, legacyScore: 100 };
  const generated = { insertText: 'generated', kind: 'prediction', score: 0.9, itemTier: 2 };
  const alternative = { insertText: 'other reuse', kind: 'expression', score: 0.7, itemTier: 2, legacyScore: 0 };
  assert.equal(selectCandidate([reuse, generated], 0.5, true), generated);
  assert.equal(selectCandidate([reuse, alternative], 0.5, true), alternative);
  assert.equal(selectCandidate([reuse, generated], 0.95, true), reuse);
  assert.equal(selectCandidate([reuse, { ...generated, itemTier: 0 }], 0.5, true), reuse);
  assert.equal(selectCandidate([reuse, generated], 0.5, false), reuse);
});

test('engine feedback uses displayed snapshots and clears calibration on model replacement', () => {
  const engine = createEngine();
  const text = '$x^2+y^2$ $x^2';
  const first = engine.suggest(text, text.length);
  assert.equal(engine.feedback(first, false), true);
  assert.equal(engine.calibrationState().updates, 1);
  const next = engine.suggest(text + ' ', text.length + 1);
  assert.equal(engine.calibrationState().updates, 1, 'Ordinary edits keep the document calibration');
  assert.ok(next);
  engine.setModel(Predictor.createUntrainedArtifact());
  assert.equal(engine.calibrationState().updates, 0);
  assert.equal(engine.feedback(next, true), false);
});

test('underscores reuse indices for the same base while respecting scope and braces', () => {
  assert.equal(suffix('$a_{i+1}$ and $x_{j,k}$ then $x_{|}$'), 'j,k');
  assert.equal(suffix('$x_{j,k}$ then $x_|$'), '{j,k}');
  const local='\\begin{enumerate}\\item $x_{k-1}$\\item $x_{j+1}$ then $x_{j+|}$\\end{enumerate}';
  assert.equal(suffix(local), '1');
  assert.equal(suggest('$x_{j,k}$ then prose x_{|}'), null);
});

test('classification uses declarations from the current answer and excludes future declarations', () => {
  const engine=createEngine();
  const group='\\begin{enumerate}\\item Let $G$ be a set.\\item Let $G$ be a group. $G';
  const context=engine.collectCandidates(group,group.length).context;
  assert.equal(context.classification.kind,'algebra');
  const before='$R';
  const future=before+'$ Let $R$ be a group.';
  assert.equal(engine.collectCandidates(future,before.length).context.classification.kind,'unknown');
  assert.equal(engine.collectCandidates('ordinary prose R',16),null);
});


test('partial unbraced index commands cannot reuse a composite braced argument', () => {
  for (const content of ['\\alpha+1','\\alpha_1']) {
    const text='$x_{'+content+'}$ then $x_\\al';
    const candidates=createEngine().collectCandidates(text,text.length).candidates;
    assert.ok(!candidates.some((candidate)=>candidate.kind==='index'),
      'a suffix cannot insert the missing opening brace before the typed command');
  }
  assert.equal(suffix('$x_{\\alpha}$ then $x_\\al|$'),'pha');
});


test('styled index bases share canonical parsing without conflating symbols', () => {
  assert.equal(suffix('$\\mathbb{R}_{i+1}$ then $\\mathbb R_{|}$'),'i+1');
  assert.equal(suffix('$\\mathbf{\\alpha}_{j,k}$ then $\\mathbf\\alpha_|$'),'{j,k}');
  const text='$R_{m+1}$ then $\\mathbb R_{';
  assert.ok(!createEngine().collectCandidates(text,text.length).candidates.some((candidate)=>candidate.kind==='index'));
});
