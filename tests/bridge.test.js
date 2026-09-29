"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../extension/bridge.js"), "utf8");
const CHANNEL = "overleaf-math-autocomplete";
const STORAGE_KEY = "mathAutocompleteSettings";
const ORIGIN = "https://www.overleaf.com";
const EXTENSION_ID = "test-math-extension";
const DEFAULTS = {
  enabled: true,
  expressions: true,
  sequences: true,
  minPrefix: 3,
  maxSuggestionLength: 400,
  sequenceEnd: "n",
  debounceMs: 50,
};

// Exercise the actual content script with controlled Chrome/browser boundaries.
// Cloning posted messages also models the real postMessage structured clone.
function harness() {
  const posted = [];
  const reads = [];
  const pageListeners = [];
  const storageListeners = [];
  const runtimeListeners = [];
  let storageCallback;
  const window = {
    addEventListener(type, listener) {
      assert.equal(type, "message");
      pageListeners.push(listener);
    },
    postMessage(message, origin) {
      posted.push({ message: JSON.parse(JSON.stringify(message)), origin });
    },
  };
  const chrome = {
    storage: {
      local: {
        get(key, callback) {
          reads.push(key);
          storageCallback = callback;
        },
      },
      onChanged: {
        addListener(listener) { storageListeners.push(listener); },
      },
    },
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      onMessage: {
        addListener(listener) { runtimeListeners.push(listener); },
      },
    },
  };
  vm.runInNewContext(script, { window, chrome, location: { origin: ORIGIN } }, { filename: "extension/bridge.js" });

  return {
    posted,
    reads,
    loadStorage(settings, error) {
      assert.ok(storageCallback, "The bridge must request saved settings");
      chrome.runtime.lastError = error;
      storageCallback({ [STORAGE_KEY]: settings });
      chrome.runtime.lastError = undefined;
    },
    pageMessage(data, options = {}) {
      const event = { data, origin: ORIGIN, source: window, ...options };
      for (const listener of pageListeners) listener(event);
    },
    changeStorage(changes, areaName = "local") {
      for (const listener of storageListeners) listener(changes, areaName);
    },
    query(message = { type: "math-autocomplete-status" }, sender = { id: EXTENSION_ID }) {
      const replies = [];
      const returns = runtimeListeners.map((listener) => listener(message, sender, (reply) => {
        replies.push(JSON.parse(JSON.stringify(reply)));
      }));
      return { replies, returns };
    },
    latestSettings() {
      return posted.at(-1)?.message.settings;
    },
  };
}

function assertSettingsMessage(entry, expected) {
  assert.deepEqual(entry, {
    message: { channel: CHANNEL, type: "settings", settings: expected },
    origin: ORIGIN,
  });
}

test('existing installations migrate the former implicit delay while retaining other preferences', () => {
  const bridge = harness();
  bridge.loadStorage({ debounceMs: 160, expressions: false, sequenceEnd: 'M' });
  assert.equal(bridge.latestSettings().debounceMs, 50);
  assert.equal(bridge.latestSettings().expressions, false);
  assert.equal(bridge.latestSettings().sequenceEnd, 'M');
});

test("bridge loads only its saved settings key and forwards a sanitized settings message", () => {
  const bridge = harness();
  assert.deepEqual(bridge.reads, [STORAGE_KEY]);
  assert.equal(bridge.posted.length, 0);
  bridge.loadStorage({
    enabled: false,
    expressions: false,
    sequences: true,
    minPrefix: 8,
    maxSuggestionLength: 900,
    sequenceEnd: " 010 ",
    debounceMs: 250,
    documentText: "PRIVATE DOCUMENT CONTENT",
    insertText: "UNAUTHORIZED INSERTION",
    apiKey: "PRIVATE TOKEN",
    arbitrary: { nested: true },
  });
  assert.equal(bridge.posted.length, 1);
  assertSettingsMessage(bridge.posted[0], {
    enabled: false,
    expressions: false,
    sequences: true,
    minPrefix: 8,
    maxSuggestionLength: 900,
    sequenceEnd: "10",
    debounceMs: 250,
  });
  assert.equal(JSON.stringify(bridge.posted).includes("PRIVATE"), false);
});

test("bridge rejects malformed saved preferences and uses safe defaults", () => {
  const bridge = harness();
  bridge.loadStorage({
    enabled: "false",
    expressions: 0,
    sequences: null,
    minPrefix: 0,
    maxSuggestionLength: 2001,
    sequenceEnd: "\\input{secret}",
    debounceMs: 1.5,
  });
  assertSettingsMessage(bridge.posted[0], DEFAULTS);
});

test("bridge enforces numeric settings ranges and integer types", () => {
  for (const [key, accepted, rejected] of [
    ["minPrefix", [1, 20], [-1, 0, 21, 2.5, "3", null]],
    ["maxSuggestionLength", [20, 2000], [0, 19, 2001, 20.5, "400", null]],
    ["debounceMs", [0, 2000], [-1, 2001, 0.5, "160", null]],
  ]) {
    for (const value of accepted) {
      const bridge = harness();
      bridge.loadStorage({ [key]: value });
      assert.equal(bridge.latestSettings()[key], value, key + " accepts " + value);
    }
    for (const value of rejected) {
      const bridge = harness();
      bridge.loadStorage({ [key]: value });
      assert.equal(bridge.latestSettings()[key], DEFAULTS[key], key + " rejects " + value);
    }
  }
});

test("bridge accepts symbolic or explicit finite endpoints and rejects invalid ones", () => {
  for (const [input, expected] of [
    ["N", "N"], ["  m  ", "m"], ["003", "3"], ["999", "999"],
    ["0", "n"], ["2", "n"], ["1000", "n"], ["3.5", "n"],
    ["nm", "n"], ["", "n"], [10, "n"], [null, "n"],
  ]) {
    const bridge = harness();
    bridge.loadStorage({ sequenceEnd: input });
    assert.equal(bridge.latestSettings().sequenceEnd, expected, String(input));
  }
});

test("missing settings and storage errors leave the editor usable with defaults", () => {
  for (const value of [undefined, null, false, "not an object", []]) {
    const bridge = harness();
    bridge.loadStorage(value);
    assertSettingsMessage(bridge.posted[0], DEFAULTS);
  }
  const bridge = harness();
  bridge.loadStorage({ enabled: false, sequenceEnd: "M" }, { message: "Storage unavailable" });
  assertSettingsMessage(bridge.posted[0], DEFAULTS);
});

test("ready handshake returns current settings both before and after storage finishes", () => {
  const bridge = harness();
  bridge.pageMessage({ channel: CHANNEL, type: "ready", documentText: "PRIVATE DOCUMENT" });
  assertSettingsMessage(bridge.posted[0], DEFAULTS);
  bridge.loadStorage({ minPrefix: 6, sequenceEnd: "M" });
  const saved = { ...DEFAULTS, minPrefix: 6, sequenceEnd: "M" };
  assertSettingsMessage(bridge.posted[1], saved);
  bridge.pageMessage({ channel: CHANNEL, type: "ready", insertText: "SHOULD NOT CROSS" });
  assertSettingsMessage(bridge.posted[2], saved);
  assert.equal(JSON.stringify(bridge.posted).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(bridge.posted).includes("SHOULD NOT CROSS"), false);
});

test("page messages require the exact origin source window and channel", () => {
  const bridge = harness();
  const ready = { channel: CHANNEL, type: "ready" };
  const status = { channel: CHANNEL, type: "status", status: "connected" };
  for (const options of [
    { origin: "https://attacker.example" },
    { origin: "https://overleaf.com" },
    { origin: "null" },
    { source: {} },
    { source: null },
  ]) {
    bridge.pageMessage(ready, options);
    bridge.pageMessage(status, options);
  }
  for (const data of [
    null, undefined, "ready", [],
    { type: "ready" },
    { channel: "another-extension", type: "ready" },
    { channel: "another-extension", type: "status", status: "connected" },
  ]) {
    bridge.pageMessage(data);
  }
  assert.equal(bridge.posted.length, 0);
  assert.deepEqual(bridge.query().replies, [{ status: "waiting" }]);
});

test("page settings or insertion requests cannot override saved settings or send document text", () => {
  const bridge = harness();
  bridge.loadStorage({ sequenceEnd: "M" });
  const count = bridge.posted.length;
  bridge.pageMessage({
    channel: CHANNEL, type: "settings",
    settings: { enabled: false, sequenceEnd: "Z", documentText: "PRIVATE DOCUMENT" },
  });
  bridge.pageMessage({ channel: CHANNEL, type: "insert", insertText: "UNREQUESTED TEXT" });
  bridge.pageMessage({ channel: CHANNEL, type: "document", text: "PRIVATE DOCUMENT" });
  assert.equal(bridge.posted.length, count);
  bridge.pageMessage({ channel: CHANNEL, type: "ready" });
  assertSettingsMessage(bridge.posted.at(-1), { ...DEFAULTS, sequenceEnd: "M" });
});

test("live local storage updates propagate sanitized settings and deletion restores defaults", () => {
  const bridge = harness();
  bridge.loadStorage({ minPrefix: 7, sequenceEnd: "N" });
  bridge.changeStorage({
    [STORAGE_KEY]: {
      oldValue: { minPrefix: 7, sequenceEnd: "N" },
      newValue: { enabled: false, sequences: false, documentText: "PRIVATE DOCUMENT", minPrefix: 0 },
    },
  });
  assertSettingsMessage(bridge.posted.at(-1), { ...DEFAULTS, enabled: false, sequences: false });
  assert.deepEqual(bridge.query().replies, [{ status: "disabled" }]);
  bridge.changeStorage({ [STORAGE_KEY]: { oldValue: { enabled: false } } });
  assertSettingsMessage(bridge.posted.at(-1), DEFAULTS);
  assert.equal(JSON.stringify(bridge.posted).includes("PRIVATE"), false);
});

test("unrelated storage keys and nonlocal storage areas cannot change settings", () => {
  const bridge = harness();
  bridge.loadStorage({ sequenceEnd: "M" });
  const change = { [STORAGE_KEY]: { newValue: { enabled: false, sequenceEnd: "N" } } };
  bridge.changeStorage(change, "sync");
  bridge.changeStorage(change, "session");
  bridge.changeStorage({ unrelatedKey: { newValue: "PRIVATE DOCUMENT" } });
  assert.equal(bridge.posted.length, 1);
  assert.deepEqual(bridge.latestSettings(), { ...DEFAULTS, sequenceEnd: "M" });
  assert.deepEqual(bridge.query().replies, [{ status: "waiting" }]);
});

test("status queries are answered only for the extension's own sender and request type", () => {
  const bridge = harness();
  bridge.pageMessage({ channel: CHANNEL, type: "status", status: "connected" });
  for (const sender of [{ id: "another-extension" }, { id: "" }, {}]) {
    assert.deepEqual(bridge.query(undefined, sender), { replies: [], returns: [false] });
  }
  for (const request of [null, undefined, {}, { type: "other-status" }, { type: "document" }]) {
    // An explicitly undefined query would select the harness's default argument.
    if (request === undefined) continue;
    assert.deepEqual(bridge.query(request), { replies: [], returns: [false] });
  }
  assert.deepEqual(bridge.query(), { replies: [{ status: "connected" }], returns: [false] });
});

test("only known statuses are accepted and disabled preferences override connection state", () => {
  const bridge = harness();
  bridge.loadStorage({});
  for (const status of ["waiting", "connected", "unsupported", "disabled"]) {
    bridge.pageMessage({ channel: CHANNEL, type: "status", status });
    assert.deepEqual(bridge.query().replies, [{ status }]);
  }
  bridge.pageMessage({ channel: CHANNEL, type: "status", status: "connected" });
  for (const status of [null, "", "PRIVATE DOCUMENT", { status: "disabled" }]) {
    bridge.pageMessage({ channel: CHANNEL, type: "status", status });
  }
  assert.deepEqual(bridge.query().replies, [{ status: "connected" }]);
  bridge.changeStorage({ [STORAGE_KEY]: { newValue: { enabled: false } } });
  assert.deepEqual(bridge.query().replies, [{ status: "disabled" }]);
  bridge.changeStorage({ [STORAGE_KEY]: { newValue: { enabled: true } } });
  assert.deepEqual(bridge.query().replies, [{ status: "connected" }]);
});

