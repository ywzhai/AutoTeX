# Training AutoTeX

AutoTeX trains on local LaTeX documents. Training produces corpus statistics and learned ranking weights; `extension/model.js` identifies whether a trained artifact is installed. An untrained or invalid artifact retains the rule-based expression/sequence fallback and document-local behavior where supported.

Training runs offline with Node.js and uses the exact tokenizer, candidate providers, feature extraction, and artifact validator used by the extension. It requires no Python packages, GPU, service, or network connection. The trainer reads `.tex` files as text and never executes TeX, expands macros, or follows `\input` commands. Document source stays on the machine where training is run.

## Runtime behavior

- Completion activates only inside mathematical regions: `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and supported equation environments. Ordinary prose, comments, verbatim content, and prose commands such as `\text{...}` are excluded.
- The current `\item` means the body of the current list entry, from that `\item` to its next sibling or the end of its list. An optional `[label]` is a label, not the scope. Nested list entries receive their own scope; surrounding parent items are secondary context.
- Candidates supported by the current item have priority over parent-item and other-document candidates. This policy is enforced outside learned weights so training cannot remove it. Local counts also favor the current item when proposing token continuations.
- A bounded, smoothed token n-gram model proposes short continuations. A logistic-regression ranker scores the combined shortlist, including existing expression and indexed-sequence suggestions. Matching typed text continues consuming the displayed suggestion without requesting a new prediction.
- Corpus likelihood and local transition evidence are measured for every candidate, including reused formulas. With a trained artifact, learned scores choose among all eligible providers inside the winning item tier. Document-supported candidates remain eligible even below the generated-suggestion threshold.
- Corpus probabilities supply a prior before local evidence is available. Matching context counts from disjoint current-item, ancestor-item, and remaining-document buckets increase local influence as notation recurs. Unrelated local token volume does not drown a matching corpus context. The buckets avoid counting the same observation multiple times in the probability mixture.
- Tab acceptance and explicit Esc dismissal update a bounded logistic score correction around the trained ranker. Each displayed feature snapshot can update calibration only once, including after matching type-through. Navigation, blur, different typing, composition, and Undo supply no negative label. Ordinary edits and preference changes retain calibration; a new editor/document or model replacement resets it. Feedback is neither persisted nor added to the offline dataset.

Schema 3 stores the adaptation controls (`corpusPrior: 8`, `feedbackRate: 0.2`, `feedbackDecay: 0.98`, `feedbackLimit: 2`). These are engineering defaults, not parameters fitted by the trainer. Training learns the token probabilities, 18 ranking coefficients and bias, feature scaling, and validation display threshold. Those learned probabilities and scores establish the starting point for both document-content adaptation and feedback updates. Feedback features are clipped, corrections shrink toward the trained prior, and the total online logit correction is bounded to ±2.

## Arrange the dataset

By default, use this repository's `dataset/` directory. Files are discovered recursively, so a parent directory containing one folder per paper, each with `main.tex`, works directly without renaming or moving files. Repeated `main.tex` basenames remain distinct because the trainer uses relative paths; folder names and paths may contain spaces. A top-level directory represents one document family/project, so chapters and paper versions stay in the same split:

```text
dataset/
  algebra-paper/
    main.tex
    sections/proof.tex
  analysis-notes/
    chapter-1.tex
    chapter-2.tex
  geometry.tex
  probability.tex
```

Independent flat files are separate families. Do not place unrelated projects beneath a single extra wrapper directory when passing `--input`; point the command at their common parent instead. The trainer also groups identical mathematical content and related versions across directories. It retains variable names when comparing sequences of five consecutive math tokens, ignoring whitespace. Files are grouped when their unique-token-sequence Jaccard similarity is at least 85%, or when the smaller sequence set contains at least 100 distinct sequences and at least 90% of them also occur in the larger file, with an additional ordering check: the shorter document must have at least 10 math segments of five or more tokens, and at least 90% of those segments must appear in the same order in the longer document. The second rule keeps substantial excerpts and shorter revisions with their longer versions even when their overall lengths differ greatly. Non-identical documents remain in the corpus; grouping only keeps them in the same split. A handful of shared formulas does not meet the containment rule. Preparation/training metadata records these thresholds. These are conservative heuristics rather than a guarantee against every form of dataset leakage; inspect paper versions and templates before training.

At least **four distinct families** must remain after grouping: one each for the n-gram, ranker, validation, and test sets. Four is only a smoke-test minimum. Use substantially more varied documents to obtain meaningful results. Include the list-based answers, notation, and topics expected in actual use. Fragments without explicit math delimiters/environments are ignored rather than guessed to be mathematics. Each file is parsed independently, so math environments split across separate files are not reconstructed.

Use documents you are permitted to use. Model counts can retain sequences of training tokens; a model artifact is not a privacy-preserving summary. Training reports contain hashes and aggregate statistics, not source text. Do not publish an artifact trained on private documents without considering those retained sequences.

## Inspect and prepare

From the repository root:

```powershell
npm run model:prepare
```

This reads `dataset/` and writes `artifacts/prepared.json`, checks mathematical extraction, removes exact duplicates, and groups related documents into deterministic splits. It does **not** train or modify the extension. The output lists source/math hashes rather than document contents. Comments, verbatim regions, ordinary prose, and `\text` arguments do not become n-gram training sequences.

The default split is approximately 60% n-gram training, 20% ranker training, 10% validation, and 10% final test, allocated by document-family count. Very small corpora reserve at least one family per split. Family sizes can differ, so percentages of actual files/tokens can differ. The seed and input contents determine the split; adding/removing documents may change it.

## Train and evaluate

```powershell
npm run model:train
```

The command reads `dataset/` and produces:

- `artifacts/model.json`: schema version 3, tokenizer/classifier versions, pruned n-gram tables, 18-feature ranker coefficients/scaling, adaptation controls, and training provenance.
- `artifacts/model.report.json`: serialized JSON model size in bytes, split counts, and held-out simulated-typing metrics, including candidate coverage, matching/mismatching displays, and matching characters. Reports include per-category results (index, set, algebra, function, scalar, unknown), document-supported versus generated outcomes, first-formula (`cold`) versus later-formula (`warm`) results, an untrained baseline on the same test cursors, and the validation-only threshold curve.

Training proceeds as follows:

1. Count token sequences of orders 1–5 using only the n-gram split. The shared tokenizer preserves control words, individual ordinary math letters, digit runs, braces, and normalized whitespace. A bounded Misra–Gries pass selects candidate contexts across the full training split, then a second pass recounts their successors exactly. Selection is approximate, exported counts are exact, and later documents can introduce frequent contexts even after the working table fills. Prune rare context/successor counts to bound the artifact.
2. Classify the visible cursor context using deterministic syntax and scoped symbol evidence. The classifier is a small rules engine, not a separately trained neural network. It distinguishes object context from an unfinished subscript and adds category compatibility, index fit, and symbol-type compatibility to the original 15 ranking features.
3. Sample append cursors from the separate ranker split, including positions inside command words and multi-digit numbers. For each sample, give candidate generation **only the document prefix up to the cursor**. Hidden target text and all later text are absent from retrieval and local counts. Never index the hidden answer.
4. Label a candidate positive when its tokens match a prefix of the hidden continuation, ignoring ordinary whitespace. Collect the shared features from all candidate providers, including corpus/local likelihood for reused formulas. Fit feature means/scales on ranker examples only, then train an L2-regularized logistic model with deterministic stochastic gradient descent.
5. Install the fitted ranker into candidate generation before collecting validation/test examples, matching the deployed shortlist selection. Use the validation split to choose a display threshold for generated suggestions. Existing formula/sequence reuse and observed indices for the same base symbol bypass that learned gate; both the runtime and evaluator call the same selection helper. The current-item tier still takes precedence. The initial utility is matching characters minus 16 for each mismatching display; this is a tunable product choice, not a measured user-cost estimate.
6. Evaluate once on the separate test split using the chosen threshold. The test split never trains counts, coefficients, scaling, or the threshold.

If the ranker sees no positive or no negative examples, training fails with a clear error. Add varied documents or raise `--max-samples`; do not turn fabricated weights into a supposedly trained artifact. Validation/test documents must also produce candidates.

These are **simulated append** measurements. The `cold`/`warm` breakdown measures the initial trained scorer with different amounts of visible document text; no acceptance/rejection feedback is simulated. It does not establish the quality or probability calibration of later personalized scores. These metrics do not prove mathematical correctness, predict real Tab acceptance, or cover every middle-of-document edit. Existing browser tests cover editor integration; testing the trained artifact interactively on representative documents is still required. Evaluate cold startup, memory, and p50/p95 keystroke-to-visible latency separately on target laptops before distributing a model. The intended latency budget is a goal, not a benchmark result.

## Install a trained artifact

Once the report is acceptable, rerun training with a browser export:

```powershell
npm run model:train -- --browser-output "extension\model.js"
```

This replaces `extension/model.js` with a bundle exporting `AutoTexModel`. JSON remains the source artifact; the browser bundle has equivalent data and CommonJS support for tests. The tokenizer version, classifier version, and feature schema must match the runtime. Trained schema-1/2 artifacts are rejected and must be retrained because schema 3 changes feature evidence and selection; untrained schema-1/2 placeholders are accepted for migration. Reload the unpacked extension and refresh the Overleaf page after replacing the model. Run `npm test`, `npm run test:browser`, and `npm run package` before sharing a new package.

Keep a previous model in version history so you can restore it if retraining performs poorly. Do not commit the dataset by default; keep its location outside the repository or explicitly ignore it.

## Classifier scope and limitations

Type inference uses standard number-set notation, explicit declarations, membership and subset relations, function signatures, and index syntax. Plain letters carry no fixed type. Evidence is local and approximate: it does not prove a mathematical fact or expand arbitrary user macros. Mixed categories remain possible (for example, a group is also a set), so semantic differences normally change ranking rather than reject a completion. Only clear syntax violations are filtered.

The classifier executes before candidate selection and is bounded independently of corpus size. To add notation, extend the relevant detector in `extension/classifier.js` and add ambiguity, scope, and boundary regressions. If feature meanings change, bump the classifier version and retrain; adding ranking features also requires an artifact schema change. Use per-category validation results to identify weak cases, and reserve test results for final evaluation.

## Training controls

Run `node scripts/train-model.cjs --help` for all options. Omitted input/output paths are anchored to this repository, even if the script is invoked from another working directory. Explicit `--input` and `--output` paths still override them; quote paths containing spaces:

```powershell
npm run model:train -- --input "C:\other dataset" --output "artifacts\comparison.json" --seed 1729
```

The CLI prints stage names and aggregate counts during preparation/training, without printing document contents.

| Option | Default | Purpose |
| --- | ---: | --- |
| `--input` | `dataset/` | Recursive dataset directory |
| `--output` | `artifacts/model.json` | Model output; `artifacts/prepared.json` with `--prepare` |
| `--seed` | 1729 | Reproducible grouping assignment, sample selection, and optimization |
| `--order` | 5 | Maximum n-gram order; supported range 1–5 |
| `--min-count` | 2 | Prune rare counts |
| `--max-contexts` | 12000 | Bound the exported context table |
| `--max-successors` | 16 | Bound possible next tokens stored per context |
| `--max-samples` | 64 | Maximum sampled cursors per document |
| `--epochs` | 40 | Ranker optimization passes |
| `--max-document-bytes` | 5000000 | Fail clearly on unexpectedly large input files |

For a corpus of thousands of papers, `--max-samples 16` is a practical first run. This limits simulated cursors for ranking/evaluation only; n-gram counting still processes every token in the count-training split. Preparation uses compact shingle storage and exact similarity checks to keep project grouping within memory limits.

The candidate generator separately bounds its beam, completion length, and context budget for runtime speed. More training data need not mean a larger shipped model: retain pruning limits and compare held-out coverage against artifact size and browser latency. Increasing the number of epochs cannot compensate for missing useful candidates or an unrepresentative dataset.

## Verification

`tests/training.test.js` checks data extraction, duplicate/family isolation, deterministic preparation/training, ranker fitting, and JSON/browser export parity using temporary artificial fixtures. Those fixtures validate plumbing and are not a pretrained model or evidence of prediction quality.
