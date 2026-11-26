import assert from 'node:assert/strict';
import test from 'node:test';
import { engine } from './support/pdf-harness.mjs';

function fixture(html, raw = html) {
  const api = engine();
  let target;
  const locator = new api.PdfLocator({}, {
    document: { createElement: () => ({}) }, getTargets: () => [target]
  });
  const source = new api.PdfConnections(locator, html);
  target = new api.PdfConnections(locator, { raw, parts: [
    { start: 0, end: raw.length, font: { name: 'body', italic: false, bold: false } }
  ] });
  return { api, locator, source, target };
}

test('one forward connection supplies both directions without a reverse graph', () => {
  const { api, source, target } = fixture('Before a uniquely worded passage after.');
  assert.equal(source.update, undefined, 'connect is the only connection update entry');
  source.getDifferences([target]);
  assert.ok(source.pairs.every(item => item instanceof api.diffIndex));
  for (const { editorDiff } of source.pairs) {
    assert.ok(editorDiff instanceof api.diffIndex);
    assert.ok(editorDiff.parts.every(part => part instanceof api.diffIndex));
  }
  const start = source.raw.indexOf('uniquely'), end = start + 8;
  const forward = source.range(target, start, end);
  const reverse = source.range(target, forward.start, forward.end, true);
  assert.equal(reverse.start, start);
  assert.equal(reverse.end, end);
  assert.equal(target.connections.get(source), undefined);
  assert.equal(source.range(target, start, end).connection, forward.connection);
});

test('reverse alignment reads the original spans in the opposite direction', () => {
  const html = 'A distinctive passage contains cat before the ending.';
  const pdf = 'A distinctive passage contains cart before the ending.';
  const { source, target } = fixture(html, pdf);
  const original = target.remember(0, pdf.length, source, { start: 0, end: html.length });
  source.connect(target);
  const [reversed] = source.targetConnections(target);
  assert.equal(reversed.spans, original.spans);
  const [part] = source.compare(reversed).reviewRanges;
  assert.deepEqual([part.html, part.pdf, part.start, part.targetStart], ['', 'r', html.indexOf('cat') + 2, pdf.indexOf('cart') + 2]);
  assert.deepEqual(Array.from(target.compare(original).reviewRanges, part => [part.html, part.pdf]), [['r', '']]);
});

test('extending an accepted range writes to its existing connection', () => {
  const shared = 'A distinctive passage';
  const html = shared + ' continues' + ' a'.repeat(200), pdf = shared + ' continues!' + ' x'.repeat(200);
  const { source, target } = fixture(html, pdf);
  const connection = source.remember(0, shared.length, target, { start: 0, end: shared.length });
  const ranges = source.targetConnections(target, false), originalDiff = source.compare(connection);
  const originalSpans = connection.spans;
  assert.equal(source.remember(0, html.length, target, { start: 0, end: pdf.length }, { extend: connection }), null);
  assert.equal(connection.end, shared.length);
  assert.equal(connection.spans, originalSpans);
  assert.equal(connection.editorDiff, originalDiff);
  const end = html.indexOf(' a', shared.length), targetEnd = pdf.indexOf(' x', shared.length);
  assert.equal(source.remember(0, end, target, { start: 0, end: targetEnd }, { extend: connection }), connection);
  assert.equal(source.targetConnections(target, false), ranges);
  assert.deepEqual(Array.from(ranges), [connection]);
  assert.deepEqual([connection.html, connection.pdf, connection.end, connection.targetEnd, connection.changed],
    [html.slice(0, end), pdf.slice(0, targetEnd), end, targetEnd, true]);
  assert.notEqual(source.compare(connection), originalDiff);
});

test('connection records keep text, discrepancy and edge metadata at named coordinates', () => {
  const { api } = fixture('unused');
  const part = new api.diffIndex('wrong ', 'right\n', 12, 34, true);
  assert.equal(part.start, 12);
  assert.equal(part.end, 18);
  assert.equal(part.targetStart, 34);
  assert.equal(part.targetEnd, 40);
  assert.equal(part.sourceEdge, 17);
  assert.equal(part.targetEdge, 39);
  assert.equal(part.inconsistent, true);
  assert.equal(new api.diffIndex('word-\nwrap', 'wordwrap', 0, 0, true).inconsistent, false);
});

test('selection connections preserve the prepared snapshot and its review queue', () => {
  const { source, target } = fixture('Before a uniquely worded passage after.');
  const data = source.getDifferences([target]), defaults = source.pairs;
  const start = source.raw.indexOf('uniquely');
  const selected = source.remember(start, start + 8, target, { start, end: start + 8 });
  assert.ok(source.livePairs.includes(selected));
  assert.ok(!defaults.includes(selected));
  assert.equal(source.getDifferences([target]), data);
  assert.equal(source.pairs, defaults);
  assert.equal(source.range(target, start, start + 8).connection, selected);
});

test('migration shifts retained mappings without changing the previous snapshot', () => {
  const passage = 'A uniquely worded passage ends with another distinct sentence.';
  const { api, locator, source, target } = fixture('Lead. ' + passage, passage);
  source.getDifferences([target]);
  const old = source.targetConnections(target)[0], snapshot = JSON.stringify(old.editorDiff);
  const current = new api.PdfConnections(locator, 'A longer lead. ' + passage);
  current.inherit(source);
  const shifted = current.targetConnections(target)[0];
  assert.equal(shifted.start - old.start, 'A longer lead. '.length - 'Lead. '.length);
  assert.equal(shifted.targetStart, old.targetStart);
  assert.equal(shifted.editorDiff, old.editorDiff);
  assert.equal(current.getDifferences([target]).items.length, 0);
  assert.equal(JSON.stringify(old.editorDiff), snapshot);
});

test('a font publication refreshes candidates while retaining text comparison', () => {
  const { source, target, locator } = fixture('Before a uniquely worded passage after.');
  const data = source.getDifferences([target]), connection = source.pairs[0], diff = connection.editorDiff;
  target.parts = target.parts.map(part => ({ ...part, font: { ...part.font, italic: true } }));
  target.fontVersion = 1;
  const current = source.getDifferences([target]);
  assert.notEqual(current, data);
  assert.equal(source.pairs[0], connection);
  assert.equal(connection.editorDiff, diff);
  assert.ok(connection.fontItems.length > 0);
  assert.ok(locator.cacheReview({ index: source, items: current.items }, { fonts: true }).items.some(item => item.font?.italic === true));
});

test('font indexing prepares its source through connect', async () => {
  const { locator, source, target } = fixture('Before a uniquely worded passage after.');
  target.pages = [{ start: 0, end: target.raw.length, parts: target.parts }];
  locator.indexDocument = async () => target;
  locator.environment.isCurrent = () => true;
  assert.equal(await locator.indexFonts({}, source), target);
  assert.ok(source.pairs.length);
});
