import vm from 'node:vm';
import { DocumentModel, diffSource, mappingSource, providerSource } from './pdf-harness.mjs';

export function selectionFixture(cases, { markup = text => text } = {}) {
  const listeners = new Map(), providers = new Map(), pdf = {};
  const window = { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener() {} };
  vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
  const { PdfLocator } = window.PdfReviewProvider, { PdfConnections } = window.PdfSelectionDiff;
  let source = cases.map(({ text }) => `<p>${markup(text)}</p>`).join(''), version = 1, target, highlighted, undoStops = 0;
  const locator = new PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf, getTargets: () => [target] });
  const model = { getValue: () => source, getVersionId: () => version,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const documentModel = new DocumentModel({ model }), index = locator.editorSourceIndex(documentModel);
  const starts = [];
  let offset = 0, pdfText = index.raw;
  for (const { text } of cases) { const start = index.raw.indexOf(text, offset); starts.push(start); offset = start + text.length; }
  for (let at = cases.length - 1; at >= 0; at--)
    pdfText = pdfText.slice(0, starts[at]) + cases[at].pdf + pdfText.slice(starts[at] + cases[at].text.length);
  target = new PdfConnections(locator, { raw: pdfText, parts: [] });
  index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  locator.indexDocument = locator.indexFonts = async () => target;
  let selectedRange = '';
  const classes = new Set(), editor = { document: documentModel, getModel: () => model, getOption: () => false,
    getSelection: () => ({ toString: () => selectedRange }),
    getDomNode: () => ({ ownerDocument: { defaultView: window }, classList: {
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), remove: name => classes.delete(name) } }),
    pushUndoStop() { undoStops++; }, executeEdits(origin, edits) {
      for (const edit of [...edits].reverse()) source = source.slice(0, edit.range.startColumn - 1) + edit.text + source.slice(edit.range.endColumn - 1);
      version++; documentModel.update(documentModel.content); return true;
    } };
  window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
  window.PdfSelection = { locator, editor, interactionId: 0, selectionEnabled: true, savePreference() {}, refresh() {},
    showReviewPointer(owner, items) { highlighted = items; }, clearReviewPointer() { highlighted = null; } };
  window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; }, isOpenFor: () => false };
  vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
  const provider = providers.get('pdf-ocr'), context = { editor, model, documentModel, source, version, snapshot: documentModel.snapshot };
  const base = locator.reviewItems();
  function select(query, replacement, paragraph = 0, from = 0) {
    const start = starts[paragraph] + cases[paragraph].text.indexOf(query, from), end = start + query.length;
    selectedRange = `${start}:${end}`;
    const notice = { html: query, pdf: replacement, source: { index, start, end } };
    const data = locator.reviewItems({ ...context, request: { notice } });
    return { data, item: data.selection, state: { context, items: data.items, item: data.selection, position: data.selection?.queueRange?.[0] ?? 0 } };
  }
  return { window, locator, index, target, provider, providers, context, editor, model, documentModel, cases, starts, base, select, listeners,
    get source() { return source; }, get highlighted() { return highlighted; }, get undoStops() { return undoStops; } };
}
