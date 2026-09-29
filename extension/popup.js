(() => {
  "use strict";

  const STORAGE_KEY = "mathAutocompleteSettings";
  const DEFAULTS = {
    enabled: true,
    expressions: true,
    sequences: true,
    minPrefix: 3,
    maxSuggestionLength: 400,
    sequenceEnd: "n",
    debounceMs: 160,
  };
  const checkboxes = ["enabled", "expressions", "sequences"];
  const controls = Object.fromEntries(checkboxes.map((name) => [name, document.getElementById(name)]));
  const endInput = document.getElementById("sequence-end");
  const endError = document.getElementById("sequence-error");
  const saveStatus = document.getElementById("save-status");
  const connectionStatus = document.getElementById("connection-status");
  const connectionLabel = document.getElementById("connection-label");
  let settings = { ...DEFAULTS };
  let connection = "waiting";
  let ready = false;
  let pendingSave = Promise.resolve();
  let saveRevision = 0;

  function validEnd(value) {
    return /^[A-Za-z]$/.test(value) || (/^\d{1,3}$/.test(value) && Number(value) >= 3 && Number(value) <= 999);
  }

  function setSaveStatus(message, state = "") {
    saveStatus.textContent = message;
    saveStatus.dataset.state = state;
  }

  function renderConnection() {
    const current = settings.enabled ? connection : "disabled";
    const labels = {
      connected: "Connected to your editor",
      waiting: "Waiting for the code editor",
      unsupported: "Switch to Overleaf’s code editor",
      disabled: "Suggestions are paused",
      unavailable: "Open or reload an Overleaf project",
    };
    connectionStatus.dataset.state = current;
    connectionLabel.textContent = labels[current] || labels.waiting;
  }

  function updateControls() {
    for (const name of checkboxes) {
      controls[name].checked = settings[name];
      controls[name].disabled = !ready;
    }
    endInput.disabled = !ready || !settings.sequences;
    renderConnection();
  }

  function save() {
    const revision = ++saveRevision;
    const nextSettings = { ...settings };
    setSaveStatus("Saving…");
    // Serialize writes so rapid changes cannot leave an older preference in storage.
    pendingSave = pendingSave.catch(() => {}).then(async () => {
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: nextSettings });
        if (revision === saveRevision) setSaveStatus("Changes saved", "saved");
        setTimeout(inspectTab, 200);
      } catch {
        if (revision === saveRevision) setSaveStatus("Couldn’t save. Please try again.", "error");
      }
    });
  }

  function saveEnd() {
    const value = endInput.value.trim();
    const valid = validEnd(value);
    endInput.setAttribute("aria-invalid", String(!valid));
    endError.hidden = valid;
    if (!valid) return;
    const normalized = /^\d+$/.test(value) ? String(Number(value)) : value;
    if (settings.sequenceEnd === normalized) return;
    settings.sequenceEnd = normalized;
    save();
  }

  for (const name of checkboxes) {
    controls[name].addEventListener("change", () => {
      settings[name] = controls[name].checked;
      updateControls();
      save();
    });
  }

  endInput.addEventListener("input", () => {
    const valid = validEnd(endInput.value.trim());
    endInput.setAttribute("aria-invalid", String(!valid));
    endError.hidden = valid;
    // Save valid input immediately: closing a popup must not discard a preference.
    if (valid) saveEnd();
  });
  endInput.addEventListener("change", saveEnd);
  endInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      saveEnd();
      if (!endError.hidden) return;
      endInput.blur();
    }
  });

  async function inspectTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab");
      const result = await chrome.tabs.sendMessage(tab.id, { type: "math-autocomplete-status" });
      connection = ["connected", "waiting", "unsupported", "disabled"].includes(result?.status) ? result.status : "waiting";
    } catch {
      connection = "unavailable";
    }
    renderConnection();
  }

  async function initialize() {
    try {
      const values = await chrome.storage.local.get(STORAGE_KEY);
      const saved = values?.[STORAGE_KEY];
      if (saved && typeof saved === "object") {
        for (const name of checkboxes) {
          if (typeof saved[name] === "boolean") settings[name] = saved[name];
        }
        for (const [name, minimum, maximum] of [["minPrefix", 1, 20], ["maxSuggestionLength", 20, 2000], ["debounceMs", 0, 2000]]) {
          if (Number.isInteger(saved[name]) && saved[name] >= minimum && saved[name] <= maximum) settings[name] = saved[name];
        }
        if (typeof saved.sequenceEnd === "string" && validEnd(saved.sequenceEnd.trim())) {
          const value = saved.sequenceEnd.trim();
          settings.sequenceEnd = /^\d+$/.test(value) ? String(Number(value)) : value;
        }
      }
      ready = true;
      endInput.value = settings.sequenceEnd;
      updateControls();
    } catch {
      setSaveStatus("Couldn’t load settings. Reopen this popup to retry.", "error");
    }
    await inspectTab();
  }

  initialize();
  // The popup can stay open while the editor is loading or its mode changes.
  setInterval(inspectTab, 1500);
})();
