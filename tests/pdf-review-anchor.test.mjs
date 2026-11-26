import { reviewCandidates } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { DocumentModel, diffSource, highlightSource, mappingSource, providerSource, reviewFile } from './support/pdf-harness.mjs';

test('a clicked PDF range remains the popup anchor when source remapping loses the inline-tag edge', () => {
  const providers = new Map(), pdf = {};
  const window = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
  const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf });
  const source = '<p>Die „<i>Réforme</i>“ erklärte.</p>';
  const documentModel = new DocumentModel({ model: { getValue: () => source, getVersionId: () => 1,
    getOffsetAt: position => position.column - 1, getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } });
  const model = documentModel.model, index = locator.editorSourceIndex(documentModel);
  const editor = { document: documentModel, getModel: () => model, getSelection: () => null,
    getDomNode: () => ({ ownerDocument: { defaultView: window } }) };
  window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
  window.PdfSelection = { locator, savePreference() {}, editor };
  window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; } };
  vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });

  const item = { sourceStart: 6, sourceEnd: 7, comparison: { html: 'é', pdf: 'e' },
    pdfSource: index.entry(6, 7, true) }, measured = { left: 41, top: 52, bottom: 61 };
  const request = { side: 'pdf', notice: { source: { index, start: 6, end: 7 } }, anchor: measured };
  locator.reviewAnchors = entries => {
    assert.equal(entries.length, 0);
    return new Map();
  };
  assert.equal(providers.get('pdf-ocr').presentation({ editor, request }, item).anchor, measured);
});

test('popup candidates share one selection lookup and the missing text caret', async () => {
  const providers = new Map(), pdf = {};
  const document = { querySelector: () => null, createRange: () => ({
    setStart(node, offset) { this.offset = offset; },
    setEnd() {},
    toString: () => 'text',
    getBoundingClientRect() { return { left: this.offset * 10, top: 20, height: 12 }; },
    getClientRects() { return [{ ...this.getBoundingClientRect(), width: 40 }]; }
  }) };
  const window = { ReaderUI: { getPdfViewer: () => ({ pdfDocument: pdf }) },
    ReplacementReview: { register(provider) { providers.set(provider.id, provider); } },
    addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext('{\n' + diffSource + '\n}\n' + highlightSource + '\n' + reviewFile,
    { window, document, setInterval: () => 0, clearInterval() {} });
  const { locator, highlights } = await window.PdfReviewReady;
  const { PdfConnections } = window.PdfSelectionDiff;
  const layer = { isConnected: true, closest: () => null, clientLeft: 0, clientTop: 0,
    clientWidth: 600, clientHeight: 200, offsetWidth: 600, offsetHeight: 200,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 200 }) };
  const source = new PdfConnections(locator, 'Alpha missing Beta');
  const target = new PdfConnections(locator, { raw: 'Alpha Beta', layer, parts: [
    { start: 0, end: 5, node: { length: 5 } },
    { start: 6, end: 10, node: { length: 4 } }
  ] });
  locator.environment.getVisiblePages = () => [{ number: 1, index: target }];
  source.remember(14, 18, target, { start: 6, end: 10 });
  const shared = { items: [{ sourceStart: 14, sourceEnd: 18 }, { sourceStart: 6, sourceEnd: 13, missing: true }] };
  source.getDifferences = () => shared;
  source.missingRange = () => ({ start: 5, end: 5, endBias: true });
  const { items: [item, missing] } = locator.cacheReview({ index: source, shared }, { selected: true, edits: false });
  assert.equal(shared.items[0].pdfSource, undefined);

  const findLocations = locator.findLocations.bind(locator);
  const [location] = findLocations(pdf, [missing.pdfSource], true);
  const { hits, focusHit } = target.locateLayer([], location.targets);
  assert.equal(focusHit.endBias, true);
  const { notices: [{ box }] } = highlights.measureHighlights(layer, target, hits, focusHit);
  let lookups = 0;
  locator.findLocations = (...args) => {
    lookups++;
    assert.deepEqual(Array.from(args[1]), [item.pdfSource, missing.pdfSource]);
    return findLocations(...args);
  };
  const editor = { getDomNode: () => ({ ownerDocument: { defaultView: window } }) };
  const presentation = providers.get('pdf-ocr').presentation({ editor }, item);
  assert.equal(lookups, 1);
  assert.equal(presentation.anchor, presentation.highlights[0]);
  assert.equal(presentation.highlights[1].left, box.x * layer.clientWidth + 2);
});

test('source decorations retain whether their candidate is text or font', () => {
  const window = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
  const api = window.PdfReviewProvider;
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new window.PdfSelectionDiff.PdfConnections(locator, '<p><i>Réforme</i></p>');
  const text = { sourceStart: 1, sourceEnd: 2, comparison: { html: 'é', pdf: 'e' } };
  const font = { sourceStart: 1, sourceEnd: 8, text: 'Réforme', font: { italic: false, bold: false } };
  const model = { getOffsetAt: position => position.column - 1, getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = api.sourceDecorations(index, [text, font], true, true, undefined, { model,
    rangeAt: (start, end) => ({ startLineNumber: 1, startColumn: start + 1, endLineNumber: 1, endColumn: end + 1 }) });

  assert.equal(marks.find(mark => mark.options.inlineClassName === 'mew-ocr-diff-text').reviewItem, text);
  assert.equal(marks.find(mark => mark.options.inlineClassName === 'mew-font-diff-text').reviewItem, font);
  const difference = index.candidateEntry(font).difference;
  assert.equal(difference.html, 'Réforme');
  assert.equal(difference.pdf, 'Réforme');
  assert.equal(difference.fonts[0], font.font);
});

test('a text difference precedes the overlapping font difference', () => {
  const window = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
  const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, '<p><i>Réforme</i></p>'), raw = 'Reforme';
  const target = new api.PdfConnections(locator, { raw, parts: [{ start: 0, end: raw.length, font: { italic: false, bold: false } }] });
  const connection = source.remember(0, source.raw.length, target, { start: 0, end: target.raw.length });
  const items = reviewCandidates(source, { fonts: true, edits: false, text: true, targets: [target], connections: [connection] });
  assert.equal(items[0].font, undefined);
  assert.equal(items[1].font.italic, false);
  assert.equal(items[0].reviewStart ?? items[0].sourceStart, items[1].reviewStart);
});
