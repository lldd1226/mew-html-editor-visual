import { DocumentModel as FixtureDocument } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { engine } from './support/pdf-harness.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/pdf-missing-me06.json', import.meta.url), 'utf8'));
for (const fixture of fixtures) test(`ME06-${fixture.number} missing footnotes use the last paired word edge`, () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, fixture.source);
  const target = new api.PdfConnections(locator, { raw: fixture.raw, parts: fixture.parts });
  source.connections.set(target, { preparedRanges: fixture.connections.map(connection => ({ ...connection, target })) });
  const expected = fixture.raw.trimEnd().length;
  for (const missing of fixture.missing) {
    assert.deepEqual({ ...source.missingRange(target, missing.start, missing.end) }, { start: expected, end: expected, endBias: true });
    assert.equal(fixture.raw.slice(0, expected).endsWith(fixture.number === 397 ? 'Weltkrieg' : 'als'), true);
    const page = { number: 1, start: 0, end: target.raw.length };
    target.pages = [page];
    source.prepared = { full: target };
    const visible = new api.PdfConnections(locator, { raw: target.raw, parts: target.parts,
      layer: { closest: () => ({ dataset: { pageNumber: '1' } }) } });
    assert.deepEqual({ ...source.missingRange(visible, missing.start, missing.end) }, { start: expected, end: expected, endBias: true });
  }
});

test('missing anchors ignore OCR noise and stay inside the paired part of a text node', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [raw, parts] of [
    ['word noise tail', [{ start: 0, end: 4 }, { start: 5, end: 10 }, { start: 11, end: 15 }]],
    ['word noise tail', [{ start: 0, end: 15 }]]
  ]) {
    const source = new api.PdfConnections(locator, 'word missing tail');
    const target = new api.PdfConnections(locator, { raw, parts });
    source.connections.set(target, { preparedRanges: [
      { start: 0, end: 4, targetStart: 0, targetEnd: 4, target },
      { start: 13, end: 17, targetStart: 11, targetEnd: 15, target }
    ] });
    assert.deepEqual({ ...source.missingRange(target, 5, 12) }, { start: 4, end: 4, endBias: true });
  }
});

test('missing anchors reuse the missing ranges from final candidates', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'word missing tail');
  const target = new api.PdfConnections(locator, { raw: 'word noise tail', parts: [
    { start: 0, end: 4 }, { start: 5, end: 10 }, { start: 11, end: 15 }
  ], sourcePages: [1] });
  const connections = [
    api.diffIndex.between(source, 0, 4, target, 0, 4),
    api.diffIndex.between(source, 13, 17, target, 11, 15)
  ];
  source.connections.set(target, { prepared: true, preparedRanges: connections });
  const items = source.candidates([target]);
  const missing = items.find(item => item.missing);
  assert.ok(missing);
  assert.ok(items.missingRanges.includes(missing.comparison));
  assert.deepEqual({ ...missing.comparison }, { html: ' missing ', pdf: '' });
  assert.ok(!Object.keys(items).includes('missingRanges'));
  source.prepared = { full: target, pages: [target], pairs: connections, differences: { index: source, items } };
  source.candidates = () => { throw new Error('missing anchor rebuilt the candidate queue'); };
  assert.deepEqual({ ...source.missingRange(target, missing.sourceStart, missing.sourceEnd) },
    { start: 4, end: 4, endBias: true });
});

test('missing before any correspondence uses the first nonblank document box', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'missing word'), target = new api.PdfConnections(locator,
    { raw: '  header word', parts: [{ start: 0, end: 9 }, { start: 9, end: 13 }] });
  source.connections.set(target, { preparedRanges: [{ start: 8, end: 12, targetStart: 9, targetEnd: 13, target }] });
  assert.deepEqual({ ...source.missingRange(target, 0, 7) }, { start: 2, end: 2, endBias: false });
});

test('ME06-400 repeated final-word edits keep missing footnotes separate from OCR insertions', () => {
  const fixture = fixtures.find(fixture => fixture.number === 400), api = engine(), pdf = {};
  let value = fixture.source, version = 1, target;
  const documentModel = new FixtureDocument({ model: { getValue: () => value, getVersionId: () => version } }), model = documentModel.model;
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getPdf: () => pdf, getSourcePages: () => [1], getTargets: () => [target] });
  target = new api.PdfConnections(locator, { raw: fixture.raw, parts: fixture.parts, sourcePages: [1] });
  locator.documents.set(pdf, new Map([['pages:1', target]]));
  let source = locator.editorSourceIndex(documentModel, [target]);
  const ranges = fixture.connections.map(connection => ({ ...connection, target }));
  source.connections.set(target, { prepared: true, scope: { start: 0, end: source.raw.length }, ranges, preparedRanges: ranges });
  source.getDifferences();
  for (const word of ['ALSW', 'a', '', 'als', 'alsX', 'als']) {
    value = value.replace(/sondern [^<]*<\/p>/, `sondern ${word}</p>`); version++; documentModel.update(documentModel.content);
    source = locator.editorSourceIndex(documentModel);
    const items = source.getDifferences().items;
    assert.ok(items.some(item => item.missing && item.comparison.html.includes('1 (1891) sind')
      && item.comparison.html.includes('Arbeitskraft, die')), `footnotes remain missing after ${JSON.stringify(word)}`);
    assert.ok(!items.some(item => item.comparison?.pdf && item.comparison.html.includes('(1891)')));
    if (word === 'a' || !word) assert.ok(items.some(item => item.sourceStart === item.sourceEnd && item.comparison.pdf.trimEnd() === (word ? 'ls' : 'als')),
      `OCR insertion remains reviewable: ${JSON.stringify(items.map(item=>item.comparison))}`);
  }
});
