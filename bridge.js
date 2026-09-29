/* Only preferences and connection state cross worlds. Document text stays in the editor. */
(() => {
  "use strict";

  const CHANNEL = "overleaf-math-autocomplete";
  const STORAGE_KEY = "mathAutocompleteSettings";
  const DEFAULTS = Object.freeze({
    enabled: true,
    expressions: true,
    sequences: true,
    minPrefix: 3,
    maxSuggestionLength: 400,
    sequenceEnd: "n",
    debounceMs: 160,
  });
  const STATUSES = new Set(["connected", "waiting", "unsupported", "disabled"]);
  let settings = { ...DEFAULTS };
  let status = "waiting";

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const result = { ...DEFAULTS };
    for (const name of ["enabled", "expressions", "sequences"]) {
      if (typeof source[name] === "boolean") result[name] = source[name];
    }
    const end = typeof source.sequenceEnd === "string" ? source.sequenceEnd.trim() : "";
    if (/^[A-Za-z]$/.test(end) || (/^\d{1,3}$/.test(end) && Number(end) >= 3 && Number(end) <= 999)) {
      result.sequenceEnd = /^\d+$/.test(end) ? String(Number(end)) : end;
    }
    for (const [name, minimum, maximum] of [
      ["minPrefix", 1, 20],
      ["maxSuggestionLength", 20, 2000],
      ["debounceMs", 0, 2000],
    ]) {
      if (Number.isInteger(source[name]) && source[name] >= minimum && source[name] <= maximum) {
        result[name] = source[name];
      }
    }
    return result;
  }

  function sendSettings() {
    window.postMessage({ channel: CHANNEL, type: "settings", settings: { ...settings } }, location.origin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.channel !== CHANNEL) return;
    if (data.type === "ready") sendSettings();
    if (data.type === "status" && STATUSES.has(data.status)) status = data.status;
  });

  chrome.storage.local.get(STORAGE_KEY, (values) => {
    // On storage failure, keep the safe local defaults rather than stopping the editor.
    if (!chrome.runtime.lastError) settings = normalizeSettings(values?.[STORAGE_KEY]);
    sendSettings();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) return;
    settings = normalizeSettings(changes[STORAGE_KEY].newValue);
    sendSettings();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "math-autocomplete-status") return false;
    sendResponse({ status: settings.enabled ? status : "disabled" });
    return false;
  });
})();
