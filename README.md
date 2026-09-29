# AutoTeX

A Chrome extension that offers grey inline LaTeX completions in Overleaf’s **Code Editor**. Press **Tab** to accept or **Esc** to dismiss. Suggestions are computed locally from the currently open file; no account, API key, or server is needed.

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
- **Indexed sequences:** recognizes consecutive numeric indices, preserves comma spacing and index braces, and completes an abbreviated list using `\ldots`. It first looks for an endpoint in a matching list or a nearby bound for the same variable, then uses the popup’s default (`n`). A default number from 3 to 999 may be set explicitly.
- **Safe editing:** previews are native CodeMirror decorations, not temporary document edits. Acceptance uses one editor transaction and preserves standard editing/undo behavior. Suggestions stop for read-only documents, multiple selections, and input-method composition.

Comments, common verbatim/listing environments, and text inside math `\text{...}` commands are excluded. These are deterministic pattern suggestions, not a mathematical reasoning system: they do not prove that a copied formula is appropriate or infer every intended sequence. Review the preview before accepting it. Lists use ellipsis notation rather than expanding every intervening index.

## Scope and privacy

Only the source text of the currently open editor file is available. Other project files and the PDF are not read. The extension does not persist document text, make network requests, use analytics, or require a remote model. Chrome’s local extension storage holds only preferences. Overleaf’s normal saving and collaboration continue to operate independently.

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
npm run package
```

The browser suite uses real CodeMirror modules and reproduces Overleaf’s third-party extension events in a local fixture. It runs in an isolated headless browser. Install a Playwright browser with `npx playwright install chromium`, use an installed Chrome/Edge, or set `CHROME_PATH` to a browser executable. Tests do not read your browser profile or Overleaf projects.

The release ZIP is written to `dist/autotex.zip`. All runtime scripts are plain JavaScript; development libraries are never shipped. `tests/.generated/` and `test-results/` contain only local test output.

The automated checks cover expression and sequence matching, cursor/overlap edge cases, grey decorations, continuous typing with spaces and automatic brackets, acceptance, independent Undo, dismissal, document switching, settings, selection, read-only mode, and composition. A signed-in live Overleaf project has not been tested in this workspace.

## Integration references

- [Overleaf’s third-party extension interface](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/extensions/third-party-extensions.ts)
- [CodeMirror exports provided by Overleaf](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/extensions/bundle.ts)
- [Chrome content-script execution worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

`editor.js` listens for `UNSTABLE_editor:extensions` and uses the host’s own StateField, ViewPlugin, and Decoration classes. This avoids bundling a conflicting copy of CodeMirror. `bridge.js` runs in Chrome’s isolated world and transfers only validated preferences and connection state; document text stays in the page’s editor engine.
