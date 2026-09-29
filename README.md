# AutoTeX

A Chrome extension that offers grey inline LaTeX completions in Overleaf’s **Code Editor**. Press **Tab** to accept or **Esc** to dismiss. Suggestions activate only in mathematical regions and strongly prefer the current `\item` answer. Computation stays local; no account, API key, or server is needed.

Version 1.3 adds a lightweight expression classifier for sets, algebraic structures, functions, scalar expressions, and indices. It guides document retrieval and a bounded 5-gram predictor using local symbol declarations and syntax. The classifier runs immediately without training; the bundled corpus model remains explicitly **untrained**. Offline training learns ranking weights, including type compatibility.

## Install

1. In Chrome, open `chrome://extensions`.
2. Enable **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select the `extension` folder in this project (the folder containing `manifest.json`). If using the release ZIP, extract it first and select the extracted folder containing `manifest.json`.
4. Open or reload your Overleaf project, then choose **Code Editor**.
5. Optionally pin **AutoTeX** from Chrome’s extensions menu. Its popup lets you pause suggestions, enable either feature, and choose a default final index.

The ready-to-load files are already in `extension/`. No build step or dependency installation is required to use the extension. Chrome 111 or newer is required.

To update an existing installation, click **Reload** on the extension’s card at `chrome://extensions`, then reload the Overleaf project. Existing preferences are retained when loading the same folder.

## Try it

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

Suggestions first appear after a short typing pause. As you type matching characters, the remaining grey text updates immediately without restarting that delay. Extra spaces between math tokens are preserved, and typing through a suggestion does not switch to another candidate. When a grey suggestion is visible, Tab accepts the remaining text ahead of Overleaf’s other Tab shortcuts. Otherwise, Tab retains its normal behavior. Esc dismisses until another edit. Standard Undo reverses acceptance in one step. Typing different content, moving the cursor, selecting text, or leaving the editor dismisses the preview.

## What it recognizes

- **Repeated expressions:** matches the typed prefix against formulas and subexpressions elsewhere in the current file. It recognizes `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and common equation/alignment environments. At least three non-whitespace prefix characters are normally required.
- **Predictive continuations:** uses short LaTeX token contexts and notation from the open file. Candidate generation has a four-path beam and a twelve-token limit. The same tokenizer and candidate providers are used for offline model training. The popup's **Suggest math expressions** switch controls both reuse and prediction.
- **Expression types:** standard number sets such as `\mathbb{R}` and local declarations such as `Let $G$ be a group` provide type evidence. A bare `R`, `N`, or `G` stays uncertain. Type compatibility softly adjusts suggestions; groups can still participate in set relations. Classification reads bounded context before the cursor, with current-item evidence taking priority.
- **Indices:** an unfinished subscript such as `x_{` activates index context. The engine can reuse an index already observed on the same base symbol, including `x_{j,k}` and `x_{i+1}`, preserving existing closing braces. Summation bounds and escaped underscores are distinguished from ordinary subscripts.
- **Answer scope:** the current `\item` is the span until the next sibling item or the end of its list. Its formulas and token transitions take priority. Nested items have separate scopes and can fall back to their parent, then other answers. This preference is enforced independently of learned ranking weights. Standard `enumerate`, `itemize`, and `description` lists, their starred variants, and bare `\item` fragments are recognized; arbitrary macro-generated lists are not expanded.
- **Indexed sequences:** recognizes consecutive numeric indices, preserves comma spacing and index braces, and completes an abbreviated list using `\ldots`. It first looks for an endpoint in a matching list or a nearby bound for the same variable, then uses the popup’s default (`n`). A default number from 3 to 999 may be set explicitly.
- **Safe editing:** previews are native CodeMirror decorations, not temporary document edits. Acceptance uses one editor transaction and preserves standard editing/undo behavior. Suggestions stop for read-only documents, multiple selections, and input-method composition.

Comments, common verbatim/listing environments, text inside math `\text{...}` commands, and label/reference arguments are excluded. Predictions estimate likely notation; they do not prove that an expression is mathematically appropriate. Review the preview before accepting it. Lists use ellipsis notation rather than expanding every intervening index. Generative suggestions currently fill the end of an expression or an automatically paired group; expression reuse can also fill known gaps before existing text.

Document-supported expression, sequence, and index reuse remains available even when a trained model rejects its generated predictions. The learned confidence threshold applies to generated suggestions.

## Prepare and train a model

See [the training guide](docs/TRAINING.md) for dataset layout, split isolation, training controls, and evaluation limits. Use local `.tex` files, with each independent project in its own top-level folder. Training requires at least four distinct document families after grouping; that minimum only verifies the pipeline, so a useful model needs a larger representative dataset.

```powershell
npm run model:prepare -- --input "C:\path\to\dataset" --output "artifacts\prepared.json"
npm run model:train -- --input "C:\path\to\dataset" --output "artifacts\model.json"
```

The preparation command validates mathematical extraction and writes split metadata. Training creates token counts, 18-feature ranking weights, and a held-out evaluation report broken down by expression category and completion source. Add `--browser-output "extension\model.js"` to the training command when ready to install the trained artifact, then reload the extension and Overleaf. The trainer uses Node.js with no additional dependencies and never compiles or executes the LaTeX. Dataset and generated-artifact folders are ignored by Git.

## Scope and privacy

Only the source text of the currently open editor file is available at runtime. Other project files and the PDF are not read. The extension does not persist document text, make network requests, use analytics, or require a remote model. Chrome’s local extension storage holds only preferences. Optional offline corpus training reads only the dataset folder you explicitly supply. Overleaf’s normal saving and collaboration continue to operate independently.

This version targets `https://www.overleaf.com/project/*` and `https://overleaf.com/project/*`. The Visual Editor, older Ace editors, custom/self-hosted Overleaf domains, and specialized Vim/Emacs interactions are outside the verified scope. This is an unofficial extension and is not affiliated with Overleaf.

## Troubleshooting

- After installing or reloading the extension, reload the Overleaf project too.
- Use **Code Editor**, ensure the file is editable, and type within a math region.
- For a repeated expression, the source formula must exist elsewhere in the same open file. For a new indexed list, type two consecutive terms such as `x_1,x_2`.
- Check that the feature is enabled in the popup. Its status reports whether the editor connection is active.
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

The automated checks cover math-only gating, nested item priority, token boundaries, model validation, training leakage/determinism, expression and sequence matching, cursor/overlap edge cases, grey decorations, continuous typing with spaces and automatic brackets, acceptance, independent Undo, dismissal, document switching, settings, selection, read-only mode, and composition. Training tests use temporary artificial fixtures, which are not shipped as a trained model. A signed-in live Overleaf project has not been tested in this workspace.

The benchmark measures complete engine calls on changed documents of several sizes, with the installed model. It excludes browser rendering and the default 50 ms scheduling delay, and is not a guarantee of end-to-end latency. Matching an existing ghost does not rerun prediction. Classifier work is bounded to 24,000 characters, 128 math rows, and 128 symbols; candidate work uses 128 nearby mathematical rows prioritized by item; parser updates currently reanalyze changed documents, so very large files still need profiling before distribution.

## Integration references

- [Overleaf’s third-party extension interface](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/extensions/third-party-extensions.ts)
- [CodeMirror exports provided by Overleaf](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/extensions/bundle.ts)
- [Chrome content-script execution worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

`editor.js` listens for `UNSTABLE_editor:extensions` and uses the host’s own StateField, ViewPlugin, and Decoration classes. This avoids bundling a conflicting copy of CodeMirror. `bridge.js` runs in Chrome’s isolated world and transfers only validated preferences and connection state; document text stays in the page’s editor engine.
