"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { build } = require("esbuild");
const { chromium } = require("playwright");
const Predictor = require("../extension/predictor.js");

const root = path.resolve(__dirname, "..");
const ghostSelector = ".ol-math-ghost";
let browser;
let server;
let baseURL;

function browserExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    chromium.executablePath(),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft/Edge/Application/msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

test.before(async () => {
  fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
  await build({
    entryPoints: [path.join(__dirname, "fixture.js")],
    outfile: path.join(__dirname, ".generated/fixture.js"),
    bundle: true,
    format: "iife",
    target: "chrome111",
  });
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    const file = path.resolve(root, "." + pathname);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "text/plain";
    fs.readFile(file, (error, content) => {
      if (error) { response.writeHead(404).end("Not found"); return; }
      response.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
      response.end(content);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function fixture(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], "The fixture should have no uncaught browser errors");
  });
  // Pin exact-behavior fixtures to the baseline model. A newly trained corpus
  // can legitimately choose different text; the bundled-model test below covers
  // loading and accepting suggestions from the installed artifact separately.
  if (Object.hasOwn(options, "modelArtifact") || !options.bundledModel) {
    const model = Object.hasOwn(options, "modelArtifact") ? options.modelArtifact : Predictor.createUntrainedArtifact();
    await page.route("**/extension/model.js", (route) => route.fulfill({
      contentType: "text/javascript",
      body: "globalThis.AutoTexModel = " + JSON.stringify(model) + ";",
    }));
  }
  await page.goto(`${baseURL}/tests/fixture.html`);
  await page.waitForFunction(() => window.fixture?.extensionEvents >= 2);
  await page.locator('[aria-label="Source Editor editing"]').click();
  return page;
}

async function setDocument(page, marked, options) {
  const cursor = marked.indexOf("|");
  assert.notEqual(cursor, -1, "Document fixture must include one cursor marker");
  const text = marked.slice(0, cursor) + marked.slice(cursor + 1);
  await page.evaluate(({ text, cursor, options }) => window.fixture.setDocument(text, cursor, options), { text, cursor, options });
  return text;
}

async function documentText(page) {
  return page.evaluate(() => window.fixture.view.state.doc.toString());
}

async function ghostText(page) {
  await page.locator(ghostSelector).first().waitFor({ state: "visible" });
  return page.locator(ghostSelector).allTextContents().then((parts) => parts.join(""));
}

async function noGhost(page) {
  // Longer than the fixture's real suggestion debounce; detects a late reappearance.
  await page.waitForTimeout(120);
  assert.equal(await page.locator(ghostSelector).count(), 0);
}

async function observeFeedback(page) {
  await page.evaluate(() => {
    window.fixture.feedbackSessions = [];
    const create = window.MathAutocompleteEngine.createEngine;
    window.MathAutocompleteEngine.createEngine = (...args) => {
      const engine = create(...args);
      const session = { engine, events: [], resets: 0, snapshot: null };
      window.fixture.feedbackSessions.push(session);
      const suggest = engine.suggest;
      engine.suggest = (...values) => {
        const candidate = suggest(...values);
        session.snapshot = candidate?._feedback;
        return candidate;
      };
      const feedback = engine.feedback;
      engine.feedback = (candidate, accepted) => {
        const snapshot = candidate._feedback;
        const result = feedback(candidate, accepted);
        session.events.push({
          accepted,
          insertText: candidate.insertText,
          sameSnapshot: snapshot === session.snapshot,
          featureCount: snapshot?.features?.length,
          finiteFeatures: snapshot?.features?.every(Number.isFinite),
          result,
        });
        return result;
      };
      const reset = engine.reset;
      engine.reset = () => { session.resets++; reset(); };
      return engine;
    };
  });
}

async function feedbackSessions(page) {
  return page.evaluate(() => window.fixture.feedbackSessions.map(({ engine, events, resets }) => ({
    events, resets, state: engine.calibrationState(),
  })));
}

// Simulate the physical shortcut even when Option changes the character produced
// by the keyboard layout. The synchronous snapshot also proves manual requests
// do not wait for the automatic suggestion delay.
async function shortcutSnapshot(page, code, key = code) {
  return page.evaluate(({ code, key }) => {
    const event = new KeyboardEvent("keydown", { code, key, altKey: true, bubbles: true, cancelable: true });
    window.fixture.view.contentDOM.dispatchEvent(event);
    return { prevented: event.defaultPrevented,
      ghost: window.fixture.view.dom.querySelector(".ol-math-ghost")?.textContent || "",
      text: window.fixture.view.state.doc.toString() };
  }, { code, key });
}

test("manual suggestions appear immediately and reopen after dismissal without editing", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.configure({ automaticSuggestions: false, debounceMs: 2000 }));
  const before = await setDocument(page, "$f(x)=x+1$\n$f(x)|$");
  await noGhost(page);
  const requested = await shortcutSnapshot(page, "Backslash", "«");
  assert.deepEqual(requested, { prevented: true, ghost: "=x+1", text: before });
  await page.keyboard.press("Escape");
  await noGhost(page);
  assert.equal((await shortcutSnapshot(page, "Backslash", "«")).ghost, "=x+1");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$f(x)=x+1$\n$f(x)=x+1$");
  await noGhost(page);
  await setDocument(page, "$PQ|$");
  await page.keyboard.press("/");
  assert.equal(await documentText(page), "$\\frac{PQ}{}$");
  assert.equal(await page.evaluate(() => window.fixture.view.state.selection.main.head), "$\\frac{PQ}{".length);
});

test("manual suggestion shortcuts retain math editability and composition guards", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.configure({ automaticSuggestions: false }));
  for (const marked of ["$f(x)=x+1$\nf(x)|", "$f(x)=x+1$\n$\\text{f(x)|}$", "$f(x)=x+1$\n% $f(x)|"]) {
    const before = await setDocument(page, marked);
    const result = await shortcutSnapshot(page, "Backslash", "\\");
    assert.equal(result.ghost, "", marked);
    assert.equal(result.text, before, marked);
  }
  const modifierDocument = await setDocument(page, "$f(x)=x+1$\n$f(x)|$");
  for (const modifier of ["ctrlKey", "shiftKey", "metaKey"]) {
    const result = await page.evaluate((modifier) => {
      const event = new KeyboardEvent("keydown", {
        code: "Backslash", key: "\\", altKey: true, [modifier]: true, bubbles: true, cancelable: true,
      });
      // Observe after AutoTeX's capture listener and before the host keymap;
      // CodeMirror may legitimately handle one of these modifier combinations.
      let prevented = true;
      window.fixture.view.dom.addEventListener("keydown", (event) => {
        prevented = event.defaultPrevented;
      }, { capture: true, once: true });
      window.fixture.view.contentDOM.dispatchEvent(event);
      return { prevented,
        ghost: window.fixture.view.dom.querySelector(".ol-math-ghost")?.textContent || "",
        text: window.fixture.view.state.doc.toString() };
    }, modifier);
    assert.deepEqual(result, { prevented: false, ghost: "", text: modifierDocument }, modifier);
  }
  for (const blocked of ["paused", "readOnly", "selection", "composition", "featuresDisabled"]) {
    await page.evaluate(() => window.fixture.configure({ enabled: true, expressions: true, sequences: true }));
    const before = await setDocument(page, "$f(x)=x+1$\n$f(x)|$", { readOnly: blocked === "readOnly" });
    if (blocked === "paused") await page.evaluate(() => window.fixture.configure({ enabled: false }));
    if (blocked === "featuresDisabled") await page.evaluate(() => window.fixture.configure({ expressions: false, sequences: false }));
    if (blocked === "selection") await page.evaluate(() => {
      const position = window.fixture.view.state.selection.main.head;
      window.fixture.setSelection(position - 1, position);
    });
    if (blocked === "composition") await page.evaluate(() => window.fixture.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    const result = await shortcutSnapshot(page, "Backslash", "\\");
    assert.equal(result.ghost, "", blocked);
    assert.equal(result.text, before, blocked);
    if (blocked === "composition") await page.evaluate(() => window.fixture.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  }
});

test("alternative suggestions cycle without edits and accept the selected choice with independent Undo", async (t) => {
  const page = await fixture(t);
  await observeFeedback(page);
  const before = await setDocument(page, "$f(x)=x+1$\n$f(x)=x+2$\n$f(x)|$");
  const original = await ghostText(page);
  const next = await shortcutSnapshot(page, "BracketRight", "]");
  assert.equal(next.prevented, true);
  assert.notEqual(next.ghost, original);
  assert.equal(next.text, before);
  const previous = await shortcutSnapshot(page, "BracketLeft", "[");
  assert.equal(previous.ghost, original);
  assert.equal(previous.text, before);
  const chosen = (await shortcutSnapshot(page, "BracketRight", "]")).ghost;
  let sessions = await feedbackSessions(page);
  assert.deepEqual(sessions.at(-1).events, [], "Browsing alternatives must not train acceptance or rejection");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before.slice(0, -1) + chosen + "$");
  sessions = await feedbackSessions(page);
  assert.equal(sessions.at(-1).events.length, 1);
  assert.equal(sessions.at(-1).events[0].accepted, true);
  assert.equal(sessions.at(-1).events[0].insertText, chosen);
  assert.equal(sessions.at(-1).events[0].finiteFeatures, true);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await documentText(page), before);
  await noGhost(page);
  assert.equal((await feedbackSessions(page)).at(-1).events.length, 1);
});

test("cycling a continued preview preserves its original feedback and Undo keeps the typed prefix", async (t) => {
  const page = await fixture(t);
  await observeFeedback(page);
  const before = await setDocument(page, "$f(x)=x+1$\n$f(x)=x+2$\n$f(x)|$");
  const original = await ghostText(page);
  assert.ok(original.startsWith("="), "Fixture must offer a shared prefix for both formulas");
  await page.keyboard.type("=");
  const continued = await ghostText(page);
  assert.equal(continued, original.slice(1));
  const typedDocument = before.slice(0, -1) + "=$";
  assert.equal(await documentText(page), typedDocument);
  const alternative = await shortcutSnapshot(page, "BracketRight", "]");
  assert.notEqual(alternative.ghost, continued);
  assert.equal(alternative.text, typedDocument);
  const restored = await shortcutSnapshot(page, "BracketLeft", "[");
  assert.equal(restored.ghost, continued);
  assert.equal(restored.text, typedDocument);
  assert.deepEqual((await feedbackSessions(page)).at(-1).events, []);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before.slice(0, -1) + original + "$");
  const events = (await feedbackSessions(page)).at(-1).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].accepted, true);
  assert.equal(events[0].sameSnapshot, true, "The continued original retains its pre-typing feedback features");
  assert.equal(events[0].insertText, continued, "Tab only inserts the remaining suffix");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await documentText(page), typedDocument);
  await noGhost(page);
  assert.equal((await feedbackSessions(page)).at(-1).events.length, 1);
});

test("dismissing an alternative records only that visible choice", async (t) => {
  const page = await fixture(t);
  await observeFeedback(page);
  const before = await setDocument(page, "$f(x)=x+1$\n$f(x)=x+2$\n$f(x)|$");
  await ghostText(page);
  const chosen = (await shortcutSnapshot(page, "BracketRight", "]")).ghost;
  assert.deepEqual((await feedbackSessions(page)).at(-1).events, []);
  await page.keyboard.press("Escape");
  await noGhost(page);
  assert.equal(await documentText(page), before);
  const events = (await feedbackSessions(page)).at(-1).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].accepted, false);
  assert.equal(events[0].insertText, chosen);
});

test("alternative suggestions cannot outlive cursor movement edits or disabled features", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "$f(x)=x+1$\n$f(x)=x+2$\n$f(x)|$");
  await ghostText(page);
  await shortcutSnapshot(page, "BracketRight", "]");
  await page.keyboard.press("ArrowLeft");
  await noGhost(page);
  assert.equal((await shortcutSnapshot(page, "BracketRight", "]")).ghost, "");
  assert.equal(await documentText(page), before);
  await page.keyboard.press("ArrowRight");
  await shortcutSnapshot(page, "Backslash", "\\");
  await shortcutSnapshot(page, "BracketRight", "]");
  await page.keyboard.type("z");
  await noGhost(page);
  assert.equal((await shortcutSnapshot(page, "BracketRight", "]")).ghost, "");
  assert.equal(await documentText(page), before.slice(0, -1) + "z$");
  await setDocument(page, "$g(x)=x+3$\n$g(x)=x+4$\n$g(x)|$");
  await ghostText(page);
  await shortcutSnapshot(page, "BracketRight", "]");
  await page.evaluate(() => window.fixture.configure({ expressions: false, sequences: false }));
  await noGhost(page);
  const blocked = await shortcutSnapshot(page, "BracketRight", "]");
  assert.equal(blocked.ghost, "");
  assert.equal(blocked.text, "$g(x)=x+3$\n$g(x)=x+4$\n$g(x)$");
});

test("auto fractions wrap the typed block and support denominator typing and independent undo", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$|$");
  await page.keyboard.type("PQ/");
  assert.equal(await documentText(page), "$\\frac{PQ}{}$");
  assert.equal(await page.evaluate(() => window.fixture.view.state.selection.main.head), "$\\frac{PQ}{".length);
  await page.keyboard.type("R");
  assert.equal(await documentText(page), "$\\frac{PQ}{R}$");
  const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
  await page.keyboard.press(undoKey);
  assert.equal(await documentText(page), "$\\frac{PQ}{}$");
  await page.keyboard.press(undoKey);
  assert.equal(await documentText(page), "$PQ$");
  assert.equal(await page.evaluate(() => window.fixture.view.state.selection.main.head), 3);
  await noGhost(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  assert.equal(await documentText(page), "$\\frac{PQ}{}$");
  assert.equal(await page.evaluate(() => window.fixture.view.state.selection.main.head), "$\\frac{PQ}{".length);
  await setDocument(page, "$A + B+C|$");
  await page.keyboard.press("/");
  assert.equal(await documentText(page), "$A + \\frac{B+C}{}$");
});

test("auto fractions clear a visible suggestion without labeling it as model feedback", async (t) => {
  const page = await fixture(t);
  await observeFeedback(page);
  await setDocument(page, "$a^2+b^2=c^2$\n$a^2|$");
  await ghostText(page);
  await page.keyboard.press("/");
  assert.equal(await documentText(page), "$a^2+b^2=c^2$\n$\\frac{a^2}{}$");
  await noGhost(page);
  assert.deepEqual((await feedbackSessions(page))[0].events, []);
});

test("auto fractions have an independent live preference and respect the master switch", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.configure({ expressions: false, sequences: false }));
  await setDocument(page, "$PQ|$");
  await page.keyboard.press("/");
  assert.equal(await documentText(page), "$\\frac{PQ}{}$");
  await page.evaluate(() => window.fixture.configure({ autoFractions: false }));
  await setDocument(page, "$PQ|$");
  await page.keyboard.press("/");
  assert.equal(await documentText(page), "$PQ/$");
  await page.evaluate(() => window.fixture.configure({ autoFractions: true, enabled: false }));
  await setDocument(page, "$PQ|$");
  await page.keyboard.press("/");
  assert.equal(await documentText(page), "$PQ/$");
});

test("auto fractions leave prose, text commands, empty numerators, and pasted slashes unchanged", async (t) => {
  const page = await fixture(t);
  for (const marked of ["PQ|", "$\\text{PQ|}$", "% $PQ|$", "$PQ |$", "$|$"]) {
    const cursor = marked.indexOf("|");
    const before = await setDocument(page, marked);
    await page.keyboard.press("/");
    assert.equal(await documentText(page), before.slice(0, cursor) + "/" + before.slice(cursor), marked);
  }
  await setDocument(page, "$PQ|$");
  await page.locator('[aria-label="Source Editor editing"]').evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "/");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  assert.equal(await documentText(page), "$PQ/$");
});

test("auto fractions respect selections, read-only editors, and composition", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$PQ|$", { readOnly: true });
  await page.keyboard.press("/");
  assert.equal(await documentText(page), "$PQ$");
  await setDocument(page, "$PQ|$");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("/");
  assert.equal(await documentText(page), "$P/$");
  await setDocument(page, "$PQ|$");
  await page.evaluate(() => {
    const { view, CodeMirror } = window.fixture;
    view.dispatch({ effects: CodeMirror.StateEffect.appendConfig.of(CodeMirror.EditorState.allowMultipleSelections.of(true)) });
    view.dispatch({ selection: CodeMirror.EditorSelection.create([CodeMirror.EditorSelection.cursor(2), CodeMirror.EditorSelection.cursor(3)]) });
  });
  assert.equal(await page.evaluate(() => window.fixture.view.state.selection.ranges.length), 2);
  await page.keyboard.press("/");
  assert.equal(await documentText(page), "$P/Q/$");
  await setDocument(page, "$PQ|$");
  const editor = page.locator('[aria-label="Source Editor editing"]');
  await editor.dispatchEvent("compositionstart", { data: "" });
  await page.keyboard.press("/");
  assert.ok(!(await documentText(page)).includes("\\frac"));
  await editor.dispatchEvent("compositionend", { data: "" });
});

test("the installed model loads, offers a real completion, and learns from its acceptance", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  assert.equal(await page.evaluate(() => window.AutoTexPredictor.validateArtifact(window.AutoTexModel)), true);
  await observeFeedback(page);
  const before = await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  const suffix = await ghostText(page);
  assert.ok(suffix.trim().length > 0);
  const position = await page.evaluate(() => window.fixture.view.state.selection.main.head);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before.slice(0, position) + suffix + before.slice(position));
  await noGhost(page);
  const [session] = await feedbackSessions(page);
  assert.equal(session.events.length, 1);
  assert.equal(session.events[0].accepted, true);
  assert.equal(session.events[0].result, true);
  assert.equal(session.events[0].finiteFeatures, true);
  assert.equal(session.state.updates, 1);
});

test("Tab calibrates once using the original ranked features after matching typing; Undo is unlabeled", async (t) => {
  const page = await fixture(t);
  await observeFeedback(page);
  await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.keyboard.type(" + b");
  assert.equal(await ghostText(page), "^2 = c^2");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2 + b^2 = c^2$");
  let [session] = await feedbackSessions(page);
  assert.deepEqual(session.events, [{
    accepted: true, insertText: "^2 = c^2", sameSnapshot: true,
    featureCount: 18, finiteFeatures: true, result: true,
  }]);
  assert.equal(session.state.updates, 1);
  assert.ok(session.state.weightNorm > 0, "Acceptance should update the document calibration");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await noGhost(page);
  [session] = await feedbackSessions(page);
  assert.equal(session.events.length, 1, "Undo must not be interpreted as rejection");
  assert.equal(session.state.updates, 1);
});

test("only Escape on a visible suggestion records explicit rejection", async (t) => {
  const page = await fixture(t);
  await observeFeedback(page);
  const before = await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.keyboard.press("Escape");
  await noGhost(page);
  await page.keyboard.press("Escape");
  const [session] = await feedbackSessions(page);
  assert.deepEqual(session.events, [{
    accepted: false, insertText: " + b^2 = c^2", sameSnapshot: true,
    featureCount: 18, finiteFeatures: true, result: true,
  }]);
  assert.equal(session.state.updates, 1);
  assert.ok(session.state.weightNorm > 0, "Explicit rejection should update the document calibration");
  assert.equal(await documentText(page), before);
});

test("a host editor transaction filter that blocks Tab insertion does not record acceptance", async (t) => {
  const page = await fixture(t);
  await observeFeedback(page);
  await setDocument(page, "$a^2 + b^2 = c^2$\n$a^|$");
  await page.evaluate(() => {
    const { view, CodeMirror } = window.fixture;
    view.dispatch({ effects: CodeMirror.StateEffect.appendConfig.of(
      CodeMirror.EditorState.transactionFilter.of((transaction) =>
        transaction.isUserEvent("input.complete.math") ? [] : transaction),
    ) });
  });
  await page.keyboard.type("2");
  await ghostText(page);
  const before = await documentText(page);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before);
  const [session] = await feedbackSessions(page);
  assert.deepEqual(session.events, []);
  assert.equal(session.state.updates, 0);
});

test("navigation, blur, divergent typing, and document switches never record rejection", async (t) => {
  const page = await fixture(t);
  await observeFeedback(page);
  for (const action of ["navigation", "blur", "typing", "switch"]) {
    await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
    await ghostText(page);
    if (action === "navigation") await page.keyboard.press("ArrowLeft");
    if (action === "blur") await page.getByRole("button", { name: "Outside the editor" }).click();
    if (action === "typing") await page.keyboard.type("z");
    if (action === "switch") await setDocument(page, "Different document|");
    const sessions = await feedbackSessions(page);
    assert.ok(sessions.every(({ events, state }) => events.length === 0 && state.updates === 0), action);
  }
});

test("document calibration survives edits and preferences, and resets when switching files", async (t) => {
  const page = await fixture(t);
  await observeFeedback(page);
  await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.keyboard.press("Tab");
  const [accepted] = await feedbackSessions(page);
  assert.equal(accepted.state.updates, 1);
  await page.keyboard.type(" ");
  await page.evaluate(() => window.fixture.configure({ debounceMs: 45 }));
  const [edited] = await feedbackSessions(page);
  assert.equal(edited.resets, 0);
  assert.deepEqual(edited.state, accepted.state, "Edits and preference changes must keep feedback in this document");
  await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  const [previous, next] = await feedbackSessions(page);
  assert.equal(previous.resets, 1);
  assert.equal(previous.state.updates, 0);
  assert.equal(next.state.updates, 0);
  assert.equal(next.state.weightNorm, 0);
  assert.deepEqual(next.events, []);
});

test("grey inline expression preview leaves the document untouched; Tab inserts once", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$a^2 + b^2 = c^2$\n$|$");
  await page.keyboard.type("a^2");
  const before = "$a^2 + b^2 = c^2$\n$a^2$";
  assert.equal(await ghostText(page), " + b^2 = c^2");
  assert.equal(await documentText(page), before);
  const color = await page.locator(ghostSelector).first().evaluate((element) => getComputedStyle(element).color);
  const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number);
  assert.ok(Math.max(...channels) - Math.min(...channels) < 50, `Preview should have a neutral grey color, received ${color}`);
  assert.ok(channels.every((channel) => channel > 60 && channel < 220), `Preview should be visibly muted, received ${color}`);
  await page.screenshot({ path: path.join(root, "test-results/inline-preview.png"), fullPage: true });
  await page.keyboard.press("Tab");
  const completed = "$a^2 + b^2 = c^2$\n$a^2 + b^2 = c^2$";
  assert.equal(await documentText(page), completed);
  await noGhost(page);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), completed);
  assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
});

test("undo removes accepted completion independently of the user's typed prefix", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$a^2 + b^2 = c^2$\n$a^|$");
  await page.keyboard.type("2");
  await ghostText(page);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2 + b^2 = c^2$");
  const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
  await page.keyboard.press(undoKey);
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2$");
  await page.keyboard.press(undoKey);
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^$");
});

test("Escape dismisses the preview until another edit", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.keyboard.press("Escape");
  await noGhost(page);
  await page.waitForTimeout(200);
  assert.equal(await page.locator(ghostSelector).count(), 0);
  assert.equal(await documentText(page), before);
  await page.keyboard.type(" ");
  assert.equal(await ghostText(page), "+ b^2 = c^2");
});

test("indexed sequence insertion respects the existing closing brace", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "${x_1,x_2|}$");
  assert.equal(await ghostText(page), ",\\ldots,x_n");
  assert.equal(await documentText(page), before);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "${x_1,x_2,\\ldots,x_n}$");
});

test("the installed model completes a multi-character list after typed dots and supports Undo", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  const before = await setDocument(page, "$ba_1,ba_2,...|$");
  assert.equal(await ghostText(page), ",ba_n");
  assert.equal(await documentText(page), before);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$ba_1,ba_2,...,ba_n$");
  await noGhost(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await documentText(page), before);
  await noGhost(page);
});

test("multi-character lists use the matching document endpoint without replacing typed dots", async (t) => {
  const page = await fixture(t);
  const prior = "$ba_1,ba_2,\\cdots,ba_M$\n";
  await setDocument(page, prior + "$ba_1,ba_2,...,|$");
  assert.equal(await ghostText(page), "ba_M");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), prior + "$ba_1,ba_2,...,ba_M$");
  await noGhost(page);
});

test("multi-character sequence completions preserve braced indices and finish a partial second index", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "${ba_{1},ba_{2},...|}$");
  assert.equal(await ghostText(page), ",ba_{n}");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "${ba_{1},ba_{2},...,ba_{n}}$");
  await noGhost(page);
  await setDocument(page, "$ba_1,ba_|$");
  assert.equal(await ghostText(page), "2,\\ldots,ba_n");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$ba_1,ba_2,\\ldots,ba_n$");
  await noGhost(page);
});

test("the installed model advances product indices together and supports Undo", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  const before = await setDocument(page, "$a_1b_1,a_2b_2,...|$");
  assert.equal(await ghostText(page), ",a_nb_n");
  assert.equal(await documentText(page), before);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a_1b_1,a_2b_2,...,a_nb_n$");
  await noGhost(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await documentText(page), before);
  await noGhost(page);
});

test("product lists preserve per-factor braces and use matching whole-product endpoints", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "${a_{1}b_1,a_{2}b_2,...|}$");
  assert.equal(await ghostText(page), ",a_{n}b_n");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "${a_{1}b_1,a_{2}b_2,...,a_{n}b_n}$");
  await noGhost(page);
  const prior = "$a_1b_1,a_2b_2,\\cdots,a_Mb_M$\n";
  await setDocument(page, prior + "$a_1b_1,a_2b_2,...,|$");
  assert.equal(await ghostText(page), "a_Mb_M");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), prior + "$a_1b_1,a_2b_2,...,a_Mb_M$");
  await noGhost(page);
});

test("product lists finish a partial second term and a partial synchronized endpoint", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$a_1b_1,a_2b_|$");
  assert.equal(await ghostText(page), "2,\\ldots,a_nb_n");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a_1b_1,a_2b_2,\\ldots,a_nb_n$");
  await noGhost(page);
  await setDocument(page, "$a_1b_1,a_2b_2,...,a_nb_|$");
  assert.equal(await ghostText(page), "n");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a_1b_1,a_2b_2,...,a_nb_n$");
  await noGhost(page);
});

test("structural function lists complete the whole repeated term with the installed model", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  for (const [input, completion] of [
    ["r_1f(x_1)+r_2f(x_2)", "+\\cdots+r_nf(x_n)"],
    ["r_1f(x_1)+r_2f(x_2)+...", "+r_nf(x_n)"],
  ]) {
    const before = "$" + input + "$";
    if (input.endsWith("...")) await setDocument(page, "$" + input + "|$");
    else {
      await setDocument(page, "$|$");
      await page.keyboard.type(input, { delay: 40 });
    }
    assert.equal(await ghostText(page), completion);
    assert.equal(await documentText(page), before);
    assert.equal((await shortcutSnapshot(page, "BracketRight", "]")).ghost, completion,
      "Token predictions must not compete with a recognized structural list");
    await page.keyboard.press("Tab");
    assert.equal(await documentText(page), "$" + input + completion + "$");
    await noGhost(page);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    assert.equal(await documentText(page), before);
    await noGhost(page);
  }
});

test("structural function lists complete partial terms and endpoints with paired closers", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  for (const [input, completion, completed] of [
    ["$r_1f(x_1)+r_2f(x_|)$", "2)+\\cdots+r_nf(x_n", "$r_1f(x_1)+r_2f(x_2)+\\cdots+r_nf(x_n)$"],
    ["$r_1f(x_1)+r_2f(x_2)+...+r_nf(x_|)$", "n", "$r_1f(x_1)+r_2f(x_2)+...+r_nf(x_n)$"],
    ["$r_1f(x_1)+r_2f(x_2)+...+r_mf(x_{|})$", "m", "$r_1f(x_1)+r_2f(x_2)+...+r_mf(x_{m})$"],
  ]) {
    await setDocument(page, input);
    assert.equal(await ghostText(page), completion, input);
    await page.keyboard.press("Tab");
    assert.equal(await documentText(page), completed, input);
    await noGhost(page);
  }
});

test("structural function lists use matching document endpoints without changing the typed ellipsis", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  const prior = "$r_1f(x_1)+r_2f(x_2)+\\cdots+r_Mf(x_M)$\n";
  await setDocument(page, prior + "$r_1f(x_1)+r_2f(x_2)+...|$");
  assert.equal(await ghostText(page), "+r_Mf(x_M)");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), prior + "$r_1f(x_1)+r_2f(x_2)+...+r_Mf(x_M)$");
  await noGhost(page);
});

test("structural function lists replace a continued ordinary preview once the pattern is clear", async (t) => {
  const page = await fixture(t);
  const prior = "$r_1f(x_1)+r_2f(x_2)+q$\n";
  await setDocument(page, prior + "$r_1f(x_1)+|$");
  assert.equal(await ghostText(page), "r_2f(x_2)+q");
  await page.keyboard.type("r_2f(x_2)");
  assert.equal(await ghostText(page), "+\\cdots+r_nf(x_n)");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), prior + "$r_1f(x_1)+r_2f(x_2)+\\cdots+r_nf(x_n)$");
  await noGhost(page);
});

test("structural function lists remain independent of expression settings and learned feedback", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  await observeFeedback(page);
  await page.evaluate(() => window.fixture.configure({ expressions: false, minPrefix: 20 }));
  for (const action of ["Tab", "Escape"]) {
    await setDocument(page, "$r_1f(x_1)+r_2f(x_2)|$");
    assert.equal(await ghostText(page), "+\\cdots+r_nf(x_n)");
    await page.keyboard.press(action);
    await noGhost(page);
    const session = (await feedbackSessions(page)).at(-1);
    assert.equal(session.state.updates, 0, action + " on a structural list must not recalibrate token prediction");
    assert.ok(session.events.every((event) => event.result === false));
  }
  await page.evaluate(() => window.fixture.configure({ sequences: false }));
  await setDocument(page, "$r_1f(x_1)+r_2f(x_2)|$");
  await noGhost(page);
  await page.evaluate(() => window.fixture.configure({ expressions: true, minPrefix: 3 }));
  await setDocument(page, "$f(x)=x+1$\n$f(x)|$");
  assert.ok((await ghostText(page)).trim());
});

test("fixed-index lists preserve unchanged arguments while typing with the installed model", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  await observeFeedback(page);
  await page.evaluate(() => window.fixture.configure({ expressions: false }));
  await setDocument(page, "$|$");
  const input = "r_1f(x_1,y_j)+r_2f(x_2,y_j)";
  await page.keyboard.type(input, { delay: 40 });
  const before = "$" + input + "$";
  assert.equal(await ghostText(page), "+\\cdots+r_nf(x_n,y_j)");
  assert.equal(await documentText(page), before);
  assert.equal((await shortcutSnapshot(page, "BracketRight", "]")).ghost, "+\\cdots+r_nf(x_n,y_j)");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$" + input + "+\\cdots+r_nf(x_n,y_j)$");
  await noGhost(page);
  assert.equal((await feedbackSessions(page)).at(-1).state.updates, 0);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await documentText(page), before);
  await noGhost(page);
});

test("fixed-index lists complete partial terms, implicit products and fixed endpoint slots", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  for (const [input, completion, completed] of [
    ["$r_1f(x_1,y_j)+r_2f(x_|)$", "2,y_j)+\\cdots+r_nf(x_n,y_j", "$r_1f(x_1,y_j)+r_2f(x_2,y_j)+\\cdots+r_nf(x_n,y_j)$"],
    ["$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...|$", "+r_nf(x_n,y_j)", "$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...+r_nf(x_n,y_j)$"],
    ["$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...+r_mf(x_m,y_|)$", "j", "$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...+r_mf(x_m,y_j)$"],
    ["$a_7b_1+a_7b_|$", "2+\\cdots+a_7b_n", "$a_7b_1+a_7b_2+\\cdots+a_7b_n$"],
    ["$r_7f(x_1,y_7)+r_7f(x_|)$", "2,y_7)+\\cdots+r_7f(x_n,y_7", "$r_7f(x_1,y_7)+r_7f(x_2,y_7)+\\cdots+r_7f(x_n,y_7)$"],
    ["$a_1a_2 a_2a_2|$", " \\cdots a_na_2", "$a_1a_2 a_2a_2 \\cdots a_na_2$"],
  ]) {
    await setDocument(page, input);
    assert.equal(await ghostText(page), completion, input);
    await page.keyboard.press("Tab");
    assert.equal(await documentText(page), completed, input);
    await noGhost(page);
  }
});

test("fixed-index lists distinguish fixed numbers from the linked changing indices", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  for (const fixed of ["7", "1"]) {
    const input = "r_1f(x_1,y_" + fixed + ")+r_2f(x_2,y_" + fixed + ")+...";
    await setDocument(page, "$" + input + "|$");
    const completion = "+r_nf(x_n,y_" + fixed + ")";
    assert.equal(await ghostText(page), completion);
    await page.keyboard.press("Tab");
    assert.equal(await documentText(page), "$" + input + completion + "$");
    await noGhost(page);
  }
});

test("list final-index hierarchy avoids occupied variables and falls back to n when exhausted", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  for (const [prefix, finalIndex] of [["", "k"], ["k=", "j"], ["k+j=", "i"], ["k+j+i=", "n"]]) {
    const input = prefix + "a_1n_1+a_2n_2+...";
    await setDocument(page, "$" + input + "|$");
    const completion = "+a_" + finalIndex + "n_" + finalIndex;
    assert.equal(await ghostText(page), completion, input);
    await page.keyboard.press("Tab");
    assert.equal(await documentText(page), "$" + input + completion + "$", input);
    await noGhost(page);
  }
});

test("list final-index hierarchy reads both sides of this equation and ignores command names and other equations", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$a_1n_1+a_2n_2+...|=k$");
  assert.equal(await ghostText(page), "+a_jn_j");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a_1n_1+a_2n_2+...+a_jn_j=k$");
  await noGhost(page);
  const prior = "$n+k+j+i$ Prose n k j i\n";
  await setDocument(page, prior + "$\\sin(0)=a_1+a_2+...|$");
  assert.equal(await ghostText(page), "+a_n");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), prior + "$\\sin(0)=a_1+a_2+...+a_n$");
  await noGhost(page);
});

test("list final-index hierarchy retains stronger document and explicit endpoint choices", async (t) => {
  const page = await fixture(t);
  const prior = "$r_1f(x_1,y_j)+r_2f(x_2,y_j)+\\cdots+r_Mf(x_M,y_j)$\n";
  await setDocument(page, prior + "$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...|$");
  assert.equal(await ghostText(page), "+r_Mf(x_M,y_j)");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), prior + "$r_1f(x_1,y_j)+r_2f(x_2,y_j)+...+r_Mf(x_M,y_j)$");
  await noGhost(page);
  await page.evaluate(() => window.fixture.configure({ sequenceEnd: "m" }));
  await setDocument(page, "$a_1n_1+a_2n_2+...|$");
  assert.equal(await ghostText(page), "+a_mn_m");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a_1n_1+a_2n_2+...+a_mn_m$");
  await noGhost(page);
});

test("indexed chains preserve sum product and relation separators on acceptance", async (t) => {
  const page = await fixture(t);
  for (const [input, completion] of [
    ["x_1+x_2", "+\\cdots+x_n"],
    ["x_1\\cdot x_2", "\\cdot \\cdots\\cdot x_n"],
    ["A_1 \\subseteq A_2", " \\subseteq \\cdots \\subseteq A_n"],
    ["x_1 \\le x_2", " \\le \\cdots \\le x_n"],
  ]) {
    const before = await setDocument(page, "$" + input + "|$");
    assert.equal(await ghostText(page), completion, input);
    assert.equal(await documentText(page), before);
    await page.keyboard.press("Tab");
    assert.equal(await documentText(page), "$" + input + completion + "$", input);
    await noGhost(page);
  }
});

test("indexed chains advance synchronized sum factors and keep typed ellipses", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$a_1b_1+a_2b_2|$");
  assert.equal(await ghostText(page), "+\\cdots+a_nb_n");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a_1b_1+a_2b_2+\\cdots+a_nb_n$");
  await noGhost(page);
  await setDocument(page, "$A_1 \\subseteq A_2 \\subseteq ...|$");
  assert.equal(await ghostText(page), " \\subseteq A_n");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$A_1 \\subseteq A_2 \\subseteq ... \\subseteq A_n$");
  await noGhost(page);
});

test("nested indexed products preserve exponent structure and support independent Undo", async (t) => {
  const page = await fixture(t, { bundledModel: true });
  const before = await setDocument(page, "$a=p_1^{k_1}p_2^{k_2}...|$");
  assert.equal(await ghostText(page), "p_n^{k_n}");
  assert.equal(await documentText(page), before);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a=p_1^{k_1}p_2^{k_2}...p_n^{k_n}$");
  await noGhost(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await documentText(page), before);
  await noGhost(page);
  await setDocument(page, "$p_1^2p_2^2|$");
  assert.equal(await ghostText(page), "\\cdots p_n^2");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$p_1^2p_2^2\\cdots p_n^2$");
  await noGhost(page);
});

test("nested indexed products finish partial terms and honor the configured final index", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$p_1^{k_1}p_2^{k_|}$");
  assert.equal(await ghostText(page), "2}\\cdots p_n^{k_n");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$p_1^{k_1}p_2^{k_2}\\cdots p_n^{k_n}$");
  await noGhost(page);
  await setDocument(page, "$p_1^{k_1}p_2^{k_2}...p_{m|}$");
  assert.equal(await ghostText(page), "}^{k_m");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$p_1^{k_1}p_2^{k_2}...p_{m}^{k_m}$");
  await noGhost(page);
  await page.evaluate(() => window.fixture.configure({ sequenceEnd: "m" }));
  await setDocument(page, "$a=p_1^{k_1}p_2^{k_2}...|$");
  assert.equal(await ghostText(page), "p_m^{k_m}");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a=p_1^{k_1}p_2^{k_2}...p_m^{k_m}$");
  await noGhost(page);
  await setDocument(page, "$p_1^{k_1}p_2^{k_2}...p_m^{k_|}$");
  assert.equal(await ghostText(page), "m");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$p_1^{k_1}p_2^{k_2}...p_m^{k_m}$");
  await noGhost(page);
});

test("nested indexed products reuse a matching full-pattern document endpoint", async (t) => {
  const page = await fixture(t);
  const prior = "$p_1^{k_1}p_2^{k_2}\\cdots p_M^{k_M}$\n";
  await setDocument(page, prior + "$a=p_1^{k_1}p_2^{k_2}...|$");
  assert.equal(await ghostText(page), "p_M^{k_M}");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), prior + "$a=p_1^{k_1}p_2^{k_2}...p_M^{k_M}$");
  await noGhost(page);
});

test("indexed chains reject mixed separators and mismatched nested indices", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.configure({ expressions: false }));
  for (const input of [
    "$x_1+x_2,...|$",
    "$A_1 \\subseteq A_2 \\supseteq ...|$",
    "$p_1^{k_1}p_2^{k_3}...|$",
    "$p_1^{k_1}p_2^{r_2}...|$",
  ]) {
    const before = await setDocument(page, input);
    await noGhost(page);
    assert.equal(await documentText(page), before, input);
  }
});

test("switching to a new document clears suggestions and old expression sources", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  const next = await setDocument(page, "$a^2|$");
  await noGhost(page);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), next);
  assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
});

test("a nonempty selection dismisses the suggestion and prevents acceptance", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.keyboard.press("Shift+ArrowLeft");
  await noGhost(page);
  assert.equal(await page.evaluate(() => window.fixture.view.state.selection.main.empty), false);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before);
});

test("read-only mode removes an existing suggestion and never inserts it", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.evaluate(() => window.fixture.setReadOnly(true));
  await noGhost(page);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before);
  await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$", { readOnly: true });
  await noGhost(page);
});

test("IME composition prevents Tab from accepting a pending suggestion", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.locator('[aria-label="Source Editor editing"]').dispatchEvent("compositionstart", { data: "" });
  await page.waitForFunction(() => window.fixture.view.compositionStarted);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before);
  await page.locator('[aria-label="Source Editor editing"]').dispatchEvent("compositionend", { data: "" });
});

test("Tab continues to the editor's own shortcut when there is no suggestion", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "Ordinary prose|");
  await noGhost(page);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
  assert.equal(await documentText(page), before);
});

test("live preferences disable suggestions and reenable them for the next edit", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.evaluate(() => window.fixture.configure({ enabled: false }));
  await noGhost(page);
  await page.keyboard.type(" ");
  await noGhost(page);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2 $");
  assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
  await page.evaluate(() => window.fixture.configure({ enabled: true }));
  await page.keyboard.type("+");
  assert.equal(await ghostText(page), " b^2 = c^2");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2 + b^2 = c^2$");
});

test("sequence preference changes use the numeric endpoint and disable only sequences", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.configure({ sequenceEnd: "10" }));
  await setDocument(page, "$x_1,x_2|$");
  assert.equal(await ghostText(page), ",\\ldots,x_{10}");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$x_1,x_2,\\ldots,x_{10}$");
  await page.evaluate(() => window.fixture.configure({ sequences: false }));
  await setDocument(page, "$x_1,x_2|$");
  await noGhost(page);
  await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  assert.equal(await ghostText(page), " + b^2 = c^2");
});

test("moving the cursor clears the preview and cannot insert a stale suffix", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.keyboard.press("ArrowLeft");
  await noGhost(page);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before);
  assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
  await page.keyboard.press("ArrowRight");
  await noGhost(page);
});

test("blur dismisses the preview without changing document content", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "$a^2 + b^2 = c^2$\n$a^2|$");
  await ghostText(page);
  await page.getByRole("button", { name: "Outside the editor" }).click();
  await noGhost(page);
  assert.equal(await page.evaluate(() => window.fixture.view.hasFocus), false);
  assert.equal(await documentText(page), before);
});

async function popupFixture(t, initialSettings) {
  const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], "The popup should have no uncaught browser errors");
  });
  await page.addInitScript((initialSettings) => {
    const key = "fixtureChromeStorage";
    if (initialSettings && !sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, JSON.stringify({ mathAutocompleteSettings: initialSettings }));
    }
    const read = () => JSON.parse(sessionStorage.getItem(key) || "{}");
    window.chrome = {
      storage: {
        local: {
          async get(name) { return { [name]: read()[name] }; },
          async set(values) { sessionStorage.setItem(key, JSON.stringify({ ...read(), ...values })); },
        },
      },
      tabs: {
        async query() { return [{ id: 1 }]; },
        async sendMessage() { return { status: "connected" }; },
      },
    };
    window.popupPreferences = () => read().mathAutocompleteSettings;
  }, initialSettings);
  await page.goto(`${baseURL}/extension/popup.html`);
  await page.waitForFunction(() => !document.getElementById("enabled").disabled);
  await page.waitForFunction(() => document.getElementById("connection-label").textContent === "Connected to your editor");
  return page;
}

test("popup renders connection state and persists validated preferences", async (t) => {
  const page = await popupFixture(t);
  assert.equal(await page.locator("#sequence-end").inputValue(), "n");
  assert.equal(await page.locator("#autoFractions").isChecked(), true);
  await page.screenshot({ path: path.join(root, "test-results/popup.png"), fullPage: true });

  await page.locator("#expressions").uncheck();
  await page.waitForFunction(() => window.popupPreferences()?.expressions === false);
  await page.locator("#autoFractions").uncheck();
  await page.waitForFunction(() => window.popupPreferences()?.autoFractions === false);
  await page.locator("#sequences").uncheck();
  assert.equal(await page.locator("#sequence-end").isDisabled(), true);
  await page.locator("#sequences").check();
  await page.locator("#sequence-end").fill("9");
  await page.waitForFunction(() => window.popupPreferences()?.sequenceEnd === "9");

  await page.locator("#sequence-end").fill("2");
  assert.equal(await page.locator("#sequence-error").isVisible(), true);
  assert.equal(await page.locator("#sequence-end").getAttribute("aria-invalid"), "true");
  assert.equal(await page.evaluate(() => window.popupPreferences().sequenceEnd), "9");
  await page.locator("#sequence-end").fill("m");
  await page.waitForFunction(() => window.popupPreferences()?.sequenceEnd === "m");
  assert.equal(await page.locator("#sequence-error").isVisible(), false);
  await page.locator("#enabled").uncheck();
  await page.waitForFunction(() => window.popupPreferences()?.enabled === false);
  assert.equal(await page.locator("#connection-label").textContent(), "AutoTeX is paused");
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("enabled").disabled);
  assert.equal(await page.locator("#enabled").isChecked(), false);
  assert.equal(await page.locator("#expressions").isChecked(), false);
  assert.equal(await page.locator("#autoFractions").isChecked(), false);
  assert.equal(await page.locator("#sequences").isChecked(), true);
  assert.equal(await page.locator("#sequence-end").inputValue(), "m");
});


test("popup suggestion controls preserve valid preferences and reject invalid prefix lengths", async (t) => {
  const page = await popupFixture(t);
  assert.equal(await page.locator("#automaticSuggestions").isChecked(), true);
  assert.equal(await page.locator("#suggestion-delay").inputValue(), "50");
  assert.equal(await page.locator("#min-prefix").inputValue(), "3");
  await page.locator("#automaticSuggestions").uncheck();
  await page.waitForFunction(() => window.popupPreferences()?.automaticSuggestions === false);
  assert.equal(await page.locator("#suggestion-delay").isDisabled(), true);
  assert.equal(await page.locator("#autoFractions").isChecked(), true);
  await page.locator("#automaticSuggestions").check();
  await page.locator("#suggestion-delay").selectOption("500");
  await page.waitForFunction(() => window.popupPreferences()?.debounceMs === 500);
  await page.locator("#min-prefix").fill("7");
  await page.waitForFunction(() => window.popupPreferences()?.minPrefix === 7);
  for (const invalid of ["0", "21", "2.5", ""]) {
    await page.locator("#min-prefix").fill(invalid);
    assert.equal(await page.locator("#min-prefix").getAttribute("aria-invalid"), "true", invalid);
    assert.equal(await page.locator("#prefix-error").isVisible(), true, invalid);
    assert.equal(await page.evaluate(() => window.popupPreferences().minPrefix), 7, invalid);
  }
  await page.locator("#min-prefix").fill("5");
  await page.waitForFunction(() => window.popupPreferences()?.minPrefix === 5);
  assert.equal(await page.locator("#prefix-error").isVisible(), false);
  await page.locator("#expressions").uncheck();
  await page.waitForFunction(() => window.popupPreferences()?.expressions === false);
  assert.equal(await page.locator("#min-prefix").isDisabled(), true);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("enabled").disabled);
  assert.equal(await page.locator("#automaticSuggestions").isChecked(), true);
  assert.equal(await page.locator("#suggestion-delay").inputValue(), "500");
  assert.equal(await page.locator("#min-prefix").inputValue(), "5");
  assert.equal(await page.locator("#min-prefix").isDisabled(), true);
});

test("popup keeps custom stored delays when changing another setting", async (t) => {
  const page = await popupFixture(t, { debounceMs: 375, minPrefix: 6, automaticSuggestions: false });
  assert.equal(await page.locator("#suggestion-delay").inputValue(), "375");
  assert.equal(await page.locator("#suggestion-delay").isDisabled(), true);
  assert.equal(await page.locator("#min-prefix").inputValue(), "6");
  await page.locator("#autoFractions").uncheck();
  await page.waitForFunction(() => window.popupPreferences()?.autoFractions === false);
  assert.equal(await page.evaluate(() => window.popupPreferences().debounceMs), 375);
  assert.equal(await page.evaluate(() => window.popupPreferences().automaticSuggestions), false);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("enabled").disabled);
  assert.equal(await page.locator("#suggestion-delay").inputValue(), "375");
});

test("popup follows the system theme and fits its compact width", async (t) => {
  const page = await popupFixture(t);
  const backgrounds = [];
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    const layout = await page.evaluate(() => ({
      background: getComputedStyle(document.documentElement).backgroundColor,
      width: document.documentElement.scrollWidth,
      height: document.body.scrollHeight,
      controls: [...document.querySelectorAll("input, select")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { id: element.id, left: rect.left, right: rect.right };
      }),
    }));
    backgrounds.push(layout.background);
    assert.ok(layout.width <= 320, colorScheme + " popup must not overflow horizontally");
    assert.ok(layout.height <= 600, colorScheme + " popup should fit without scrolling");
    for (const control of layout.controls) {
      assert.ok(control.left >= 0 && control.right <= 320, colorScheme + " " + control.id);
    }
    await page.screenshot({ path: path.join(root, "test-results/popup-" + colorScheme + ".png"), fullPage: true });
  }
  assert.notEqual(backgrounds[0], backgrounds[1]);
  assert.match(await page.locator("body").textContent(), /Option/);
});


// A long delay makes disappearance during ordinary typing observable: the
// assertions below run in the same task as dispatch, before any timer can refill
// the preview. The real engine still chooses the initial suggestion.
async function stableGhostFixture(t, marked, { autoCloseBrackets = false } = {}) {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.configure({ debounceMs: 1200 }));
  await page.evaluate(() => {
    window.fixture.suggestionCalls = 0;
    const create = window.MathAutocompleteEngine.createEngine;
    window.MathAutocompleteEngine.createEngine = (...args) => {
      const engine = create(...args);
      const suggest = engine.suggest;
      engine.suggest = (...values) => {
        window.fixture.suggestionCalls++;
        return suggest(...values);
      };
      return engine;
    };
  });
  await setDocument(page, marked);
  if (autoCloseBrackets) {
    await page.evaluate(() => {
      const { view, CodeMirror } = window.fixture;
      view.dispatch({ effects: CodeMirror.StateEffect.appendConfig.of(CodeMirror.closeBrackets()) });
    });
  }
  await ghostText(page);
  await page.evaluate(() => {
    window.fixture.originalGhostNode = window.fixture.view.dom.querySelector(".ol-math-ghost");
    window.fixture.initialSuggestionCalls = window.fixture.suggestionCalls;
  });
  return page;
}

async function typeAndSnapshot(page, text) {
  return page.evaluate((text) => {
    const snapshots = [];
    const { view } = window.fixture;
    for (const character of text) {
      const position = view.state.selection.main.head;
      view.dispatch({
        changes: { from: position, insert: character },
        selection: { anchor: position + character.length },
        userEvent: "input.type",
      });
      const node = view.dom.querySelector(".ol-math-ghost");
      snapshots.push({
        character,
        ghost: node?.textContent ?? null,
        sameNode: Boolean(node) && node === window.fixture.originalGhostNode,
        calls: window.fixture.suggestionCalls,
        baselineCalls: window.fixture.initialSuggestionCalls,
        document: view.state.doc.toString(),
      });
    }
    return snapshots;
  }, text);
}

function assertStableSnapshots(snapshots, expectedSuffixes) {
  assert.equal(snapshots.length, expectedSuffixes.length);
  snapshots.forEach((snapshot, index) => {
    const reason = "immediately after character " + JSON.stringify(snapshot.character) + " at step " + index;
    assert.equal(snapshot.ghost, expectedSuffixes[index], reason);
    assert.equal(snapshot.sameNode, true, "The existing grey widget must be reused " + reason);
    assert.equal(snapshot.calls, snapshot.baselineCalls, "Matching input must not re-rank the suggestion " + reason);
  });
}

test("matching characters consume the visible expression immediately without a debounce gap", async (t) => {
  const page = await stableGhostFixture(t, "$a^2 + b^2 = c^2$\n$a^2|$");
  const snapshots = await typeAndSnapshot(page, " + b");
  assertStableSnapshots(snapshots, [
    "+ b^2 = c^2",
    " b^2 = c^2",
    "b^2 = c^2",
    "^2 = c^2",
  ]);
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2 + b$");
  // Even after the usual delay, the visible choice stays selected.
  await page.waitForTimeout(1350);
  assert.equal(await ghostText(page), "^2 = c^2");
  assert.equal(await page.evaluate(() => window.fixture.suggestionCalls), snapshots.at(-1).baselineCalls);
  assert.equal(await page.evaluate(() => window.fixture.view.dom.querySelector(".ol-math-ghost") === window.fixture.originalGhostNode), true);
});

test("extra horizontal spaces preserve the selected suggestion and all user whitespace", async (t) => {
  const page = await stableGhostFixture(t, "$a^2+b^2=c^2$\n$a^2|$");
  const snapshots = await typeAndSnapshot(page, "  +  b");
  assertStableSnapshots(snapshots, [
    "+b^2=c^2",
    "+b^2=c^2",
    "b^2=c^2",
    "b^2=c^2",
    "b^2=c^2",
    "^2=c^2",
  ]);
  const typed = "$a^2+b^2=c^2$\n$a^2  +  b$";
  assert.equal(await documentText(page), typed);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a^2+b^2=c^2$\n$a^2  +  b^2=c^2$");
  await noGhost(page);
});

test("typing matching symbols can omit optional source spaces without duplicating them", async (t) => {
  const page = await stableGhostFixture(t, "$a^2 + b^2 = c^2$\n$a^2|$");
  const snapshots = await typeAndSnapshot(page, "+b^2");
  assertStableSnapshots(snapshots, [
    " b^2 = c^2",
    "^2 = c^2",
    "2 = c^2",
    " = c^2",
  ]);
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2+b^2$");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2+b^2 = c^2$");
});

test("a partial indexed sequence stays visible while its next index and command are typed", async (t) => {
  const page = await stableGhostFixture(t, "$" + "{x_1,x_|}$");
  assert.equal(await ghostText(page), "2,\\ldots,x_n");
  const snapshots = await typeAndSnapshot(page, "2,\\l");
  assertStableSnapshots(snapshots, [
    ",\\ldots,x_n",
    "\\ldots,x_n",
    "ldots,x_n",
    "dots,x_n",
  ]);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$" + "{x_1,x_2,\\ldots,x_n}$");
  assert.equal(await page.locator(ghostSelector).count(), 0);
});

test("typing the entire suggestion removes it immediately and restores ordinary Tab", async (t) => {
  const page = await stableGhostFixture(t, "$a^2+b$\n$a^2|$");
  const snapshots = await typeAndSnapshot(page, "+b");
  assertStableSnapshots(snapshots.slice(0, 1), ["b"]);
  assert.equal(snapshots[1].ghost, null);
  const completed = "$a^2+b$\n$a^2+b$";
  assert.equal(await documentText(page), completed);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), completed);
  assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
  await page.waitForTimeout(1350);
  assert.equal(await page.locator(ghostSelector).count(), 0);
});

test("divergent characters and newlines clear the old preview in the same transaction", async (t) => {
  for (const character of ["z", "\n"]) {
    await t.test(JSON.stringify(character), async (child) => {
      const page = await stableGhostFixture(child, "$a^2 + b^2 = c^2$\n$a^2|$");
      const [snapshot] = await typeAndSnapshot(page, character);
      assert.equal(snapshot.ghost, null);
      assert.equal(snapshot.document, "$a^2 + b^2 = c^2$\n$a^2" + character + "$");
      await page.keyboard.press("Tab");
      assert.equal(await documentText(page), snapshot.document);
      assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
    });
  }
});

test("whitespace that changes a LaTeX command is not treated as a matching continuation", async (t) => {
  for (const [name, marked, character] of [
    ["space inside a control word", "$\\frac{x}{y}$\n$\\fra|$", " "],
    ["missing separator after a control word", "$\\sin x + 1$\n$\\sin|$", "x"],
  ]) {
    await t.test(name, async (child) => {
      const page = await stableGhostFixture(child, marked);
      const [snapshot] = await typeAndSnapshot(page, character);
      assert.equal(snapshot.ghost, null);
      await page.keyboard.press("Tab");
      assert.equal(await documentText(page), snapshot.document);
      assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
    });
  }
});

test("Tab accepts only the remaining suffix and Undo keeps the user's continued prefix", async (t) => {
  const initial = "$a^2 + b^2 = c^2$\n$a^2$";
  const page = await stableGhostFixture(t, "$a^2 + b^2 = c^2$\n$a^2|$");
  const snapshots = await typeAndSnapshot(page, "  +b");
  assertStableSnapshots(snapshots, [
    "+ b^2 = c^2",
    "+ b^2 = c^2",
    " b^2 = c^2",
    "^2 = c^2",
  ]);
  const continued = "$a^2 + b^2 = c^2$\n$a^2  +b$";
  assert.equal(await documentText(page), continued);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2  +b^2 = c^2$");
  const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
  await page.keyboard.press(undoKey);
  assert.equal(await documentText(page), continued);
  await noGhost(page);
  await page.keyboard.press(undoKey);
  assert.equal(await documentText(page), initial);
});

test("native keyboard input also retains the same grey widget after each matching keystroke", async (t) => {
  const page = await stableGhostFixture(t, "$a^2 + b^2 = c^2$\n$a^2|$");
  const expected = ["+ b^2 = c^2", " b^2 = c^2", "b^2 = c^2", "^2 = c^2"];
  for (let index = 0; index < expected.length; index++) {
    await page.keyboard.type(" + b"[index]);
    const snapshot = await page.evaluate(() => {
      const node = window.fixture.view.dom.querySelector(".ol-math-ghost");
      return {
        ghost: node?.textContent ?? null,
        sameNode: node === window.fixture.originalGhostNode,
        calls: window.fixture.suggestionCalls,
        baselineCalls: window.fixture.initialSuggestionCalls,
      };
    });
    assert.equal(snapshot.ghost, expected[index]);
    assert.equal(snapshot.sameNode, true);
    assert.equal(snapshot.calls, snapshot.baselineCalls);
  }
  assert.equal(await documentText(page), "$a^2 + b^2 = c^2$\n$a^2 + b$");
});


test("native automatic braces preserve a fraction preview through inserted pairs and closing skips", async (t) => {
  // At end of document, closeBrackets inserts each {} pair and positions the
  // cursor inside it. Typing } then uses CM's own identical-character replace.
  const page = await stableGhostFixture(t, "$\\frac{a}{b}$\n$\\fra|", { autoCloseBrackets: true });
  const characters = "c{a}{b}";
  const expected = ["{a}{b}", "a}{b", "}{b", "{b}", "b", null, null];
  const expectedDocuments = [
    "$\\frac{a}{b}$\n$\\frac",
    "$\\frac{a}{b}$\n$\\frac{}",
    "$\\frac{a}{b}$\n$\\frac{a}",
    "$\\frac{a}{b}$\n$\\frac{a}",
    "$\\frac{a}{b}$\n$\\frac{a}{}",
    "$\\frac{a}{b}$\n$\\frac{a}{b}",
    "$\\frac{a}{b}$\n$\\frac{a}{b}",
  ];
  for (let index = 0; index < characters.length; index++) {
    await page.keyboard.type(characters[index]);
    const snapshot = await page.evaluate(() => {
      const { view } = window.fixture;
      const node = view.dom.querySelector(".ol-math-ghost");
      return {
        ghost: node?.textContent ?? null,
        sameNode: node === window.fixture.originalGhostNode,
        document: view.state.doc.toString(),
        calls: window.fixture.suggestionCalls,
        baselineCalls: window.fixture.initialSuggestionCalls,
      };
    });
    assert.equal(snapshot.ghost, expected[index], "after native input " + index + ": " + characters[index]);
    if (expected[index] !== null) assert.equal(snapshot.sameNode, true, "Keep the same preview node across automatic braces");
    assert.equal(snapshot.document, expectedDocuments[index]);
    assert.equal(snapshot.calls, snapshot.baselineCalls);
  }
  assert.equal(await page.evaluate(() => window.fixture.view.state.selection.main.head), expectedDocuments.at(-1).length);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), expectedDocuments.at(-1));
  assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
});

test("Tab after typing into an automatically paired brace inserts the remaining fraction once", async (t) => {
  const page = await stableGhostFixture(t, "$\\frac{a}{b}$\n$\\fra|", { autoCloseBrackets: true });
  await page.keyboard.type("c{a");
  const before = "$\\frac{a}{b}$\n$\\frac{a}";
  assert.equal(await documentText(page), before);
  // The existing paired } supplies the final denominator brace upon acceptance.
  assert.equal(await page.locator(ghostSelector).textContent(), "}{b");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$\\frac{a}{b}$\n$\\frac{a}{b}");
  const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
  await page.keyboard.press(undoKey);
  assert.equal(await documentText(page), before);
});

test("a closer borrowed by the initial preview survives typing past its original pair", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.configure({ debounceMs: 1200 }));
  await setDocument(page, "$f(ab)+g(b)$\n$|");
  await page.evaluate(() => {
    const { view, CodeMirror } = window.fixture;
    view.dispatch({ effects: CodeMirror.StateEffect.appendConfig.of(CodeMirror.closeBrackets()) });
  });
  // Create the pair through real keyboard input before the first suggestion.
  // f(a is three characters, so this exercises the default prefix threshold.
  await page.keyboard.type("f(a");
  assert.equal(await documentText(page), "$f(ab)+g(b)$\n$f(a)");
  assert.equal(await ghostText(page), "b)+g(b");
  await page.keyboard.type("b");
  const beforeClosingSkip = "$f(ab)+g(b)$\n$f(ab)";
  assert.equal(await documentText(page), beforeClosingSkip);
  await page.keyboard.type(")");
  assert.equal(await documentText(page), beforeClosingSkip, "The existing paired closer should be skipped, not inserted again");
  assert.equal(await page.evaluate(() => window.fixture.view.state.selection.main.head), beforeClosingSkip.length);
  assert.equal(await page.locator(ghostSelector).textContent(), "+g(b)", "The final closer is still required after the original closer has been consumed");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$f(ab)+g(b)$\n$f(ab)+g(b)");
  await noGhost(page);
});

test("formula reuse prioritizes the current list item over a repeated neighboring formula", async (t) => {
  const page = await fixture(t);
  const marked = "\\begin{enumerate}\n" +
    "\\item $f(x)=x+1$. Also $f(x)=x+1$.\n" +
    "\\item $f(x)=x+2$. Therefore $f(x)|$.\n" +
    "\\item $f(x)=x+1$.\n\\end{enumerate}";
  await setDocument(page, marked);
  assert.equal(await ghostText(page), "=x+2");
  await page.keyboard.type("=x");
  assert.equal(await page.locator(ghostSelector).textContent(), "+2");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), marked.replace("f(x)|", "f(x)=x+2"));
});

test("closing math clears the preview and prose cannot acquire a new one", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$a^2+b^2=c^2$\n$a^2|");
  await ghostText(page);
  await page.keyboard.type("$");
  assert.equal(await page.locator(ghostSelector).count(), 0, "Closing the math delimiter clears the preview immediately");
  await page.keyboard.type(" Ordinary text x_1,x_2");
  await noGhost(page);
  const before = await documentText(page);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before);
  assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
});

test("entering a text command clears previews and prevents mathematical predictions", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "$x+a+\\text{hello}+b$\n$x+a|$");
  await ghostText(page);
  await page.keyboard.type("+\\text{");
  assert.equal(await page.locator(ghostSelector).count(), 0, "Text-command content must never retain a math preview");
  await page.keyboard.type("hel");
  await noGhost(page);
  const before = await documentText(page);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), before);
  assert.equal(await page.evaluate(() => window.fixture.tabFallbackCount), 1);
});

test("comments and verbatim content never show math predictions", async (t) => {
  const page = await fixture(t);
  for (const marked of [
    "$x_1,x_2,\\ldots,x_n$\n% $x_1,x_2|",
    "$x_1,x_2,\\ldots,x_n$\n\\verb!$x_1,x_2|!",
    "$x_1,x_2,\\ldots,x_n$\n\\begin{verbatim}\n$x_1,x_2|\n\\end{verbatim}",
  ]) {
    await setDocument(page, marked);
    await noGhost(page);
  }
});

test("an invalid installed model falls back to document completions", async (t) => {
  const page = await fixture(t, {
    modelArtifact: { schemaVersion: 999, tokenizerVersion: "unknown", trained: true, ngrams: "invalid", ranker: { weights: ["invalid"] } },
  });
  await setDocument(page, "$a^2+b^2=c^2$\n$a^2|$");
  assert.equal(await ghostText(page), "+b^2=c^2");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$a^2+b^2=c^2$\n$a^2+b^2=c^2$");
});




test("classified subscript preview accepts with Tab and preserves the paired brace", async (t) => {
  const page = await fixture(t);
  const before = await setDocument(page, "$x_{j,k}$\n$x_{|}$");
  assert.equal(await ghostText(page), "j,k");
  assert.equal(await documentText(page), before);
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$x_{j,k}$\n$x_{j,k}$");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await documentText(page), before);
});

test("a trained low-confidence ranker retains reliable grey expression previews", async (t) => {
  const model = { ...Predictor.createUntrainedArtifact(), trained: true,
    ranker: { features: [...Predictor.FEATURE_NAMES], weights: Predictor.FEATURE_NAMES.map(() => 0),
      means: Predictor.FEATURE_NAMES.map(() => 0), scales: Predictor.FEATURE_NAMES.map(() => 1), bias: -30 },
    training: { recommendedThreshold: 0.99 } };
  const page = await fixture(t, { modelArtifact: model });
  await setDocument(page, "$f(x)=x^2+1$\n$f(x)|$");
  assert.equal(await ghostText(page), "=x^2+1");
  await page.keyboard.press("Tab");
  assert.equal(await documentText(page), "$f(x)=x^2+1$\n$f(x)=x^2+1$");
});

test("local set declarations guide ambiguous relation reuse in the browser", async (t) => {
  const page = await fixture(t);
  await setDocument(page, "\\begin{enumerate}\\item Let $A$ be a set. $A \\subseteq B$ and $A \\sin x$. $A \\s|$\\end{enumerate}");
  assert.equal(await ghostText(page), "ubseteq B");
  await page.keyboard.press("Tab");
  assert.match(await documentText(page), /\$A \\subseteq B\$\s*\\end/);
});
