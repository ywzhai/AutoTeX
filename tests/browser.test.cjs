"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { build } = require("esbuild");
const { chromium } = require("playwright");

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
  if (Object.hasOwn(options, "modelArtifact")) {
    await page.route("**/extension/model.js", (route) => route.fulfill({
      contentType: "text/javascript",
      body: "globalThis.AutoTexModel = " + JSON.stringify(options.modelArtifact) + ";",
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

test("popup renders connection state and persists validated preferences", async (t) => {
  const context = await browser.newContext({ viewport: { width: 370, height: 640 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], "The popup should have no uncaught browser errors");
  });
  await page.addInitScript(() => {
    const key = "fixtureChromeStorage";
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
  });
  await page.goto(`${baseURL}/extension/popup.html`);
  await page.waitForFunction(() => !document.getElementById("enabled").disabled);
  await page.waitForFunction(() => document.getElementById("connection-label").textContent === "Connected to your editor");
  assert.equal(await page.locator("#sequence-end").inputValue(), "n");
  await page.screenshot({ path: path.join(root, "test-results/popup.png"), fullPage: true });

  await page.locator("#expressions").uncheck();
  await page.waitForFunction(() => window.popupPreferences()?.expressions === false);
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
  assert.equal(await page.locator("#connection-label").textContent(), "Suggestions are paused");
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("enabled").disabled);
  assert.equal(await page.locator("#enabled").isChecked(), false);
  assert.equal(await page.locator("#expressions").isChecked(), false);
  assert.equal(await page.locator("#sequences").isChecked(), true);
  assert.equal(await page.locator("#sequence-end").inputValue(), "m");
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


