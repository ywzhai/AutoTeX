/* Replaced by the training export when a validated corpus/model is available. */
(function (root, factory) {
  const model = factory();
  if (typeof module === "object" && module.exports) module.exports = model;
  root.AutoTexModel = model;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // Document-local prediction works without a pretrained corpus. Do not label
  // handcrafted defaults as trained weights or imply a downloaded model exists.
  return Object.freeze({
    schemaVersion: 2,
    tokenizerVersion: "autotex-tex-v1",
    classifierVersion: "autotex-context-v1",
    trained: false,
    ngrams: { order: 5, smoothing: 3, contexts: [] },
    ranker: null,
  });
});
