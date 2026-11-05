import assert from 'node:assert/strict';
import test from 'node:test';
import { engine } from './support/pdf-harness.mjs';

test('provider iteration finds the queue bounds and clears a previous font focus', () => {
  const api = engine(), locator = new api.PdfLocator();
  const items = [{ sourceStart: 2, sourceEnd: 8 }, { sourceStart: 4, sourceEnd: 4 },
    { sourceStart: 3, sourceEnd: 6, font: true }, { sourceStart: 10, sourceEnd: 12 }];
  locator.reviewLists.set(items, { entries: [], edits: [], plans: [] });
  locator.pattern = value => value;
  const selected = (start, end) => ({ sourceStart: start, sourceEnd: end, selection: true,
    comparison: { html: 'word' }, range: {}, pdfSource: {}, options: [{ edits: [] }] });
  const data = { items, index: {}, notice: { source: { start: 4, end: 5 } }, selection: selected(4, 5) };
  locator.cacheReview(data);
  assert.equal(data.focus, items[2]);
  assert.deepEqual(Array.from(data.selection.queueRange), [0, 2]);
  data.notice.source = { start: 8, end: 10 };
  data.selection = selected(8, 10);
  locator.cacheReview(data);
  assert.equal(data.focus, undefined);
  assert.deepEqual(Array.from(data.selection.queueRange), [3, 2]);
});

test('indexed differences preserve overlap order, insertion boundaries and snapshot invalidation', () => {
  const api = engine(), source = new api.PdfConnections(new api.PdfLocator(), { raw: 'x'.repeat(2000) });
  let items = [
    { sourceStart: 0, sourceEnd: 2000 },
    ...Array.from({ length: 500 }, (_, i) => ({ sourceStart: i * 3, sourceEnd: i * 3 + 2 })),
    { sourceStart: 500, sourceEnd: 500 },
    { sourceStart: 500, sourceEnd: 510, font: true }
  ];
  source.update = () => source.prepared ||= { pages: [] };
  source.candidates = () => items;
  const original = source.getDifferences();
  for (let start = 0; start <= 2000; start += 5) {
    for (const end of [start, start + 1, start + 100]) {
      const expected = items.filter(item => !item.font
        && !(item.sourceEnd <= start && item.sourceStart < start || item.sourceStart >= end && item.sourceEnd > end));
      assert.deepEqual(Array.from(source.differencesIn(start, end)), expected);
    }
  }
  items = [{ sourceStart: 300, sourceEnd: 310 }];
  source.prepared = null;
  assert.notEqual(source.getDifferences(), original);
  assert.equal(source.differencesIn(500, 500).length, 0);
  assert.equal(source.differencesIn(305, 306)[0], items[0]);
});

test('connection lookup reads local entries and refreshes when the connection table changes', () => {
  const api = engine(), locator = new api.PdfLocator();
  const source = new api.PdfConnections(locator, { raw: 'x'.repeat(40000) });
  const target = new api.PdfConnections(locator, { raw: source.raw });
  let reads = 0;
  const ranges = Array.from({ length: 10000 }, (_, i) => ({
    get start() { reads++; return i * 4; }, end: i * 4 + 4, targetStart: i * 4, targetEnd: i * 4 + 4
  }));
  const diff = { ranges: [[0, 4, 0, 4, { changed: false }]] };
  source.compare = () => diff;
  source.connections.set(target, { ranges, prepared: true });
  source.range(target, 39996, 39997);
  reads = 0;
  const hit = source.range(target, 39997, 39998);
  assert.equal(hit.start, 39997);
  assert.ok(reads < 100, `${reads} reads must not scan 10000 connections`);
  assert.equal(source.range(target, 39997, 39998, true).start, 39997);
  const selected = { start: 39996, end: 40000, targetStart: 10, targetEnd: 14 };
  source.connections.get(target).ranges = [selected, ...ranges];
  assert.equal(source.range(target, 39997, 39998).connection, selected);
  assert.equal(source.range(target, 39997, 39998).start, 11);
});

test('a selection spanning thousands of diff fragments reads only its boundary fragments', () => {
  const api = engine(), locator = new api.PdfLocator();
  const source = new api.PdfConnections(locator, { raw: 'a'.repeat(10000) });
  const target = new api.PdfConnections(locator, { raw: source.raw });
  let reads = 0;
  const parts = Array.from({ length: 10000 }, (_, i) => [i, i + 1, i, i + 1, { changed: false }]);
  const ranges = new Proxy(parts, { get(array, key) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(array, key);
  } });
  source.compare = () => ({ ranges });
  const connection = { start: 0, end: 10000, targetStart: 0, targetEnd: 10000 };
  for (const reverse of [false, true]) {
    reads = 0;
    const hit = source.range(target, 1, 9999, reverse, connection);
    assert.equal(hit.start, 1);
    assert.equal(hit.end, 9999);
    assert.ok(reads < 100, `${reads} reads must not traverse the selected fragments`);
  }
});

test('real diff lookup retains inserted characters, missing tails and Unicode in both directions', () => {
  const api = engine(), locator = new api.PdfLocator();
  for (const [html, pdf] of [['work', 'works'], ['word', 'sword'], ['中文', '中间文'],
    ['a𠀀b', 'a𠀀𠀁b'], ['Alpha wrong omega', 'Alpha right omega'], ['Before lost after', 'Before after']]) {
    const source = new api.PdfConnections(locator, { raw: html });
    const target = new api.PdfConnections(locator, { raw: pdf });
    const connection = source.remember(0, html.length, target, { start: 0, end: pdf.length });
    assert.ok(connection);
    const hit = source.range(target, 0, html.length);
    assert.equal(pdf.slice(hit.start, hit.end), pdf);
    const reverse = source.range(target, 0, pdf.length, true);
    assert.equal(html.slice(reverse.start, reverse.end), html);
  }
});
