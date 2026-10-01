(function (root, factory) {
  const commonJS = typeof module === "object" && module.exports;
  const api = factory(commonJS ? require("./classifier.js") : root.AutoTexClassifier);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AutoTexPredictor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Classifier) {
  "use strict";

  const TOKENIZER_VERSION = "autotex-tex-v1";
  const SCHEMA_VERSION = 3;
  const CLASSIFIER_VERSION = "autotex-context-v1";
  const DEFAULT_ADAPTATION = Object.freeze({ version: 1, corpusPrior: 8,
    feedbackRate: 0.2, feedbackDecay: 0.98, feedbackLimit: 2 });
  const END_TOKEN = "<eos>";
  const FEATURE_NAMES = Object.freeze([
    "ngramLogProbability", "documentEvidence", "sameItemEvidence", "ancestorEvidence",
    "observedSymbolRatio", "prefixTokenCount", "tokenCount", "charCount", "sourceDistance",
    "sourceExpression", "sourceSequence", "sourceGrammar", "sourcePrediction",
    "balanced", "endsAtBoundary", "categoryMatch", "indexFit", "symbolTypeMatch",
  ]);
  const BASELINE_WEIGHTS = Object.freeze([0.7, 0.3, 0.7, 0.4, 1, 0.3, 0.8, 0.6, 0.4, 1.1, 1, 0.7, 0, 1, 0.8, 1.2, 2, 1.2]);
  const EMPTY_SEGMENTS = Object.freeze([]);
  const KNOWN_COMMANDS = new Set((
    "frac dfrac tfrac cfrac binom dbinom tbinom sqrt sum prod coprod int iint iiint oint lim limsup liminf " +
    "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp min max inf sup det dim ker " +
    "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi " +
    "rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma " +
    "Upsilon Phi Psi Omega infty partial nabla ell hbar imath jmath Re Im wp aleph emptyset varnothing " +
    "cdot times div pm mp circ ast star bullet cap cup uplus sqcap sqcup vee wedge setminus " +
    "le leq ge geq neq ne approx sim simeq equiv cong propto in notin ni subset subseteq supset supseteq " +
    "to rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow mapsto iff implies " +
    "forall exists nexists neg lnot land lor lnot top bot per pmod bmod mod " +
    "left right big Big bigg Bigg bigl bigr Bigl Bigr langle rangle lvert rvert lVert rVert vert Vert " +
    "ldots cdots dots vdots ddots overline underline bar hat widehat tilde widetilde vec dot ddot " +
    "mathbf mathbb mathcal mathfrak mathrm mathit mathsf mathtt boldsymbol bm operatorname text " +
    "overbrace underbrace overset underset stackrel quad qquad thinspace medspace thickspace " +
    "sin cos degree angle triangle square choose at atop not mid nmid gcd lcm " +
    "bigcup bigcap bigsqcup biguplus bigvee bigwedge dotsc dotsb dotsm"
  ).split(/\s+/).map((name) => "\\" + name));
  const BLOCKED_COMMANDS = new Set([
    "\\input", "\\include", "\\write", "\\openout", "\\read", "\\def", "\\gdef", "\\edef",
    "\\xdef", "\\newcommand", "\\renewcommand", "\\usepackage", "\\documentclass",
    "\\begin", "\\end", "\\label", "\\cite", "\\bibliography",
  ]);
  const ARITY = new Map([
    ["\\frac", 2], ["\\dfrac", 2], ["\\tfrac", 2], ["\\cfrac", 2],
    ["\\binom", 2], ["\\dbinom", 2], ["\\tbinom", 2],
    ["\\overset", 2], ["\\underset", 2], ["\\stackrel", 2],
    ["\\mathbf", 1], ["\\mathbb", 1], ["\\mathcal", 1], ["\\mathfrak", 1],
    ["\\mathrm", 1], ["\\mathit", 1], ["\\mathsf", 1], ["\\mathtt", 1],
    ["\\boldsymbol", 1], ["\\bm", 1], ["\\overline", 1], ["\\underline", 1],
    ["\\bar", 1], ["\\hat", 1], ["\\tilde", 1], ["\\vec", 1], ["\\not", 1],
  ]);
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const contextKey = (tokens) => JSON.stringify(tokens);
  const controlWord = (token) => /^\\[A-Za-z]+$/.test(token);
  const mathDelimiter = (token) => token === "$" || /^\\[()[\]]$/.test(token);
  const symbolToken = (token) => /^[A-Za-z]$/.test(token) || controlWord(token);
  const tokenOK = (token) => typeof token === "string" && token.length > 0 && token.length <= 128 &&
    !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(token);

  function tokenize(text) {
    if (typeof text !== "string") return [];
    const result = [];
    let position = 0;
    while (position < text.length) {
      const start = position;
      const character = text[position];
      let value;
      if (character === "\r" || character === "\n") {
        position += character === "\r" && text[position + 1] === "\n" ? 2 : 1;
        value = "\n";
      } else if (/[ \t\f\v]/.test(character)) {
        while (position < text.length && /[ \t\f\v]/.test(text[position])) position++;
        value = " ";
      } else if (character === "\\") {
        position++;
        if (/[A-Za-z]/.test(text[position] || "")) {
          while (position < text.length && /[A-Za-z]/.test(text[position])) position++;
        } else if (position < text.length) {
          position += String.fromCodePoint(text.codePointAt(position)).length;
        }
        value = text.slice(start, position);
      } else if (/\d/.test(character)) {
        while (position < text.length && /\d/.test(text[position])) position++;
        value = text.slice(start, position);
      } else {
        position += String.fromCodePoint(text.codePointAt(position)).length;
        value = text.slice(start, position);
      }
      result.push({ value, start, end: position });
    }
    return result;
  }

  function buildNgrams(segments, options = {}) {
    const order = clamp(Math.trunc(finite(options.order, 5)), 1, 5);
    const smoothing = clamp(finite(options.smoothing, 3), 0.01, 1000);
    const maxContexts = clamp(Math.trunc(finite(options.maxContexts, 12000)), 1, 100000);
    const maxSuccessors = clamp(Math.trunc(finite(options.maxSuccessors, 32)), 1, 128);
    const minCount = Math.max(1, Math.trunc(finite(options.minCount, 1)));
    // Offline training can explicitly process a full corpus; browser callers
    // always pass their smaller bounded token budgets below.
    let remaining = clamp(Math.trunc(finite(options.maxTokens, 50000)), 1, Number.MAX_SAFE_INTEGER);
    const entries = new Map();
    for (const segment of Array.isArray(segments) ? segments : []) {
      if (remaining <= 0) break;
      const text = typeof segment === "string" ? segment : segment?.text;
      if (typeof text !== "string") continue;
      const allTokens = tokenize(text).map((token) => token.value);
      if (allTokens.some((token) => !tokenOK(token))) continue;
      const tokens = allTokens.slice(0, remaining);
      remaining -= tokens.length;
      if (tokens.length === allTokens.length) tokens.push(END_TOKEN);
      for (let position = 0; position < tokens.length; position++) {
        for (let length = 0; length < order && length <= position; length++) {
          const context = tokens.slice(position - length, position);
          const key = contextKey(context);
          let entry = entries.get(key);
          if (!entry) {
            if (entries.size >= maxContexts * 4 && length > 0) continue;
            entry = { context, total: 0, next: new Map() };
            entries.set(key, entry);
          }
          entry.total++;
          entry.next.set(tokens[position], (entry.next.get(tokens[position]) || 0) + 1);
        }
      }
    }
    const contexts = [...entries.values()]
      .filter((entry) => entry.context.length === 0 || entry.total >= minCount)
      .sort((a, b) => (a.context.length === 0 ? -1 : b.context.length === 0 ? 1 : b.total - a.total) ||
        contextKey(a.context).localeCompare(contextKey(b.context)))
      .slice(0, maxContexts)
      .map((entry) => ({
        context: entry.context,
        total: entry.total,
        next: [...entry.next.entries()]
          .filter((pair) => pair[1] >= minCount || entry.context.length === 0)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, maxSuccessors),
      }))
      .filter((entry) => entry.next.length > 0);
    return { order, smoothing, contexts };
  }

  function validNgrams(model) {
    if (!model || !Number.isInteger(model.order) || model.order < 1 || model.order > 5 ||
        !Number.isFinite(model.smoothing) || model.smoothing <= 0 || model.smoothing > 1000 ||
        !Array.isArray(model.contexts) || model.contexts.length > 100000) return false;
    const seen = new Set();
    for (const entry of model.contexts) {
      if (!entry || !Array.isArray(entry.context) || entry.context.length >= model.order ||
          !entry.context.every(tokenOK) || entry.context.includes(END_TOKEN) ||
          !Number.isSafeInteger(entry.total) || entry.total <= 0 || entry.total > 1000000000 ||
          !Array.isArray(entry.next) || entry.next.length === 0 || entry.next.length > 128) return false;
      const key = contextKey(entry.context);
      if (seen.has(key)) return false;
      seen.add(key);
      const successors = new Set();
      let total = 0;
      for (const pair of entry.next) {
        if (!Array.isArray(pair) || pair.length !== 2 || !tokenOK(pair[0]) || successors.has(pair[0]) ||
            !Number.isSafeInteger(pair[1]) || pair[1] <= 0) return false;
        total += pair[1];
        successors.add(pair[0]);
      }
      if (total > entry.total) return false;
    }
    return model.contexts.length === 0 || seen.has("[]");
  }

  function validateArtifact(artifact) {
    if (!artifact || typeof artifact.trained !== "boolean" ||
        artifact.tokenizerVersion !== TOKENIZER_VERSION) return false;
    // Untrained v1/v2 placeholders can migrate. Trained older artifacts need
    // retraining because their feature evidence and selection policy differ.
    const legacyUntrained = [1, 2].includes(artifact.schemaVersion) && !artifact.trained && artifact.ranker == null;
    if (!legacyUntrained && (artifact.schemaVersion !== SCHEMA_VERSION ||
        artifact.classifierVersion !== CLASSIFIER_VERSION)) return false;
    if (!(artifact.ngrams == null && !artifact.trained) && !validNgrams(artifact.ngrams)) return false;
    if (!legacyUntrained) {
      const adaptation = artifact.adaptation;
      if (!adaptation || adaptation.version !== 1 ||
          !Number.isFinite(adaptation.corpusPrior) || adaptation.corpusPrior <= 0 || adaptation.corpusPrior > 1000 ||
          !Number.isFinite(adaptation.feedbackRate) || adaptation.feedbackRate <= 0 || adaptation.feedbackRate > 1 ||
          !Number.isFinite(adaptation.feedbackDecay) || adaptation.feedbackDecay <= 0 || adaptation.feedbackDecay > 1 ||
          !Number.isFinite(adaptation.feedbackLimit) || adaptation.feedbackLimit <= 0 || adaptation.feedbackLimit > 4) return false;
    }
    const ranker = artifact.ranker;
    if (ranker == null) return artifact.trained === false;
    if (!Array.isArray(ranker.features) || ranker.features.length !== FEATURE_NAMES.length ||
        !ranker.features.every((feature, index) => feature === FEATURE_NAMES[index]) ||
        !Number.isFinite(ranker.bias)) return false;
    for (const key of ["weights", "means", "scales"]) {
      if (!Array.isArray(ranker[key]) || ranker[key].length !== FEATURE_NAMES.length ||
          !ranker[key].every((value) => Number.isFinite(value) && Math.abs(value) <= 1000000 &&
            (key !== "scales" || value > 0))) return false;
    }
    return true;
  }

  function createUntrainedArtifact(ngrams = buildNgrams([])) {
    return { schemaVersion: SCHEMA_VERSION, trained: false, tokenizerVersion: TOKENIZER_VERSION,
      classifierVersion: CLASSIFIER_VERSION, ngrams, ranker: null, adaptation: { ...DEFAULT_ADAPTATION } };
  }

  function indexModel(model) {
    const entries = new Map(model.contexts.map((entry) => [
      contextKey(entry.context), { total: entry.total, next: new Map(entry.next) },
    ]));
    const cached = new Map();
    return {
      distribution(history) {
        const key = contextKey(history.slice(-(model.order - 1 || history.length)));
        if (cached.has(key)) return cached.get(key);
        let probabilities = new Map();
        let support = new Map();
        let unigramSupport = new Map();
        let total = 0, unigramTotal = 0;
        let longest = 0;
        for (let size = 0; size < model.order && size <= history.length; size++) {
          const suffix = size ? history.slice(-size) : [];
          const entry = entries.get(contextKey(suffix));
          if (!entry) continue;
          if (size === 0) { unigramSupport = entry.next; unigramTotal = entry.total; }
          const weight = size === 0 ? 1 : entry.total / (entry.total + model.smoothing);
          probabilities = new Map([...probabilities].map(([token, probability]) => [token, probability * (1 - weight)]));
          for (const [token, count] of entry.next) {
            probabilities.set(token, (probabilities.get(token) || 0) + weight * count / entry.total);
          }
          if (size > 0 && suffix.some((token) => token !== " " && token !== "\n")) {
            longest = size;
            total = entry.total;
            support = new Map(entry.next);
          }
        }
        const result = { probabilities, support, unigramSupport, longest, total, unigramTotal };
        if (cached.size > 2000) cached.clear();
        cached.set(key, result);
        return result;
      },
    };
  }

  function braceBalance(text) {
    let depth = 0;
    for (const token of tokenize(text)) {
      if (token.value === "{") depth++;
      else if (token.value === "}" && --depth < 0) return -1;
    }
    return depth;
  }

  function knownTokens(context) {
    const tokens = new Set(tokenize(context.prefix || "").map((token) => token.value));
    for (const segment of Array.isArray(context.segments) ? context.segments : []) {
      for (const token of tokenize(segment?.text || "")) tokens.add(token.value);
    }
    return tokens;
  }

  function commandsHaveArguments(tokens) {
    function skipSpace(position) {
      while (position < tokens.length && (tokens[position] === " " || tokens[position] === "\n")) position++;
      return position;
    }
    function groupEnd(position) {
      if (position >= tokens.length) return -1;
      if (tokens[position] !== "{") return /^(?:[}_^=+*\/-]|\\(?:left|right))$/.test(tokens[position]) ? -1 : position + 1;
      let depth = 1;
      for (let i = position + 1; i < tokens.length; i++) {
        if (tokens[i] === "{") depth++;
        else if (tokens[i] === "}" && --depth === 0) return i + 1;
      }
      return -1;
    }
    for (let position = 0; position < tokens.length; position++) {
      let arity = ARITY.get(tokens[position]) || 0;
      let argument = position + 1;
      while (arity-- > 0) {
        argument = groupEnd(skipSpace(argument));
        if (argument < 0) return false;
      }
    }
    return true;
  }

  function validateCandidate(candidate, context = {}) {
    const fullText = typeof candidate === "string" ? candidate : candidate?.fullText ?? candidate?.insertText;
    if (typeof fullText !== "string" || !fullText.trim() || fullText.length > 600 || /[\r\n\u0000-\u0008\u000b-\u001f]/.test(fullText)) return false;
    const prefix = typeof context.prefix === "string" ? context.prefix : "";
    const combined = prefix + fullText;
    if (tokenize(combined).some((token) => token.end > prefix.length &&
        (mathDelimiter(token.value) || token.value === "%"))) return false;
    if (braceBalance(combined) !== 0 || /(?:[_^=+*/\\-]|\\[A-Za-z]+)$/.test(combined.trimEnd())) {
      // A complete, known symbol command may safely end an expression.
      const last = tokenize(combined).filter((token) => token.value !== " ").at(-1)?.value;
      if (braceBalance(combined) !== 0 || !controlWord(last || "") || ARITY.has(last) ||
          /^(?:\\(?:frac|sqrt|sum|prod|int|left|right))$/.test(last)) return false;
    }
    const observed = context.observedTokens instanceof Set ? context.observedTokens : knownTokens(context);
    const suffixTokens = tokenize(combined);
    for (const token of suffixTokens) {
      if (!controlWord(token.value)) continue;
      if (BLOCKED_COMMANDS.has(token.value) || (!KNOWN_COMMANDS.has(token.value) && !observed.has(token.value))) return false;
    }
    return commandsHaveArguments(suffixTokens.map((token) => token.value));
  }

  function classifiedContext(context) {
    if (context.classification || !Classifier?.analyze) return context;
    return { ...context, classification: Classifier.analyze(context) };
  }

  function featureValues(candidate, context = {}) {
    context = classifiedContext(context);
    const fullText = candidate.fullText ?? candidate.insertText ?? "";
    const tokens = tokenize(fullText).filter((token) => token.value !== " " && token.value !== "\n");
    const observed = context.observedTokens instanceof Set ? context.observedTokens : knownTokens(context);
    const symbols = tokens.filter((token) => symbolToken(token.value));
    const candidateKind = candidate.kind || "";
    const values = {
      ngramLogProbability: clamp(finite(candidate.ngramLogProbability, -3), -30, 0),
      documentEvidence: Math.log1p(Math.max(0, finite(candidate.documentEvidence))),
      sameItemEvidence: Math.log1p(Math.max(0, finite(candidate.sameItemEvidence, finite(candidate.features?.sameItem)))),
      ancestorEvidence: Math.log1p(Math.max(0, finite(candidate.ancestorEvidence, finite(candidate.features?.parentItem)))),
      observedSymbolRatio: symbols.length ? symbols.filter((token) => observed.has(token.value)).length / symbols.length : 1,
      prefixTokenCount: Math.min(20, tokenize(context.prefix || "").length) / 20,
      tokenCount: Math.min(32, tokens.length) / 32,
      charCount: Math.min(256, fullText.length) / 256,
      sourceDistance: Number.isFinite(candidate.position) && Number.isFinite(context.cursor) ?
        1 / (1 + Math.abs(candidate.position - context.cursor) / 1000) : 0,
      sourceExpression: candidateKind === "expression" ? 1 : 0,
      sourceSequence: candidateKind === "sequence" ? 1 : 0,
      sourceGrammar: candidateKind === "grammar" ? 1 : 0,
      sourcePrediction: candidateKind === "prediction" ? 1 : 0,
      balanced: braceBalance((context.prefix || "") + fullText) === 0 ? 1 : 0,
      endsAtBoundary: candidate.endsAtBoundary ? 1 : 0,
    };
    // Contextual features must be refreshed when a candidate is reranked after
    // the cursor moves; previous rank() output is not current evidence.
    const semantic = Classifier?.candidateFeatures ? Classifier.candidateFeatures(candidate, context) : {};
    for (const name of ["categoryMatch", "indexFit", "symbolTypeMatch"]) {
      values[name] = clamp(finite(semantic[name]), -1, 1);
    }
    return FEATURE_NAMES.map((name, index) => index >= 15 ? values[name] : finite(candidate.features?.[name], values[name]));
  }

  function trimRightOverlap(text, right) {
    for (let count = Math.min(text.length, right.length); count > 0; count--) {
      if (text.endsWith(right.slice(0, count))) return text.slice(0, -count);
    }
    return text;
  }

  function tierFor(candidate, context) {
    if (Number.isInteger(candidate.itemTier)) return clamp(candidate.itemTier, 0, 2);
    if (Number.isInteger(candidate.scopeTier)) return clamp(candidate.scopeTier, 0, 2);
    if (candidate.features?.sameItem) return 2;
    if (candidate.features?.parentItem) return 1;
    const item = candidate.sourceItemId ?? candidate.itemId;
    if (item != null && item === context.itemId) return 2;
    if (item != null && (context.ancestorIds || []).includes(item)) return 1;
    return 0;
  }

  function createPredictor(suppliedArtifact) {
    const artifact = suppliedArtifact === undefined ? createUntrainedArtifact() : suppliedArtifact;
    const valid = validateArtifact(artifact);
    const corpus = valid ? indexModel(artifact.ngrams || buildNgrams([])) : null;
    const hasCorpus = valid && (artifact.ngrams?.contexts.length || 0) > 0;
    const adaptation = valid && artifact.adaptation || DEFAULT_ADAPTATION;
    let localCache = new WeakMap();
    let evidenceCache = new WeakMap();
    let recentSignature;
    let recentModels;
    let feedbackSnapshots = new WeakSet();
    let updates = 0, onlineBias = 0;
    let onlineWeights = FEATURE_NAMES.map(() => 0);

    function localModels(context) {
      const segments = Array.isArray(context.segments) ? context.segments : EMPTY_SEGMENTS;
      let cached = localCache.get(segments);
      if (!cached) {
        // Edits in the excluded active row often produce a new segment array
        // with identical evidence. Offsets do not affect token counts.
        const signature = JSON.stringify(segments.map((segment) => [segment?.itemId ?? null, segment?.text || ""]));
        if (signature === recentSignature) cached = recentModels;
        else {
          const modelOptions = { order: 5, maxContexts: 6000, maxSuccessors: 24, maxTokens: 30000 };
          cached = {
            global: indexModel(buildNgrams(segments, modelOptions)),
            scopes: new Map(),
            observedTokens: knownTokens({ segments }),
          };
          recentSignature = signature;
          recentModels = cached;
        }
        localCache.set(segments, cached);
      }
      const scopeKey = JSON.stringify([context.itemId ?? null, context.ancestorIds || []]);
      if (!cached.scopes.has(scopeKey)) {
        const options = { maxContexts: 3000, maxSuccessors: 24, maxTokens: 15000 };
        const current = context.itemId == null ? [] : segments.filter((segment) => segment.itemId === context.itemId);
        const ancestors = new Set(context.ancestorIds || []);
        cached.scopes.set(scopeKey, {
          mixed: new Map(),
          current: indexModel(buildNgrams(current, options)),
          ancestors: indexModel(buildNgrams(segments.filter((segment) => ancestors.has(segment.itemId)), options)),
          // Disjoint buckets prevent counting a current-item observation again as
          // both ancestor and document evidence when interpolating probabilities.
          other: context.itemId == null && !ancestors.size ? cached.global :
            indexModel(buildNgrams(segments.filter((segment) => segment.itemId !== context.itemId &&
              !ancestors.has(segment.itemId)), options)),
        });
      }
      return { ...cached.scopes.get(scopeKey), global: cached.global, observedTokens: cached.observedTokens };
    }

    function nextDistribution(history, models) {
      const key = contextKey(history.slice(-4));
      if (models.mixed.has(key)) return models.mixed.get(key);
      const distributions = [models.current, models.ancestors, models.global, corpus].map((model) =>
        model ? model.distribution(history) : { probabilities: new Map(), support: new Map(),
          unigramSupport: new Map(), longest: 0, total: 0, unigramTotal: 0 });
      let sources = distributions;
      let weights = [0.5, 0.2, 0.2, 0.1];
      if (hasCorpus || valid && artifact.trained) {
        sources = [distributions[0], distributions[1], models.other.distribution(history), distributions[3]];
        const support = (entry) => entry.longest ? entry.total : history.length ? 0 : entry.unigramTotal;
        // Corpus probabilities form a prior of fixed strength. Matching evidence
        // in this document gradually outweighs that prior; unrelated tokens do not.
        weights = [4 * support(sources[0]), 2 * support(sources[1]), support(sources[2]), adaptation.corpusPrior];
      }
      const probabilities = new Map();
      let mass = 0;
      sources.forEach((entry, index) => {
        if (!entry.probabilities.size || !weights[index]) return;
        const sum = [...entry.probabilities.values()].reduce((a, b) => a + b, 0);
        if (!(sum > 0)) return;
        mass += weights[index];
        for (const [token, probability] of entry.probabilities) {
          probabilities.set(token, (probabilities.get(token) || 0) + weights[index] * probability / sum);
        }
      });
      for (const [token, probability] of probabilities) probabilities.set(token, probability / (mass || 1));
      const result = { probabilities, distributions };
      if (models.mixed.size >= 2000) models.mixed.clear();
      models.mixed.set(key, result);
      return result;
    }

    function prepareCandidates(candidates, context = {}) {
      if (!hasCorpus || !Array.isArray(candidates)) return candidates;
      let cached = evidenceCache.get(context);
      if (!cached) { cached = new Map(); evidenceCache.set(context, cached); }
      const models = localModels(context);
      const prefix = context.prefix || "";
      return candidates.map((candidate) => {
        const fullText = candidate?.fullText ?? candidate?.insertText;
        if (typeof fullText !== "string") return candidate;
        let evidence = cached.get(fullText);
        if (!evidence) {
          // Tokenize prefix+suffix together, including cursors inside a command.
          const tokens = tokenize(prefix + fullText);
          let history = tokens.filter((token) => token.end <= prefix.length).map((token) => token.value).slice(-4);
          const suffix = tokens.filter((token) => token.end > prefix.length).slice(0, 32);
          let logProbability = 0, documentEvidence = 0, sameItemEvidence = 0, ancestorEvidence = 0;
          for (const { value } of suffix) {
            const next = nextDistribution(history, models);
            logProbability += Math.log(Math.max(next.probabilities.get(value) || 0, 1e-12));
            const support = next.distributions.map((entry) => entry.longest ? entry.support.get(value) || 0 : 0);
            sameItemEvidence += support[0];
            ancestorEvidence += support[1];
            documentEvidence += support[2];
            history = [...history, value].slice(-4);
          }
          const count = Math.max(1, suffix.length);
          evidence = { ngramLogProbability: logProbability / count,
            documentEvidence: documentEvidence / count, sameItemEvidence: sameItemEvidence / count,
            ancestorEvidence: ancestorEvidence / count };
          cached.set(fullText, evidence);
        }
        // Keep candidate properties in raw units; featureValues applies logs once.
        const features = { ...candidate.features };
        for (const name of Object.keys(evidence)) delete features[name];
        return { ...candidate, ...evidence, features };
      });
    }

    function feedback(candidate, accepted) {
      const snapshot = candidate?._feedback;
      if (typeof accepted !== "boolean" || !snapshot || !feedbackSnapshots.has(snapshot)) return false;
      feedbackSnapshots.delete(snapshot);
      const residual = clamp(onlineBias + snapshot.features.reduce((sum, value, at) =>
        sum + onlineWeights[at] * value, 0), -adaptation.feedbackLimit, adaptation.feedbackLimit);
      const probability = 1 / (1 + Math.exp(-clamp(snapshot.baseLogit + residual, -40, 40)));
      const error = Number(accepted) - probability;
      const norm = 1 + snapshot.features.reduce((sum, value) => sum + value * value, 0);
      onlineBias = clamp(adaptation.feedbackDecay * onlineBias + adaptation.feedbackRate * error,
        -adaptation.feedbackLimit, adaptation.feedbackLimit);
      onlineWeights = onlineWeights.map((weight, at) => clamp(adaptation.feedbackDecay * weight +
        adaptation.feedbackRate * error * snapshot.features[at] / norm, -adaptation.feedbackLimit, adaptation.feedbackLimit));
      updates++;
      return true;
    }

    function calibrationState() {
      return { updates, bias: onlineBias, weightNorm: Math.hypot(...onlineWeights) };
    }

    function rank(candidates, context = {}) {
      if (!Array.isArray(candidates)) return [];
      const observedContext = classifiedContext({ ...context, observedTokens: context.observedTokens || knownTokens(context) });
      const model = valid && artifact.trained ? artifact.ranker : null;
      return prepareCandidates(candidates, context).filter((candidate) => candidate && typeof candidate.insertText === "string").map((candidate) => {
        const values = featureValues(candidate, observedContext);
        let raw = model ? model.bias : -0.5;
        for (let index = 0; index < values.length; index++) {
          raw += model ? model.weights[index] * (values[index] - model.means[index]) / model.scales[index] :
            BASELINE_WEIGHTS[index] * values[index];
        }
        const normalized = values.map((value, at) => clamp(model ? (value - model.means[at]) / model.scales[at] : value, -3, 3));
        const snapshot = Object.freeze({ features: Object.freeze(normalized), baseLogit: raw });
        feedbackSnapshots.add(snapshot);
        const residual = clamp(onlineBias + normalized.reduce((sum, value, at) => sum + onlineWeights[at] * value, 0),
          -adaptation.feedbackLimit, adaptation.feedbackLimit);
        const score = 1 / (1 + Math.exp(-clamp(raw + residual, -40, 40)));
        const tier = tierFor(candidate, context);
        return { ...candidate, features: { ...candidate.features,
          ...Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, values[index]])),
          sameItem: tier === 2 ? 1 : 0, parentItem: tier === 1 ? 1 : 0 },
          scopeTier: tier, itemTier: tier, score, _feedback: snapshot };
      }).sort((a, b) => b.scopeTier - a.scopeTier || b.score - a.score ||
        b.insertText.length - a.insertText.length || a.insertText.localeCompare(b.insertText));
    }

    function candidates(context = {}) {
      if (!valid || typeof context.prefix !== "string" || !context.prefix.trim()) return [];
      context = classifiedContext(context);
      const prefix = context.prefix;
      const right = typeof context.right === "string" ? context.right : "";
      const maxTokens = clamp(Math.trunc(finite(context.maxTokens, 12)), 1, 32);
      const maxCandidates = clamp(Math.trunc(finite(context.maxCandidates, 6)), 1, 16);
      const models = localModels(context);
      const observedTokens = new Set(models.observedTokens);
      for (const token of tokenize(prefix)) observedTokens.add(token.value);
      const validationContext = { ...context, observedTokens };
      const prefixTokens = tokenize(prefix).map((token) => token.value);
      const last = prefixTokens.at(-1);
      const partial = last && /^(?:\\[A-Za-z]*|\d+)$/.test(last) && !/[ \t\r\n]$/.test(prefix) ? last : null;
      const initial = { history: prefixTokens, suffix: "", logProbability: 0, count: 0,
        tier: 2, documentEvidence: 0, sameItemEvidence: 0, ancestorEvidence: 0 };
      let beams = [initial];
      if (partial) beams.push({ ...initial, history: prefixTokens.slice(0, -1), partial });
      const found = new Map();
      const beamWidth = Math.min(4, maxCandidates * 2);

      function nextOptions(beam) {
        const mixed = nextDistribution(beam.history, models);
        const { distributions } = mixed;
        if (!distributions.some((entry) => entry.longest > 0) && !(beam.partial && beam.history.length === 0)) return [];
        const tokens = mixed.probabilities.keys();
        const options = [];
        const historyText = prefix + beam.suffix;
        let totalProbability = 0;
        for (const token of tokens) {
          if (token === "\n" || token === "\\\\" || token === "\\" || token === "%" || mathDelimiter(token) ||
              (beam.partial && (!token.startsWith(beam.partial) || token === beam.partial))) continue;
          if (controlWord(token) && (BLOCKED_COMMANDS.has(token) ||
              (!KNOWN_COMMANDS.has(token) && !observedTokens.has(token)))) continue;
          const support = distributions.map((entry) => entry.longest ? entry.support.get(token) || 0 :
            beam.partial && beam.history.length === 0 ? entry.unigramSupport.get(token) || 0 : 0);
          const level = support[0] ? 2 : support[1] ? 1 : 0;
          let probability = mixed.probabilities.get(token) || 0;
          // A bounded soft preference guides the beam without forbidding mixed
          // operations such as intersections of groups or sets of scalars.
          if (Classifier?.tokenWeight && token !== END_TOKEN && token !== " ") {
            probability *= clamp(finite(Classifier.tokenWeight(token, historyText, context.classification), 1), 0.5, 2);
          }
          if (probability > 0) {
            totalProbability += probability;
            options.push({ token, probability, tier: level, support });
          }
        }
        for (const option of options) option.probability /= totalProbability || 1;
        return options.sort((a, b) => b.tier - a.tier || b.probability - a.probability ||
          a.token.localeCompare(b.token)).slice(0, 6);
      }

      function remember(beam, boundary) {
        if (!beam.suffix.trim() || /\s$/.test(beam.suffix) || !validateCandidate({ fullText: beam.suffix }, validationContext)) return;
        const insertText = trimRightOverlap(beam.suffix, right);
        if (!insertText.trim()) return;
        // Never splice a predicted token into an unrelated existing token.
        if (insertText === beam.suffix && /^[A-Za-z0-9_]/.test(right)) return;
        const candidate = {
          insertText, fullText: beam.suffix, kind: "prediction", scopeTier: beam.tier,
          ngramLogProbability: beam.logProbability / Math.max(1, beam.count),
          documentEvidence: beam.documentEvidence / Math.max(1, beam.count),
          sameItemEvidence: beam.sameItemEvidence / Math.max(1, beam.count),
          ancestorEvidence: beam.ancestorEvidence / Math.max(1, beam.count),
          endsAtBoundary: boundary,
        };
        const old = found.get(insertText);
        if (!old || candidate.scopeTier > old.scopeTier ||
            (candidate.scopeTier === old.scopeTier && candidate.ngramLogProbability > old.ngramLogProbability)) found.set(insertText, candidate);
      }

      for (let depth = 0; depth < maxTokens && beams.length; depth++) {
        const expanded = [];
        for (const beam of beams) {
          for (const option of nextOptions(beam)) {
            if (option.token === END_TOKEN) {
              if (!beam.partial) remember(beam, true);
              continue;
            }
            let addition = beam.partial ? option.token.slice(beam.partial.length) : option.token;
            if (!beam.partial && controlWord(beam.history.at(-1) || "") && /^[A-Za-z]/.test(addition)) addition = " " + addition;
            if (addition === " " && /[ \t]$/.test(prefix + beam.suffix)) continue;
            const next = {
              history: [...beam.history, option.token].slice(-4),
              suffix: beam.suffix + addition,
              logProbability: beam.logProbability + Math.log(Math.max(option.probability, 1e-12)),
              count: beam.count + 1,
              tier: option.token === " " ? beam.tier : Math.min(beam.tier, option.tier),
              documentEvidence: beam.documentEvidence + option.support[2],
              sameItemEvidence: beam.sameItemEvidence + option.support[0],
              ancestorEvidence: beam.ancestorEvidence + option.support[1],
            };
            if (next.suffix.length > 400 || braceBalance(prefix + next.suffix) < 0) continue;
            remember(next, false);
            expanded.push(next);
          }
        }
        const unique = new Map();
        for (const beam of expanded) {
          const old = unique.get(beam.suffix);
          if (!old || beam.logProbability > old.logProbability) unique.set(beam.suffix, beam);
        }
        beams = [...unique.values()].sort((a, b) => b.tier - a.tier ||
          b.logProbability / b.count - a.logProbability / a.count).slice(0, beamWidth);
      }
      return rank([...found.values()], validationContext).slice(0, maxCandidates);
    }

    return { valid, trained: valid && artifact.trained, candidates, rank, prepareCandidates, feedback, calibrationState,
      reset() {
        localCache = new WeakMap(); evidenceCache = new WeakMap(); recentSignature = undefined; recentModels = undefined;
        feedbackSnapshots = new WeakSet(); updates = 0; onlineBias = 0; onlineWeights = FEATURE_NAMES.map(() => 0);
      } };
  }

  return {
    TOKENIZER_VERSION, tokenizerVersion: TOKENIZER_VERSION, SCHEMA_VERSION, CLASSIFIER_VERSION, END_TOKEN, DEFAULT_ADAPTATION,
    FEATURE_NAMES, featureNames: FEATURE_NAMES, tokenize, buildNgrams,
    validateArtifact, createUntrainedArtifact, validateCandidate, featureValues, createPredictor,
  };
});
