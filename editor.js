/* Uses Overleaf's own CodeMirror exports; no second editor runtime is injected. */
(() => {
  "use strict";
  const CHANNEL = "overleaf-math-autocomplete";
  const instances = new Set();
  const extensionCache = new WeakMap();
  let settings = { ...MathAutocompleteEngine.DEFAULT_SETTINGS };
  let receivedSettings = false;
  let hookSeen = false;
  let lastStatus = "";

  function post(type, extra = {}) {
    window.postMessage({ channel: CHANNEL, type, ...extra }, location.origin);
  }

  function status() {
    const next = !settings.enabled ? "disabled" : instances.size ? "connected" :
      hookSeen || document.querySelector(".cm-editor") ? "unsupported" : "waiting";
    if (lastStatus !== next) {
      lastStatus = next;
      post("status", { status: next });
    }
  }

  function sourceIsEditable(view) {
    const selection = view.state.selection;
    const label = view.contentDOM.getAttribute("aria-label") || "";
    return settings.enabled && (settings.expressions || settings.sequences) &&
      !view.state.readOnly && view.contentDOM.isContentEditable &&
      !/visual|rich text/i.test(label) && (!label || /source editor/i.test(label)) &&
      selection.ranges.length === 1 && selection.main.empty && view.hasFocus &&
      !view.composing && !view.compositionStarted && view.dom.isConnected &&
      view.dom.getClientRects().length > 0;
  }

  function createExtension(CM) {
    const { StateEffect, StateField, Decoration, EditorView, ViewPlugin, WidgetType, isolateHistory } = CM;
    const setSuggestion = StateEffect.define();

    class Ghost extends WidgetType {
      constructor(text) { super(); this.text = text; }
      eq(other) { return this.text === other.text; }
      toDOM() {
        const span = document.createElement("span");
        span.className = "ol-math-ghost";
        span.setAttribute("aria-hidden", "true");
        span.setAttribute("data-tooltip", "Tab to accept · Esc to dismiss");
        span.textContent = this.text;
        return span;
      }
      ignoreEvent() { return true; }
    }

    const suggestionField = StateField.define({
      create: () => null,
      update(value, transaction) {
        if (transaction.docChanged || transaction.selection || transaction.reconfigured) value = null;
        for (const effect of transaction.effects) {
          if (effect.is(setSuggestion)) value = effect.value;
        }
        return value && !transaction.state.readOnly && transaction.state.facet(EditorView.editable) &&
          transaction.state.selection.ranges.length === 1 && transaction.state.selection.main.empty &&
          value.doc === transaction.state.doc &&
          value.pos === transaction.state.selection.main.head ? value : null;
      },
      provide: (field) => EditorView.decorations.from(field, (value) => value ?
        Decoration.set([Decoration.widget({ widget: new Ghost(value.insertText), side: 1 }).range(value.pos)]) :
        Decoration.none),
    });

    class Controller {
      constructor(view) {
        this.view = view;
        this.engine = MathAutocompleteEngine.createEngine();
        this.timer = null;
        this.alive = true;
        this.composing = false;
        this.onKey = (event) => this.keydown(event);
        this.onBlur = () => this.dismiss();
        this.onCompositionStart = () => { this.composing = true; this.dismiss(); };
        this.onCompositionEnd = () => { this.composing = false; this.schedule(); };
        // Capture only acceptance/dismissal of our own visible suggestion, before
        // Overleaf's Tab indentation, snippets, and native completion keymaps.
        view.dom.addEventListener("keydown", this.onKey, true);
        view.contentDOM.addEventListener("blur", this.onBlur);
        view.contentDOM.addEventListener("compositionstart", this.onCompositionStart);
        view.contentDOM.addEventListener("compositionend", this.onCompositionEnd);
        instances.add(this);
        queueMicrotask(status);
        queueMicrotask(() => this.schedule());
      }

      current() { return this.view.state.field(suggestionField, false); }

      cancelTimer() {
        clearTimeout(this.timer);
        this.timer = null;
      }

      clear() {
        if (this.alive && this.current()) this.view.dispatch({ effects: setSuggestion.of(null) });
      }

      dismiss() {
        this.cancelTimer();
        // Event handlers run outside CM's update. Update listeners only schedule.
        this.clear();
      }

      schedule() {
        this.cancelTimer();
        if (!this.alive || this.composing || !sourceIsEditable(this.view)) return;
        const document = this.view.state.doc;
        const position = this.view.state.selection.main.head;
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.alive || this.composing || !sourceIsEditable(this.view) ||
              this.view.state.doc !== document || this.view.state.selection.main.head !== position) return;
          const result = this.engine.suggest(document.toString(), position, settings);
          if (!result) return;
          this.view.dispatch({ effects: setSuggestion.of({ ...result, doc: document, pos: position }) });
        }, settings.debounceMs);
      }

      update(update) {
        if (update.docChanged) {
          this.cancelTimer();
          // Undo and completion should not immediately re-offer what was removed
          // or just inserted. The next ordinary edit starts a fresh suggestion.
          const suppressed = update.transactions.some((tr) =>
            tr.isUserEvent("undo") || tr.isUserEvent("redo") || tr.isUserEvent("input.complete.math"));
          if (!suppressed) this.schedule();
        } else if (update.selectionSet || (update.focusChanged && !update.view.hasFocus)) {
          this.cancelTimer();
        }
      }

      keydown(event) {
        if (event.defaultPrevented || event.isComposing || this.composing ||
            event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (event.key === "Escape") {
          const hadSuggestion = Boolean(this.current());
          this.dismiss();
          if (hadSuggestion) { event.preventDefault(); event.stopImmediatePropagation(); }
          return;
        }
        if (event.key !== "Tab") return;
        const value = this.current();
        const view = this.view;
        if (!value || !sourceIsEditable(view) || view.state.doc !== value.doc ||
            view.state.selection.main.head !== value.pos ||
            !view.dom.querySelector(".ol-math-ghost")) return;
        this.cancelTimer();
        event.preventDefault();
        event.stopImmediatePropagation();
        view.dispatch({
          changes: { from: value.pos, insert: value.insertText },
          selection: { anchor: value.pos + value.insertText.length },
          effects: setSuggestion.of(null),
          annotations: isolateHistory ? isolateHistory.of("full") : [],
          userEvent: "input.complete.math",
          scrollIntoView: true,
        });
      }

      settingsChanged() {
        this.dismiss();
        this.engine.reset();
      }

      destroy() {
        this.alive = false;
        this.cancelTimer();
        this.engine.reset();
        this.view.dom.removeEventListener("keydown", this.onKey, true);
        this.view.contentDOM.removeEventListener("blur", this.onBlur);
        this.view.contentDOM.removeEventListener("compositionstart", this.onCompositionStart);
        this.view.contentDOM.removeEventListener("compositionend", this.onCompositionEnd);
        instances.delete(this);
        queueMicrotask(status);
      }
    }

    return [suggestionField, ViewPlugin.fromClass(Controller)];
  }

  window.addEventListener("UNSTABLE_editor:extensions", (event) => {
    hookSeen = true;
    const { CodeMirror: CM, extensions } = event.detail || {};
    if (!CM || !Array.isArray(extensions) ||
        !["StateEffect", "StateField", "Decoration", "EditorView", "ViewPlugin", "WidgetType"].every((key) => CM[key])) {
      status();
      return;
    }
    let extension = extensionCache.get(CM);
    if (!extension) { extension = createExtension(CM); extensionCache.set(CM, extension); }
    extensions.push(extension);
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.channel !== CHANNEL || event.data.type !== "settings") return;
    const input = event.data.settings;
    if (!input || typeof input !== "object") return;
    // Only settings are accepted across worlds. No message can insert text.
    for (const key of ["enabled", "expressions", "sequences"]) {
      if (typeof input[key] === "boolean") settings[key] = input[key];
    }
    if (typeof input.sequenceEnd === "string" && /^(?:[A-Za-z]|[0-9]{1,3})$/.test(input.sequenceEnd)) {
      settings.sequenceEnd = input.sequenceEnd;
    }
    for (const [key, min, max] of [["debounceMs", 0, 2000], ["minPrefix", 1, 20], ["maxSuggestionLength", 20, 2000]]) {
      if (Number.isInteger(input[key]) && input[key] >= min && input[key] <= max) settings[key] = input[key];
    }
    receivedSettings = true;
    for (const instance of instances) instance.settingsChanged();
    lastStatus = "";
    status();
  });

  // Reloads the third-party compartment when the project was already open.
  // Future files initialize it via UNSTABLE_editor:extensions automatically.
  window.dispatchEvent(new Event("editor:extension-loaded"));
  post("ready");
  status();
  const retry = setInterval(() => {
    if (!receivedSettings) post("ready");
    status();
    if (receivedSettings && instances.size) clearInterval(retry);
  }, 1500);
  window.addEventListener("pagehide", () => clearInterval(retry), { once: true });
})();
