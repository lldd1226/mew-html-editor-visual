import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { engine } from './support/pdf-harness.mjs';

test('ME04-233 keeps dash-separated footnotes aligned across both PDF pages', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me04-233.json', import.meta.url), 'utf8'));
  const api = engine(), pdf = {}, numbers = [255, 256];
  const layers = fixture.pages.map((raw, i) => ({ raw, parts: [{ start: 0, end: raw.length }],
    layer: { closest: () => ({ dataset: { pageNumber: numbers[i] } }) } }));
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf, getSourcePages: () => numbers });
  const index = new api.PdfConnections(locator, fixture.source);
  let raw = '';
  const pages = fixture.pages.map((text, i) => {
    const start = raw.length, end = start + text.length;
    raw += text + '\n';
    return { number: numbers[i], start, end, parts: [{ start, end }] };
  });
  const target = new api.PdfConnections(locator, { raw, pages, sourcePages: numbers });
  const rendered = layers.map(page => new api.PdfConnections(locator, page));
  locator.environment.getTargets = () => rendered;
  index.connect();
  locator.documents.set(pdf, new Map([[`pages:${numbers.join(',')}`, target]]));

  const { items } = locator.cacheReview({ index, items: index.getDifferences().items });
  const notes = ['des Haders müde', 'kleine Vergnügen (die mit Nebenausgaben verbunden sind)', 'ganz einfach',
    'Eigentum ist Diebstahl', 'Großkordon (Ordensband)'];
  const tail = items.filter(item => item.sourceStart >= index.raw.indexOf(notes[0]) - 2);
  assert.deepEqual(Array.from(tail, item => [item.comparison.html, item.comparison.pdf, !!item.missing]),
    [['4', '1', false], ['5', '2', false]]);
  assert.deepEqual(Array.from(tail, item => Array.from(item.options[0].edits, edit => [edit.expected, edit.text])),
    [[['4', '1']], [['5', '2']]]);

  for (const [i, note] of notes.entries()) {
    const start = index.raw.indexOf(note), end = start + note.length;
    const page = pages[Number(i >= 3)];
    const hit = index.range(target, start, end);
    assert.ok(hit && hit.start >= page.start && hit.end <= page.end, note);
    assert.equal(raw.slice(hit.start, hit.end), note);
    const reverse = index.range(target, hit.start, hit.end, true);
    assert.deepEqual([reverse?.start, reverse?.end], [start, end], note);
    const layer = rendered[Number(i >= 3)], local = index.range(layer, start, end);
    assert.ok(local, note);
    assert.equal(layer.raw.slice(local.start, local.end), note);
    const localReverse = index.range(layer, local.start, local.end, true);
    assert.deepEqual([localReverse?.start, localReverse?.end], [start, end], note);
  }

  const note = notes[2], start = index.raw.indexOf(note), end = start + note.length;
  const nextPage = rendered[1], edge = nextPage.raw.length;
  locator.environment.getVisiblePages = () => [{ number: numbers[1], index: nextPage }];
  // In the full scan, the next page's text layer can map this note to an empty range.
  const range = index.range.bind(index);
  index.range = (pdfIndex, from, to, ...args) => pdfIndex === nextPage && from === start && to === end
    ? { start: edge, end: edge, approximate: true } : range(pdfIndex, from, to, ...args);
  let indexed = false;
  locator.getDocumentIndex = () => indexed ? target : undefined;
  locator.indexDocument = async () => { indexed = true; return target; };

  const entry = index.entry(start, end);
  for (const locations of [await locator.findLocations(pdf, [entry]), locator.findLocations(pdf, [entry])]) {
    const [location] = locations;
    assert.deepEqual(Array.from(location.targets, hit => [hit.pageNumber, hit.text, hit.difference]),
      [[numbers[0], note, null]]);
  }
});
