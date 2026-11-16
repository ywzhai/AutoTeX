# AutoTeX

A Chrome extension that offers grey inline LaTeX completions and automatic fractions in Overleaf’s **Code Editor**. Press **Tab** to accept a suggestion or **Esc** to dismiss it. Type **/** after a math expression to turn it into a fraction. These features activate only in mathematical regions; suggestions strongly prefer the current `\item` answer. Computation stays local; no account, API key, or server is needed.

AutoTeX has two separate completion paths. **Indexed list completion** recognizes repeated mathematical structure and advances the linked indices directly. **Normal autocomplete** combines document retrieval, a lightweight expression classifier, and a bounded 5-gram predictor. A trained corpus supplies token probabilities and ranking weights for normal autocomplete; matching local notation gains influence as the document develops. Explicit **Tab** acceptance and **Esc** dismissal adjust normal-autocomplete scores for that open document. Structural list completions bypass those scores and do not train the token predictor.

## Install

1. In Chrome, open `chrome://extensions`.
2. Enable **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select the `extension` folder in this project (the folder containing `manifest.json`). If using the release ZIP, extract it first and select the extracted folder containing `manifest.json`.
4. Open or reload your Overleaf project, then choose **Code Editor**.
5. Optionally pin **AutoTeX** from Chrome’s extensions menu. Its popup lets you pause AutoTeX, toggle automatic fractions and each suggestion feature independently, choose a default final index, and adjust when suggestions appear. The popup follows your system’s light or dark theme.

The ready-to-load files are already in `extension/`. No build step or dependency installation is required to use the extension. Chrome 111 or newer is required.

To update an existing installation, click **Reload** on the extension’s card at `chrome://extensions`, then reload the Overleaf project. Existing preferences are retained when loading the same folder.

## Try it

Inside a math region, type `PQ/` to create `\frac{PQ}{}` with the cursor in the empty denominator. The numerator includes the uninterrupted text immediately before `/`, stopping at whitespace: `A + B+C/` becomes `A + \frac{B+C}{}`. Spaces, tabs, and line breaks separate numerator blocks. Math delimiters and surrounding LaTeX structure remain in place.

Fractions expand immediately without a grey preview. A slash immediately after whitespace or at the start of math stays literal, as do pasted slashes. Standard Undo reverses the expansion independently of the text you typed before it. Turn off **Auto fractions** in the popup to keep typing literal slashes; the expression and sequence switches work independently.

Write this somewhere in your open `.tex` file:

```latex
\[
  a^2 + b^2 = c^2
\]
```

Later, inside another math region, type `a^2`. The extension previews ` + b^2 = c^2` in grey. Press Tab to insert it.

For a list, type the following inside `$...$` or another math region:

```latex
\{x_1,x_2
```

The preview is `,\ldots,x_n\}`. With an existing closing `\}`, the extension inserts only the missing portion. Braced indices (`x_{1}`), Greek variables (`\alpha_1`), and styled variables (`\mathbf{x}_1`) are also supported. A sufficiently clear partial second term, such as `x_1,x_`, can also trigger a completion.

The full contiguous base is preserved: `ba_1,ba_2` previews `,\ldots,ba_n`, treating `ba` as the repeated element and `1`, `2`, and `n` as its indices. If you already typed `ba_1,ba_2,...`, the preview is only `,ba_n`. Existing `...`, `\ldots`, or `\cdots` are kept. The extension searches the current document for a matching list or index bound, so an earlier `ba_1,ba_2,\ldots,ba_M` supplies `ba_M` as the endpoint; unrelated bases do not supply the endpoint. Without matching evidence, it uses the popup's default final index (`n`).

Products can advance several indices together: `a_1b_1,a_2b_2,...` previews `,a_nb_n`. Each factor keeps its own braces, so `a_{1}b_1,a_{2}b_2,...` finishes with `a_{n}b_n`. The factors must appear in the same order and share the same index within each term. Endpoint evidence must match the whole product, such as `a_1b_1,a_2b_2,\ldots,a_Mb_M`; a list of only `a_i` does not set the product's endpoint. A partially typed next term or endpoint can also be completed, including `a_1b_1,a_2b_` and `a_1b_1,a_2b_2,...,a_nb_`.

The same pattern recognition works across sums, products, subset relations, and other chains. For example, `x_1+x_2` previews `+\cdots+x_n`, `a_1b_1+a_2b_2` previews `+\cdots+a_nb_n`, and `A_1 \subseteq A_2` previews ` \subseteq \cdots \subseteq A_n`. The separator and its spacing are preserved; mixed separators do not establish a single sequence.

Repeated terms can include function arguments: `r_1f(x_1)+r_2f(x_2)` previews `+\cdots+r_nf(x_n)`, and `r_1f(x_1)+r_2f(x_2)+...` previews only `+r_nf(x_n)`. Both indices advance together while the surrounding coefficient, function, and parentheses stay intact. Once a valid list pattern is recognized, its structural completion takes priority over ordinary formula reuse and token prediction, including an ordinary preview left over from earlier typing. The popup's **Complete indexed sequences** switch controls this feature independently of **Suggest math expressions**.

Nested indices advance together too. Typing `a=p_1^{k_1}p_2^{k_2}...` previews `p_n^{k_n}`. Choose `m` as the popup's final index, or supply a matching document example ending in `p_m^{k_m}`, to get `p_m^{k_m}`. A partially typed endpoint also supplies its index: `...p_m^{k_` finishes with `m}`. Otherwise, the default remains `n`. Constant exponents stay constant: `p_1^2p_2^2` previews `\cdots p_n^2`. Partial terms and endpoints such as `p_1^{k_1}p_2^{k_` and `p_1^{k_1}p_2^{k_2}...p_n^{k_` can also be completed.

Suggestions first appear after a short typing pause. As you type matching characters, the remaining grey text updates immediately without restarting that delay. Extra spaces between math tokens are preserved. Matching typing retains the current continuation, except when a newly recognized structural list takes priority over an ordinary preview. When a grey suggestion is visible, Tab accepts the remaining text ahead of Overleaf’s other Tab shortcuts. Otherwise, Tab retains its normal behavior. Esc dismisses until another edit. Standard Undo reverses acceptance in one step. Typing different content, moving the cursor, selecting text, or leaving the editor dismisses the preview.

Press **Alt+\** to request a suggestion immediately, including after dismissing one or moving the cursor. Turn off **Show suggestions automatically** in the popup for manual-only suggestions; automatic fractions can still be used independently. On Mac, use **Option** for these Alt shortcuts.

While a normal-autocomplete preview is visible, **Alt+]** selects the next alternative and **Alt+[** selects the previous one. Up to five distinct choices are available, subject to the same confidence checks and current-answer priority as the initial suggestion. A recognized structural list keeps its deterministic completion rather than offering competing token predictions. Browsing changes only the preview. Tab accepts the selected choice, and Esc dismisses it; only those explicit actions on normal autocomplete affect document feedback. Editing or moving the cursor discards the old alternatives.

The popup’s **Suggestion delay** offers 50, 200, and 500 ms pauses. **Expression prefix length** controls how many non-whitespace characters (1–20) are needed for ordinary expression previews; index and sequence completions keep their own pattern checks. Manual requests bypass the delay while retaining the configured prefix length and other eligibility checks.

## What it recognizes

- **Automatic fractions:** `/` wraps the contiguous math text immediately before the cursor in `\frac{...}{}` and places the cursor in the denominator. The **Auto fractions** switch controls this separately from suggestions.
- **Repeated expressions:** matches the typed prefix against formulas and subexpressions elsewhere in the current file. It recognizes `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and common equation/alignment environments. At least three non-whitespace prefix characters are normally required.
- **Predictive continuations:** uses short LaTeX token contexts and notation from the open file. Candidate generation has a four-path beam and a twelve-token limit. The same tokenizer and candidate providers are used for offline model training. The popup's **Suggest math expressions** switch controls both reuse and prediction.
- **Corpus and document adaptation:** corpus probabilities support normal autocomplete before a formula has appeared locally. Repeated matching patterns in the open file gradually outweigh that prior. The learned ranker scores reused formulas, indices, and predictions within the current-answer priority policy. Structural lists use their own pattern rules and never compete in this ranking.
- **Feedback:** accepting or explicitly dismissing a normal-autocomplete suggestion adjusts a small document-specific score correction. Typing through a suggestion retains its original feedback example. Structural list acceptance/dismissal, cursor movements, blur, divergent typing, and Undo do not train the predictor. Adaptation stays in memory and resets when the editor switches documents or reloads.
- **Expression types:** standard number sets such as `\mathbb{R}` and local declarations such as `Let $G$ be a group` provide type evidence. A bare `R`, `N`, or `G` stays uncertain. Type compatibility softly adjusts suggestions; groups can still participate in set relations. Classification reads bounded context before the cursor, with current-item evidence taking priority.
- **Indices:** an unfinished subscript such as `x_{` activates index context. The engine can reuse an index already observed on the same base symbol, including `x_{j,k}` and `x_{i+1}`, preserving existing closing braces. Summation bounds and escaped underscores are distinguished from ordinary subscripts.
- **Answer scope:** the current `\item` is the span until the next sibling item or the end of its list. Its formulas and token transitions take priority. Nested items have separate scopes and can fall back to their parent, then other answers. This preference is enforced independently of learned ranking weights. Standard `enumerate`, `itemize`, and `description` lists, their starred variants, and bare `\item` fragments are recognized; arbitrary macro-generated lists are not expanded.
- **Indexed sequences:** independently recognizes consecutive numeric indices across comma lists, sums, products, subset relations, and other chains. Full bases such as `ba`, synchronized factors such as `a_ib_i`, functions such as `r_if(x_i)`, and nested scripts such as `p_i^{k_i}` retain their structure; fixed powers such as `^2` remain fixed. It preserves the separator, spacing, factor order, and index braces. New comma lists use `\ldots`; other chains use `\cdots`. Already-typed ellipses are completed with only the missing endpoint. It first looks for an endpoint in a matching sequence or a nearby bound for the same full pattern in the current document, then uses the popup’s default (`n`). A default number from 3 to 999 may be set explicitly. Model confidence, prefix-length settings, and learned ranking do not suppress a recognized list.
- **Suggestion controls:** request a preview on demand, browse up to five eligible normal-autocomplete alternatives, or use manual-only mode. The popup exposes typing delay and expression prefix length, with persistent preferences and a keyboard-shortcut guide.
- **Safe editing:** previews are native CodeMirror decorations, not temporary document edits. Acceptance uses one editor transaction and preserves standard editing/undo behavior. Suggestions stop for read-only documents, multiple selections, and input-method composition.

Comments, common verbatim/listing environments, text inside math `\text{...}` commands, and label/reference arguments are excluded. Predictions estimate likely notation; they do not prove that an expression is mathematically appropriate. Review the preview before accepting it. Lists use ellipsis notation rather than expanding every intervening index. Generative suggestions currently fill the end of an expression or an automatically paired group; expression reuse can also fill known gaps before existing text.

Structural list completion runs before normal autocomplete and does not depend on the trained model. When no list pattern fits, document-supported expression and index reuse remain available even if the model rejects its generated predictions. The learned confidence threshold applies to generated suggestions.

## Prepare and train a model

See [the training guide](docs/TRAINING.md) for dataset layout, split isolation, training controls, and evaluation limits. Use local `.tex` files, with each independent project in its own top-level folder. Training requires at least four distinct document families after grouping; that minimum only verifies the pipeline, so a useful model needs a larger representative dataset.

```powershell
npm run model:prepare -- --input "C:\path\to\dataset" --output "artifacts\prepared.json"
npm run model:train -- --input "C:\path\to\dataset" --output "artifacts\model.json"
```

The preparation command validates mathematical extraction and writes split metadata. Training creates token counts, 18-feature ranking weights, and a held-out evaluation report broken down by expression category, completion source, and initial versus later-document suggestions, with an untrained baseline. Add `--browser-output "extension\model.js"` to install the trained artifact, then reload the extension and Overleaf. `extension/model.js` records whether a trained model is installed. The trainer uses Node.js with no additional dependencies and never compiles or executes the LaTeX. Dataset and generated-artifact folders are ignored by Git.

## Scope and privacy

Only the source text of the currently open editor file is available at runtime. Other project files and the PDF are not read. The extension does not persist document text or feedback, make network requests, use analytics, or require a remote model. Chrome’s local extension storage holds only preferences. Document-specific score adjustments stay in memory; they do not rewrite the corpus model. Optional offline corpus training reads only the dataset folder you explicitly supply. Overleaf’s normal saving and collaboration continue to operate independently.

This version targets `https://www.overleaf.com/project/*` and `https://overleaf.com/project/*`. The Visual Editor, older Ace editors, custom/self-hosted Overleaf domains, and specialized Vim/Emacs interactions are outside the verified scope. This is an unofficial extension and is not affiliated with Overleaf.

## Troubleshooting

- After installing or reloading the extension, reload the Overleaf project too.
- Use **Code Editor**, ensure the file is editable, and type within a math region.
- For a repeated expression, the source formula must exist elsewhere in the same open file. For a new indexed sequence, type two consecutive terms such as `x_1,x_2`, `x_1+x_2`, or `p_1^{k_1}p_2^{k_2}`.
- Check that the feature is enabled in the popup. Its status reports whether the editor connection is active.
- If automatic suggestions are off, use **Alt+\** in math to request one. If previews feel too frequent, increase the delay or expression prefix length.
- If Overleaf changes its third-party editor interface, this extension may need an update. It uses Overleaf’s exposed interface, which Overleaf explicitly describes as unstable.

## Development and validation

Node.js 22+ and npm (or pnpm) are needed only for development:

```text
npm install
npm test
npm run test:browser
npm run benchmark
npm run package
```

The browser suite uses real CodeMirror modules and reproduces Overleaf’s third-party extension events in a local fixture. It runs in an isolated headless browser. Install a Playwright browser with `npx playwright install chromium`, use an installed Chrome/Edge, or set `CHROME_PATH` to a browser executable. Tests do not read your browser profile or Overleaf projects.

The release ZIP is written to `dist/autotex.zip`. All runtime scripts are plain JavaScript; development libraries are never shipped. `tests/.generated/` and `test-results/` contain only local test output.

The automated checks cover automatic fractions and denominator placement, math-only gating, nested item priority, token boundaries, model validation, training leakage/determinism, expression and sequence matching, cursor/overlap edge cases, grey decorations, continuous typing with spaces and automatic brackets, acceptance, independent Undo, dismissal, document switching, settings, selection, read-only mode, and composition. Training tests use temporary artificial fixtures, which are not shipped as a trained model. A signed-in live Overleaf project has not been tested in this workspace.

The benchmark measures complete engine calls on changed documents of several sizes, with the installed model. It excludes browser rendering and the default 50 ms scheduling delay, and is not a guarantee of end-to-end latency. Matching an existing ghost does not rerun prediction. Classifier work is bounded to 24,000 characters, 128 math rows, and 128 symbols; candidate work uses 128 nearby mathematical rows prioritized by item; parser updates currently reanalyze changed documents, so very large files still need profiling before distribution.

## Integration references

- [Overleaf’s third-party extension interface](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/extensions/third-party-extensions.ts)
- [CodeMirror exports provided by Overleaf](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/extensions/bundle.ts)
- [Chrome content-script execution worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

`editor.js` listens for `UNSTABLE_editor:extensions` and uses the host’s own StateField, ViewPlugin, and Decoration classes. This avoids bundling a conflicting copy of CodeMirror. `bridge.js` runs in Chrome’s isolated world and transfers only validated preferences and connection state; document text stays in the page’s editor engine.
