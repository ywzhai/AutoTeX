# Training AutoTeX

AutoTeX is ready for a user-supplied collection of LaTeX documents. The checked-in model is explicitly **untrained**: it contains no fabricated corpus statistics or learned ranking weights. Before training, document-local predictions and the existing expression/sequence providers remain available.

Training runs offline with Node.js and uses the exact tokenizer, candidate providers, feature extraction, and artifact validator used by the extension. It requires no Python packages, GPU, service, or network connection. The trainer reads `.tex` files as text and never executes TeX, expands macros, or follows `\input` commands. Document source stays on the machine where training is run.

## Runtime behavior

- Completion activates only inside mathematical regions: `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and supported equation environments. Ordinary prose, comments, verbatim content, and prose commands such as `\text{...}` are excluded.
- The current `\item` means the body of the current list entry, from that `\item` to its next sibling or the end of its list. An optional `[label]` is a label, not the scope. Nested list entries receive their own scope; surrounding parent items are secondary context.
- Candidates supported by the current item have priority over parent-item and other-document candidates. This policy is enforced outside learned weights so training cannot remove it. Local counts also favor the current item when proposing token continuations.
- A bounded, smoothed token n-gram model proposes short continuations. A logistic-regression ranker scores the combined shortlist, including existing expression and indexed-sequence suggestions. Matching typed text continues consuming the displayed suggestion without requesting a new prediction.

## Arrange the dataset

Use a directory containing `.tex` files. Files are discovered recursively. A top-level directory represents one document family/project, so chapters and paper versions stay in the same split:

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

Independent flat files are separate families. Do not place unrelated projects beneath a single extra wrapper directory when passing `--input`; point the command at their common parent instead. The trainer also groups identical mathematical content and near-duplicate token sequences across directories. It retains variable names when comparing documents. This grouping is deliberately conservative but is not a guarantee against every form of dataset leakage; inspect paper versions and templates before training.

At least **four distinct families** must remain after grouping: one each for the n-gram, ranker, validation, and test sets. Four is only a smoke-test minimum. Use substantially more varied documents to obtain meaningful results. Include the list-based answers, notation, and topics expected in actual use. Fragments without explicit math delimiters/environments are ignored rather than guessed to be mathematics. Each file is parsed independently, so math environments split across separate files are not reconstructed.

Use documents you are permitted to use. Model counts can retain sequences of training tokens; a model artifact is not a privacy-preserving summary. Training reports contain hashes and aggregate statistics, not source text. Do not publish an artifact trained on private documents without considering those retained sequences.

## Inspect and prepare

From the repository root:

```powershell
node scripts/train-model.cjs --input "C:\path\to\dataset" --output "artifacts\prepared.json" --prepare
```

This checks mathematical extraction, removes exact duplicates, groups related documents, and writes deterministic split metadata. It does **not** train or modify the extension. The output lists source/math hashes rather than document contents. Comments, verbatim regions, ordinary prose, and `\text` arguments do not become n-gram training sequences.

The default split is approximately 60% n-gram training, 20% ranker training, 10% validation, and 10% final test, allocated by document-family count. Very small corpora reserve at least one family per split. Family sizes can differ, so percentages of actual files/tokens can differ. The seed and input contents determine the split; adding/removing documents may change it.

## Train and evaluate

```powershell
node scripts/train-model.cjs --input "C:\path\to\dataset" --output "artifacts\model.json" --seed 1729
```

The command produces:

- `artifacts/model.json`: schema version 1, tokenizer version, pruned n-gram tables, ranker coefficients/scaling, and training provenance.
- `artifacts/model.report.json`: serialized JSON model size in bytes, split counts, and held-out simulated-typing metrics, including candidate coverage, matching/mismatching displays, and matching characters.

Training proceeds as follows:

1. Count token sequences of orders 1–5 using only the n-gram split. The shared tokenizer preserves control words, individual ordinary math letters, digit runs, braces, and normalized whitespace. Prune rare context/successor counts to bound the artifact.
2. Sample append cursors from the separate ranker split, including positions inside command words and multi-digit numbers. For each sample, give candidate generation **only the document prefix up to the cursor**. Hidden target text and all later text are absent from retrieval and local counts. Never index the hidden answer.
3. Label a candidate positive when its tokens match a prefix of the hidden continuation, ignoring ordinary whitespace. Collect the shared features from all candidate providers. Fit feature means/scales on ranker examples only, then train an L2-regularized logistic model with deterministic stochastic gradient descent.
4. Install the fitted ranker into candidate generation before collecting validation/test examples, matching the deployed shortlist selection. Use the validation split to choose a display threshold. The initial utility is matching characters minus 16 for each mismatching display; this is a tunable product choice, not a measured user-cost estimate.
5. Evaluate once on the separate test split using the chosen threshold. The test split never trains counts, coefficients, scaling, or the threshold.

If the ranker sees no positive or no negative examples, training fails with a clear error. Add varied documents or raise `--max-samples`; do not turn fabricated weights into a supposedly trained artifact. Validation/test documents must also produce candidates.

These are **simulated append** measurements. They do not prove mathematical correctness, predict real Tab acceptance, or cover every middle-of-document edit. Existing browser tests cover editor integration; testing the trained artifact interactively on representative documents is still required. Evaluate cold startup, memory, and p50/p95 keystroke-to-visible latency separately on target laptops before distributing a model. The intended latency budget is a goal, not a benchmark result.

## Install a trained artifact

Once the report is acceptable, rerun the same training command with a browser export:

```powershell
node scripts/train-model.cjs --input "C:\path\to\dataset" --output "artifacts\model.json" --seed 1729 --browser-output "extension\model.js"
```

This replaces the untrained `extension/model.js` with a bundle exporting `AutoTexModel`. JSON remains the source artifact; the browser bundle has equivalent data and CommonJS support for tests. The tokenizer version and feature schema must match the runtime. Reload the unpacked extension and refresh the Overleaf page after replacing the model. Run `npm test`, `npm run test:browser`, and `npm run package` before sharing a new package.

Keep the original untrained model file in version control so you can restore it if a trained model performs poorly. Do not commit the dataset by default; keep its location outside the repository or explicitly ignore it.

## Training controls

Run `node scripts/train-model.cjs --help` for all options.

| Option | Default | Purpose |
| --- | ---: | --- |
| `--seed` | 1729 | Reproducible grouping assignment, sample selection, and optimization |
| `--order` | 5 | Maximum n-gram order; supported range 1–5 |
| `--min-count` | 2 | Prune rare counts |
| `--max-contexts` | 12000 | Bound the exported context table |
| `--max-successors` | 16 | Bound possible next tokens stored per context |
| `--max-samples` | 64 | Maximum sampled cursors per document |
| `--epochs` | 40 | Ranker optimization passes |
| `--max-document-bytes` | 5000000 | Fail clearly on unexpectedly large input files |

The candidate generator separately bounds its beam, completion length, and context budget for runtime speed. More training data need not mean a larger shipped model: retain pruning limits and compare held-out coverage against artifact size and browser latency. Increasing the number of epochs cannot compensate for missing useful candidates or an unrepresentative dataset.

## Verification

`tests/training.test.js` checks data extraction, duplicate/family isolation, deterministic preparation/training, ranker fitting, and JSON/browser export parity using temporary artificial fixtures. Those fixtures validate plumbing and are not a pretrained model or evidence of prediction quality.
