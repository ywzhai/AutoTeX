import * as state from "@codemirror/state";
import * as editorView from "@codemirror/view";
import * as commands from "@codemirror/commands";
import * as autocomplete from "@codemirror/autocomplete";

// Pass the very same module instances used by the host editor, as Overleaf does.
const CodeMirror = { ...state, ...editorView, ...commands, ...autocomplete };
const { EditorState, EditorSelection, Compartment } = state;
const { EditorView, keymap, drawSelection } = editorView;
const extensionCompartment = new Compartment();
const editableCompartment = new Compartment();
const CHANNEL = "overleaf-math-autocomplete";
const settings = {
  enabled: true,
  expressions: true,
  sequences: true,
  minPrefix: 3,
  maxSuggestionLength: 400,
  sequenceEnd: "n",
  debounceMs: 30,
};
let tabFallbackCount = 0;
let extensionEvents = 0;

function collectExtensions() {
  const extensions = [];
  window.dispatchEvent(new CustomEvent("UNSTABLE_editor:extensions", { detail: { CodeMirror, extensions } }));
  extensionEvents++;
  return extensions;
}

function editability(readOnly) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

function createState(text, cursor = text.length, readOnly = false) {
  return EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      commands.history(),
      drawSelection(),
      keymap.of([
        ...commands.defaultKeymap,
        ...commands.historyKeymap,
        // An independent editor shortcut proves that the extension lets Tab through.
        { key: "Tab", run() { tabFallbackCount++; return true; } },
      ]),
      EditorView.contentAttributes.of({ "aria-label": "Source Editor editing" }),
      editableCompartment.of(editability(readOnly)),
      extensionCompartment.of(collectExtensions()),
    ],
  });
}

const view = new EditorView({ state: createState(""), parent: document.getElementById("editor") });

function sendSettings() {
  window.postMessage({ channel: CHANNEL, type: "settings", settings: { ...settings } }, location.origin);
}

window.addEventListener("editor:extension-loaded", () => {
  view.dispatch({ effects: extensionCompartment.reconfigure(collectExtensions()) });
  sendSettings();
});

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.channel === CHANNEL && event.data.type === "ready") sendSettings();
});

window.fixture = {
  view,
  CodeMirror,
  settings,
  get tabFallbackCount() { return tabFallbackCount; },
  get extensionEvents() { return extensionEvents; },
  setDocument(text, cursor = text.length, options = {}) {
    view.setState(createState(text, cursor, Boolean(options.readOnly)));
    view.focus();
  },
  setReadOnly(value) {
    view.dispatch({ effects: editableCompartment.reconfigure(editability(Boolean(value))) });
  },
  setSelection(anchor, head = anchor) {
    view.dispatch({ selection: EditorSelection.range(anchor, head) });
  },
  configure(values) {
    Object.assign(settings, values);
    // postMessage is asynchronous. Tests must wait for the editor's reply before
    // simulating the next keystroke, just as the popup waits for saved settings.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", applied);
        reject(new Error("Editor did not acknowledge the preference update"));
      }, 3000);
      function applied(event) {
        if (event.source !== window || event.origin !== location.origin ||
            event.data?.channel !== CHANNEL || event.data.type !== "status") return;
        clearTimeout(timer);
        window.removeEventListener("message", applied);
        resolve();
      }
      window.addEventListener("message", applied);
      sendSettings();
    });
  },
};
