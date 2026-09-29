'use strict';
const { performance } = require('node:perf_hooks');
const { createEngine } = require('../extension/engine.js');
const model = require('../extension/model.js');

// Measures the complete engine call on changing text, not cached repeated calls.
// This excludes browser rendering, scheduling, and hardware variation.
const rows = [];
for (const itemCount of [20, 500, 2000]) {
  const engine = createEngine();
  const body = '\\begin{enumerate}\n' + Array.from({ length: itemCount }, (_, i) =>
    '\\item Answer ' + i + ': $a_{' + i + '}=' + i + '+1$\n').join('') +
    '\\item $f(x)=x^2+1$\n';
  const times = [];
  let coldMs;
  for (let i = 0; i < 26; i++) {
    const text = body + 'Pass ' + i + '. $f(x)';
    const start = performance.now();
    engine.suggest(text, text.length);
    const duration = performance.now() - start;
    if (i === 0) coldMs = duration;
    else times.push(duration);
  }
  times.sort((a, b) => a - b);
  rows.push({ items: itemCount, characters: body.length, firstCallMs: +coldMs.toFixed(2),
    p50Ms: +times[Math.floor(times.length * 0.5)].toFixed(2),
    p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2) });
}
console.log(JSON.stringify({ trained: model.trained, metric: 'Node engine computation on changed documents; excludes editor delay/rendering', results: rows }, null, 2));
