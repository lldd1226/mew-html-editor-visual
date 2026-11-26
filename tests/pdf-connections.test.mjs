import { reviewCandidates } from './support/pdf-harness.mjs';
import { DocumentModel as FixtureDocument } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { engine, connectionParts } from './support/pdf-harness.mjs';

test('a confirmed selection supplies reverse mapping and review without another text search', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, '<p>Before <i>word</i> after.</p>');
  const target = new api.PdfConnections(locator, { raw: source.raw });
  const start = source.raw.indexOf('word'), end = start + 4;
  source.scopes.set(target, { prepared: true });
  let searches = 0;
  const locate = target.search;
  target.search = function (...args) { searches++; return locate.apply(this, args); };
  source.search = () => { throw new Error('reverse selection must reuse the confirmed mapping'); };
  const entry = source.entry(start, end);
  const hit = source.locate(target, entry);
  assert.equal(hit.start, start);
  assert.equal(hit.end, end);
  const reverse = source.locate(target, { ...entry, start: hit.start, end: hit.end }, true);
  assert.equal(reverse.start, start);
  assert.equal(reverse.end, end);
  assert.equal(reverse.connection, hit.connection);
  const pairs = [target].filter(Boolean).flatMap(target => source.connections.get(target)?.ranges || []);
  assert.equal(pairs[0][0], hit.connection);
  assert.equal(source.compare(target, pairs[0][0]), hit.connection.editorDiff);
  assert.equal(searches, 1);
});

test('an explicit PDF caret bypasses search and remains independent of rendering metadata', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'Before lost after.'), target = new api.PdfConnections(locator, 'Before after.');
  const start = source.raw.indexOf('lost');
  source.scopes.set(target, { prepared: true });
  target.search = () => { throw new Error('an explicit caret must not search for unrelated text'); };
  const range = { start, end: start, endBias: true };
  const entry = { ...source.entry(start, start + 4), range };
  const hit = source.locate(target, entry, false, undefined, true);
  hit.difference = { html: 'lost', pdf: '' };
  assert.deepEqual(range, { start, end: start, endBias: true });
  assert.equal(hit.start, hit.end);
  assert.ok(source.byTarget.get(target).includes(hit.connection));
});

test('selection additions leave the prepared default mapping intact', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'Before a unique selected word after.'), target = new api.PdfConnections(locator, source.raw);
  const prepared = source.connect([target]), defaults = source.pairs;
  const start = source.raw.indexOf('selected'), end = start + 8;
  const selected = source.remember(start, end, target, { start, end });
  assert.equal(source.entry(start, end).index, source);
  assert.equal(source.pairs, defaults);
  assert.ok(!defaults.some(([connection]) => connection === selected));
  assert.ok([target].filter(Boolean).flatMap(target => source.connections.get(target)?.ranges || []).some(([connection]) => connection === selected));
  source.connect([target]);
  assert.ok(!source.pairs.some(([connection]) => connection === selected));
  assert.equal(source.range(target, start, end).connection, selected);
});

test('layout punctuation remains an ordinary difference instead of missing OCR text', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'before ..... after'), target = new api.PdfConnections(locator, { raw: 'before  after', parts: [] });
  const connection = { start: 0, end: source.raw.length, targetStart: 0, targetEnd: target.raw.length, target };
  source.connections.set(target, { prepared: true, ranges: [connection], preparedRanges: [connection] });
  const item = reviewCandidates(source, { fonts: false, edits: true, text: true, targets: [], connections: [connection] }).find(item => item.comparison.html.includes('.....'));
  assert.ok(item);
  assert.equal(item.missing, undefined);
  assert.equal(item.comparison.pdf, '');
});

test('an overlapping confirmed mapping removes a broad connection seam from the queue', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'before wich-\r\n\r\n1 footnote tail');
  const target = new api.PdfConnections(locator, { raw: 'before\nfootnote tail', parts: [] });
  const broad = { start: 0, end: source.raw.length, targetStart: 0, targetEnd: target.raw.length, target };
  broad.editorDiff = { reliable: true, parts: connectionParts(api, [
    ['before wich-', 'before'], ['\r\n\r\n1 ', '\n'], ['footnote tail', 'footnote tail']
  ]) };
  const seamTarget = new api.PdfConnections(locator, { raw: '\r\n1 footnote tail', parts: [] });
  const seam = { start: source.raw.indexOf('\r\n\r\n'), end: source.raw.length, targetStart: 0, targetEnd: seamTarget.raw.length, target: seamTarget };
  source.connections.set(target, { prepared: true, ranges: [broad], preparedRanges: [broad] });
  source.connections.set(seamTarget, { prepared: true, ranges: [seam], preparedRanges: [seam] });
  const items = reviewCandidates(source, { fonts: false, edits: true, text: true, targets: [], connections: [broad, seam] });
  assert.ok(items.some(item => item.comparison.html === 'before wich-'));
  assert.ok(!items.some(item => item.sourceStart < seam.end && item.sourceEnd > seam.start));
});

test('font refresh invalidates classified results while retaining text alignment', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, '<p>Before <i>word</i> after.</p>');
  const start = source.raw.indexOf('word'), end = start + 4;
  const target = new api.PdfConnections(locator, { raw: source.raw, fontVersion: 0, parts: [
    { start: 0, end: start, font: { italic: false, bold: false } },
    { start, end, font: { italic: false, bold: false } },
    { start: end, end: source.raw.length, font: { italic: false, bold: false } }
  ] });
  source.connect([target]);
  const original = source.getDifferences(), connection = source.byTarget.get(target)[0];
  const alignment = connection.editorDiff.parts;
  assert.ok(original.items.some(item => item.font && item.text === 'word'));
  assert.equal(source.getDifferences(), original);
  assert.equal(source.fontsCurrent, true);
  target.parts[1].font.italic = true;
  target.fontVersion++;
  assert.equal(source.fontsCurrent, false);
  const refreshed = source.getDifferences();
  assert.notEqual(refreshed, original);
  assert.equal(refreshed.items.filter(item => item.font).length, 0);
  assert.equal(connection.editorDiff.parts, alignment);
  assert.equal(source.fontsCurrent, true);
  assert.equal(source.getDifferences(), refreshed);
});

test('an edit before a connection migrates one shared mapping without changing the old index', () => {
  const api = engine(), pdf = {};
  let value = '<p>Lead.</p><p>Alpha wrong omega.</p>', version = 1;
  const documentModel = new FixtureDocument({ model: { getValue: () => value, getVersionId: () => version } }), model = documentModel.model;
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf });
  const previous = locator.editorSourceIndex(documentModel), start = previous.raw.indexOf('Alpha');
  const end = previous.raw.indexOf('\n', start), target = new api.PdfConnections(locator, 'Alpha right omega.');
  previous.targets = [target];
  const connection = previous.remember(start, end, target, { start: 0, end: target.raw.trimEnd().length });
  previous.compare(target, connection);
  previous.scopes.set(target, { scope: { start, end }, prepared: true, connections: [connection] });
  const snapshot = JSON.stringify(connection), alignment = connection.editorDiff.parts;
  value = value.replace('Lead.', 'A longer lead.'); version++; documentModel.update(documentModel.content);
  const current = locator.editorSourceIndex(documentModel), migrated = current.byTarget.get(target)[0];
  assert.equal(current.scopes.get(target).connections[0], migrated);
  assert.equal(migrated.editorDiff.parts, alignment);
  assert.equal(JSON.stringify(connection), snapshot);
  const at = current.raw.indexOf('wrong'), hit = current.range(target, at, at + 5);
  assert.equal(target.raw.slice(hit.start, hit.end), 'right');
});
