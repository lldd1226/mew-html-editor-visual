import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const reviewFile = await readFile(new URL('../../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8');
// Fail at setup when production boundaries move instead of evaluating an empty adapter.
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `PDF test adapter needs updated boundaries: ${start}`);
  return source.slice(a, b);
}
const preparationEntry = section(reviewFile, '  prepareReview(context = {}) {', '  reviewItems(context = {}) {').trim();
const reviewEntry = section(reviewFile, '  reviewItems(context = {}) {', '  pattern(value, index = this.index) {').trim();
const mappingSection = section(reviewFile, '// Source/PDF mapping and candidate generation.',
  '// Shared popup and session initialization.').replace(preparationEntry, '').replace(reviewEntry, '');
const selectionFile = await readFile(new URL('../../public/pdfdiff/pdf-selection.js', import.meta.url), 'utf8');
const selectionMapping = section(selectionFile, '  function findLocations(', '  function nativeBoxes(')
  .replace('visiblePages().map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) }))',
    'environment.getVisiblePages?.() || []')
  .replace('viewer?.pdfDocument', 'environment.getPdf?.()')
  .replaceAll('review.locator', 'locator');
const mappingSource = '(() => {\n' + mappingSection + '\nwindow.PdfReviewProvider = { PdfLocator, textItemBaseline: window.PdfSelectionDiff.pdfTextBaseline, fontStyle: window.PdfSelectionDiff.pdfFontStyle, sourceDecorations, sourceHover, fontSummary, comparisonRows, reviewIds, readPageText, readPageFonts, layerFonts };\n})();';
// Adapt page assembly and delegate selection mapping to the production connection class.
const selectionMappingSource = mappingSource.replace('window.PdfReviewProvider =', `class SelectionLocator extends PdfLocator {
  constructor(options = {}, environment = {}) {
    super(options, environment);
    const locator = this;
    ${selectionMapping}
    Object.assign(this, { findLocations,
      locateSource: (index, chunks) => index.locateSource(chunks, environment.getPdf?.()),
      locateLayer: (index, queries, targets) => index.locateLayer(queries, targets) });
  }
}
window.PdfReviewProvider =`).replace('{ PdfLocator,', '{ PdfLocator: SelectionLocator,');
const popupSource = await readFile(new URL('../../public/pdfdiff/replacement-review.js', import.meta.url), 'utf8');
const fullReviewSource = popupSource + '\n' + reviewFile;
const textEditFixture = `
window.PdfSelectionDiff.applyTextEdits = function(source, edits) {
  return new window.MewEditorCore.DocumentModel({ text: source }).applyEdits(edits).source;
};`;
const inlineModule = source => source.replace(/^export \{[^\n]+\};\r?\n?/mg, '').replace(/^import \{[^\n]+\} from '[^']+';\r?\n/mg, '');
const coreSource = await readFile(new URL('../../public/editor-core.js', import.meta.url), 'utf8');
const fixtureWindow = {};
vm.runInNewContext(coreSource, { window: fixtureWindow });
const { DocumentModel } = fixtureWindow.MewEditorCore;
const diffSource = coreSource + '\n' + (await Promise.all(['pdf-selection-diff.js', 'pdf-connection.js']
  .map(name => readFile(new URL('../../public/pdfdiff/' + name, import.meta.url), 'utf8')))).map(inlineModule).join('\n') + textEditFixture;
const engineSource = diffSource + '\n' + selectionMappingSource;
const highlightSource = popupSource.split('// Shared review popup, session, navigation and saving.')[0];
const providerSource = highlightSource + '\n(() => {\nconst nativeEditor = !!window.PdfSelectionOptions?.nativeEditor;\nconst { fontKeys } = window.PdfSelectionDiff;\nconst { PdfLocator, textItemBaseline, fontStyle, sourceDecorations, sourceHover, fontSummary, comparisonRows, reviewIds, readPageText, readPageFonts, layerFonts } = window.PdfReviewProvider;\n'
  + section(reviewFile, '// PDF comparison is one review provider. Selection synchronization remains independent.', 'window.PdfReviewReady = (async () => {')
    .replace('function presentation(context, item) {', `PdfLocator.prototype.prepareReview ||= function ${preparationEntry};\nPdfLocator.prototype.reviewItems ||= function ${reviewEntry};\nfunction presentation(context, item) {`)
  + section(reviewFile, '  host = window.ReplacementReview;', '  return window.PdfReviewProvider;')
    .replace('start, prepare, PdfLocator', 'PdfLocator') + '\n})();';
const selectionSource = `
window.lastNotice = null;
window.addEventListener('pdf-selection-difference', event => { window.lastNotice = event.detail; });
window.addEventListener('pdf-selection-highlight-status', event => { if (event.detail.mode === null) window.lastNotice = null; });
` + selectionFile;
const source = `if (!window.PdfReviewProvider?.highlights) { ${fullReviewSource} }` + selectionSource;
const highlightSelectionSource = fullReviewSource + selectionSource;
const readerMenu = (await readFile(new URL('../../public/reader.html', import.meta.url), 'utf8')).match(/<button id="diffHighlightBtn".*?<\/button>/)[0];
function engine(script = engineSource, globals = {}) {
  const window = {};
  vm.runInNewContext(script, { window, ...globals });
  const { DocumentModel } = window.MewEditorCore;
  return Object.assign({ DocumentModel,
    applyEdits: ({ source, edits }) => new DocumentModel({ text: source }).applyEdits(edits),
    validateEdits: (source, edits) => new DocumentModel({ text: source }).validateEdits(edits) },
    window.PdfSelectionDiff, window.PdfReviewProvider);
}
function reviewProvider(api, providers = new Map(), selection, document = {}, globals = {}) {
  const window = { MewEditorCore: { DocumentModel: api.DocumentModel }, PdfSelection: selection, PdfSelectionDiff: api, PdfReviewProvider: api, ReplacementReview: { register: provider => { providers.set(provider.id, provider); return () => {}; } },
    addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(providerSource, { window, document, setInterval: () => 0, clearInterval() {}, ...globals });
  return window.PdfReviewProvider;
}

const countedEngineSource = engineSource.replace('function textDiff(left, right, details = false, limit = Infinity) {',
  '$& window.diffCalls = (window.diffCalls || 0) + 1;');
function locator(options = {}, environment = {}, script = engineSource, globals = {}) {
  const window = { document: { createElement: () => ({}) } };
  vm.runInNewContext(script, { window, ...globals });
  return new window.PdfReviewProvider.PdfLocator(options, environment);
}
const { sourceDecorations, PdfConnections } = engine();
export { DocumentModel, PdfConnections, sourceDecorations, coreSource, textEditFixture, reviewFile, popupSource, diffSource, mappingSource, engineSource, highlightSource,
  providerSource, fullReviewSource, fullReviewSource as fullProviderSource, source, readerMenu,
  countedEngineSource, engine, locator, reviewProvider, highlightSelectionSource };
