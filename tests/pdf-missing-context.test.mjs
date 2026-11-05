import { DocumentModel as FixtureDocument } from './support/pdf-harness.mjs';
import { sourceDecorations } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { engine, reviewProvider } from './support/pdf-harness.mjs';

const pages = JSON.parse(await readFile(new URL('./fixtures/pdf-missing-context-me08.json', import.meta.url), 'utf8'));
for (const page of pages) test(`ME08-${page.number} OCR differences use ordinary text ranges and retain missing-context reminders`, () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({
    set innerHTML(text) { this.content = { textContent: text.replace(/&nbsp;/g, '\u00a0') }; }
  }) } });
  const index = new api.PdfConnections(locator, page.source), target = new api.PdfConnections(locator, { raw: page.raw, sourcePages: [page.physical], parts: [] });
  index?.update([target]);
  locator.getDocumentIndex = () => target;
  const items = index.candidates(null, false, true, true, [target]), missing = items.filter(item => item.missing);
  assert.ok(items.length, 'normal differences take priority when the OCR mapping is reliable');
  if (page.number === 452) assert.ok(missing.some(item => item.comparison.html.includes('Namentlich schwankte Fleury')),
    'unresolved OCR retains selection review after shared phrases are recovered');
  const documentModel = new FixtureDocument({ model: { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) } }), model = documentModel.model;
  const decorations = () => sourceDecorations(index, index.candidates(null, false, false, true, [], [target].filter(Boolean).flatMap(target => index.connections.get(target)?.preparedRanges || index.connections.get(target)?.ranges || [])), false, true, undefined, documentModel);
  const marks = JSON.stringify(decorations());
  for (const item of missing) for (const segment of index.sourceSegments(item.sourceStart, item.sourceEnd)) assert.ok(decorations().some(mark =>
    !mark.options.before && mark.options.inlineClassName === 'mew-ocr-diff-text'
    && mark.range.startColumn <= segment.start + 1 && mark.range.endColumn >= segment.end + 1));
  for (const item of missing) {
    assert.equal(item.options[0].edits.length, 0);
    assert.equal(item.comparison.pdf, '');
    assert.equal(index.raw.slice(item.sourceStart, item.sourceEnd), item.comparison.html);
    for (const [start, end] of [[item.sourceStart, item.sourceEnd], [item.sourceStart + 1, item.sourceEnd - 1],
      [item.sourceStart + 1, item.sourceStart + 1], [item.sourceEnd - 1, item.sourceEnd - 1]]) {
      const location = locator.findLocations({}, [{ index, start, end, marked: start === end,
        text: index.raw.slice(start, end), before: '', after: '' }], true)[0];
      if (!location.notice?.missing) {
        assert.ok(location.targets.length, 'a confirmed normal mapping takes priority over the reminder');
        continue;
      }
      assert.equal(location.notice.source.start, start < end ? start : item.sourceStart);
      assert.equal(location.notice.source.end, start < end ? end : item.sourceEnd);
      assert.equal(location.notice.html, index.raw.slice(location.notice.source.start, location.notice.source.end));
      assert.equal(location.targets.length, 0, 'missing OCR has no word boxes to highlight');
      assert.equal(JSON.stringify(decorations()), marks, 'selection leaves the prepared HTML ranges fixed');
    }
  }
  assert.equal(sourceDecorations(index, index.candidates(null, false, false, false, [target], [target].filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || [])), false, false, undefined, documentModel).length, 0);
  assert.equal(index.source, page.source);
  delete target.sourcePages;
  assert.equal(index.candidates(null, false, true, true, [target]).filter(item => item.missing).length, 0, 'a clipped visible page cannot establish missing file edges');
});

test('ME08-327 recovers exact words before its first passage without treating the page header as a replacement', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const page = pages.find(page => page.number === 327), index = new api.PdfConnections(locator, page.source);
  const target = new api.PdfConnections(locator, { raw: page.raw, sourcePages: [page.physical], parts: [] });
  index?.update([target]);
  const start = index.raw.indexOf('erklärt:'), end = start + 'erklärt:'.length;
  const range = index.range(target, start, end);
  assert.equal(target.raw.slice(range.start, range.end), 'erklärt:');
  const items = index.candidates(null, false, true, true, [target]);
  assert.ok(!items.some(item => item.sourceStart < end && item.sourceEnd > start));
  assert.ok(items.some(item => item.missing && item.comparison.html.includes('Kinkel')));
  assert.ok(!items.some(item => item.comparison.pdf.includes('Die großen Männer des Exils')));
});

test('ME08-452 recovers shared phrases when punctuation noise exceeds the fine token budget', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const page = pages.find(page => page.number === 452), index = new api.PdfConnections(locator, page.source);
  const target = new api.PdfConnections(locator, { raw: page.raw, sourcePages: [page.physical], parts: [] });
  index?.update([target]);
  const items = index.candidates(null, false, true, true, [target]);
  for (const text of ['Dronke und', 'Abend wieder zu ihm', 'nur im ersten', 'An die Redaktion der', 'während welcher Zeit ihm']) {
    const start = index.raw.indexOf(text), end = start + text.length;
    assert.ok(start >= 0);
    assert.ok(!items.some(item => item.missing && item.sourceStart < end && item.sourceEnd > start), text);
    const hit = index.range(target, start, end);
    assert.equal(target.raw.slice(hit.start, hit.end), text);
  }
  const gaps = items.filter(item => item.missing);
  const start = index.raw.indexOf(' nicht. Dronke') + 1, end = start + 'nicht.'.length;
  assert.ok(!gaps.some(item => item.sourceStart < end && item.sourceEnd > start),
    'punctuation noise cannot turn the surviving word nicht into a missing-text report');
  const hit = index.range(target, start, end);
  assert.equal(target.raw.slice(hit.start, hit.end), 'nicht');
  assert.ok(items.some(item => !item.missing && item.sourceStart >= start && item.sourceEnd <= end
    && item.comparison.html === '.' && item.comparison.pdf === ''), 'only the actual punctuation difference is reported');
  for (const [connection] of [target].filter(Boolean).flatMap(target => index.connections.get(target)?.preparedRanges || index.connections.get(target)?.ranges || [])) {
    assert.ok(!gaps.some(item => item.sourceStart < connection.end && item.sourceEnd > connection.start),
      'missing boundaries exclude every confirmed connection');
  }
  api.validateEdits(page.source, items.flatMap(item => item.options[0].edits));
  assert.ok(items.some(item => item.missing), 'unlocatable and reordered text remains an addition with a warning');
});

test('missing-context popup shows an ordinary text comparison and warning without replacement edits', () => {
  const api = engine(), providers = new Map();
  reviewProvider(api, providers, { refresh() {} });
  const provider = providers.get('pdf-ocr'), index = new api.PdfConnections(new api.PdfLocator({}, { document: { createElement: () => ({}) } }), '<p>Missing from OCR. A confirmed passage with enough words to match uniquely.' + ' Missing ending.'.repeat(10) + '</p>');
  const target = new api.PdfConnections(index.locator, { raw: 'A confirmed passage with enough words to match uniquely.', sourcePages: [1] });
  index?.update([target]);
  const item = index.candidates(null, false, true, true, [target]).filter(item => item.missing)[0];
  const content = provider.content({ context: { index }, model: { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) } }, item);
  assert.match(content.message, /PDF OCR.*文字/u);
  assert.equal(content.comparison.length, 2);
  assert.ok(content.comparison[0].parts.some(part => part.changed && part.text.includes('Missing from OCR.')));
  assert.equal(content.apply, false);
  assert.ok(content.previewDecorations.length);
  assert.ok(content.previewDecorations.every(mark => mark.options.inlineClassName === 'mew-review-proposed'));
  assert.equal(item.options[0].edits.length, 0);
});

test('ME08-453 normal diff resolves the missing phrase without selecting its whole context', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const page = pages.find(page => page.number === 453), index = new api.PdfConnections(locator, page.source);
  const target = new api.PdfConnections(locator, { raw: page.raw, sourcePages: [page.physical], parts: [] });
  index?.update([target]);
  locator.getDocumentIndex = () => target;
  const text = 'gemacht, die in Beziehung zu de', start = index.raw.indexOf(text), end = start + text.length;
  assert.ok(start >= 0);
  assert.ok(!index.candidates(null, false, true, true, [target]).filter(item => item.missing).some(item => item.sourceStart < end && item.sourceEnd > start));
  const location = locator.findLocations({}, [{ index, start, end, text, marked: true }], true)[0];
  assert.ok(!location.notice?.missing);
  assert.ok(location.targets.length);
  const hit = index.range(target, start, end);
  assert.ok(hit.end - hit.start < text.length, 'normal deletion maps to its small OCR counterpart');
});

test('missing additions have no fabricated PDF carets and retain missing-context notices', () => {
  const api = engine(), visible = [], locator = new api.PdfLocator({}, {
    document: { createElement: () => ({}) }, getVisiblePages: () => visible
  });
  const text = 'A confirmed passage with enough words to match uniquely.';
  const index = new api.PdfConnections(locator, '<p>Missing opening. ' + text + ' Missing ending.'.repeat(10) + '</p>');
  const target = new api.PdfConnections(locator, { raw: text, sourcePages: [1] });
  const rendered = new api.PdfConnections(locator, { raw: text, layer: {}, parts: [{ start: 0, end: text.length }] });
  visible.push({ number: 1, index: rendered });
  index?.update([target, rendered]);
  locator.getDocumentIndex = () => target;
  const connections = index.byTarget.get(rendered), gaps = index.candidates(null, false, true, true, [target]).filter(item => item.missing);
  assert.equal(gaps.length, 2);
  for (const [side, gap] of gaps.entries()) {
    const { targets, notice } = locator.findLocations({}, [{ index, start: gap.sourceStart, end: gap.sourceEnd,
      text: gap.comparison.html, marked: true }], true)[0];
    assert.equal(targets.length, 0, 'an absent OCR counterpart has no PDF marker');
    assert.equal(notice.missing, true);
    assert.equal(notice.source.start, gap.sourceStart);
    assert.equal(notice.source.end, gap.sourceEnd);
  }
  assert.equal(index.byTarget.get(rendered), connections, 'a missing addition cannot become a confirmed OCR mapping');
});


test('a missing cross-page highlight resolves its destination before that page becomes visible', () => {
  const api = engine(), pdf = {};
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getPdf: () => pdf, getVisiblePages: () => [] });
  const full = { raw: 'first page\nsecond page', pages: [
    { number: 1, start: 0, end: 10, parts: [] },
    { number: 2, start: 11, end: 22, parts: [{ end: 22, item: { str: 'second page' } }] }
  ] };
  locator.getDocumentIndex = () => full;
  const source = { raw: 'missing', prepare() {}, pairs: () => [{ start: 0, end: 7 }],
    differences: { items: [{ missing: true, sourceStart: 0, sourceEnd: 7 }] },
    missingRange(target) { assert.equal(target, full); return { start: 17, end: 17, endBias: true }; } };
  const [location] = locator.findLocations(pdf, [{ index: source, start: 0, end: 7, marked: true }], true);
  assert.equal(location.targets.length, 1);
  assert.equal(location.targets[0].pageNumber, 2);
  assert.deepEqual({ ...location.targets[0].range }, { start: 6, end: 6, endBias: true });
});
