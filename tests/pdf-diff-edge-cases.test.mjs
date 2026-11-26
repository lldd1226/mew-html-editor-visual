import { reviewCandidates } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentModel, engine, sourceDecorations, connectionParts } from './support/pdf-harness.mjs';

function linked(source, target, raw = target.raw) {
  const connection = source.remember(0, source.raw.length, target, { start: 0, end: raw.length });
  source.connections.set(target, { prepared: true, scope: { start: 0, end: source.raw.length },
    ranges: [connection], preparedRanges: [connection] });
  source.prepared = { pdf: {}, full: target, pages: [target], pairs: [connection],
    connections: [[connection]], fonts: [{ parts: target.parts, pages: target.pages, fontVersion: target.fontVersion }] };
  source.prepared.differences = { index: source, connections: [connection], items: reviewCandidates(source, { fonts: false, edits: true, text: true, targets: [target] }) };
  return connection;
}

test('a supplied PDF caret is confirmed without probing other mappings', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'Before lost after.');
  const target = new api.PdfConnections(locator, 'Before after.');
  source.range = target.search = () => assert.fail('the supplied caret already fixes the target range');
  const range = Object.freeze({ start: 7, end: 7, endBias: true });
  const hit = source.locate(target, { ...source.entry(7, 11), range });
  assert.notEqual(hit, range);
  assert.deepEqual({ start: hit.start, end: hit.end, endBias: hit.endBias }, range);
  assert.equal(hit.connection, source.targetConnections(target, false)[0]);
});

test('PDF text layers that separate every letter still map to the unspaced HTML word', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator,
    'Ergebnis ist der Ungleichheit des Besitzes (the offspring of inequality of possessions)');
  const target = new api.PdfConnections(locator, {
    raw: 'Ergebnis ist der Ungleichheit des Besitzes (the offspring of i n e q u a l i t y of possessions)', parts: [] });
  assert.equal(target.normalized.text, source.normalized.text);
  assert.equal(api.normalized('D e r U n t e r e').text, api.normalized('Der Untere').text);
  const connection = linked(source, target);
  assert.equal(connection.distance, 0);
  assert.equal(connection.start, 0);
  assert.equal(connection.end, source.raw.length);
  assert.equal(connection.targetEnd, target.raw.length);
  assert.ok(!reviewCandidates(source, { fonts: false, edits: true, text: true, targets: [target] }).some(item => item.missing));
  const start = source.raw.indexOf('inequality'), hit = source.range(target, start, start + 'inequality'.length);
  assert.equal(target.raw.slice(hit.start, hit.end), 'i n e q u a l i t y');

  const words = new api.PdfConnections(locator, 'Der Untere');
  const spaced = new api.PdfConnections(locator, { raw: 'D e r U n t e r e', parts: [] });
  const whole = linked(words, spaced), word = words.range(spaced, words.raw.indexOf('Untere'), words.raw.length);
  assert.ok(whole);
  assert.equal(spaced.raw.slice(word.start, word.end), 'U n t e r e');
});

test('letter-spaced word runs use surrounding context instead of a broad approximate range', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const html = 'Die Vereinigung der Demokraten der verschiedenen Nationen schließt die Kritik nicht aus. ' +
    'Danach die Demokraten der verschiedenen Nationen mehr als eine Phrase.';
  const raw = 'D i e V e r e i n i g u n g der D e m o k r a t e n d e r v e r s c h i e d n e n ' +
    'N a t i o n e n s c h l i e ß t d i e K r i t i k n i c h t a u s . ' +
    'D a n a c h d i e D e m o k r a t e n d e r v e r s c h i e d - n e n N a t i o n e n m e h r a l s e i n e P h r a s e .';
  const source = new api.PdfConnections(locator, html), target = new api.PdfConnections(locator, { raw, parts: [], sourcePages: [1] });
  for (const [at, expected] of [[35, 'v e r s c h i e d n e n'], [115, 'v e r s c h i e d - n e n']]) {
    const located = source.locate(target, source.entry(at, at + 13), false, undefined, true);
    assert.equal(located && raw.slice(located.start, located.end), expected);
  }
});

test('visible-page lookup keeps a complete ng der Demokraten selection', () => {
  const api = engine(), raw = 'V e r e i n i g u n g d e r D e m o k r a t e n d e r v e r s c h i e d n e n';
  let target;
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => ({}),
    getVisiblePages: () => [{ number: 1, index: target }] });
  const source = new api.PdfConnections(locator, 'Die Vereinigung der Demokraten der verschiedenen');
  target = new api.PdfConnections(locator, { raw, parts: [], sourcePages: [1] });
  source.remember(0, source.raw.length, target, { start: 0, end: target.raw.length });
  const at = source.raw.indexOf('ng der Demokraten'), [location] = locator.findLocations({}, [source.entry(at, at + 17)], true);
  assert.equal(location.targets[0].text, 'n g d e r D e m o k r a t e n');
  assert.equal(location.targets[0].difference.pdf, 'n g d e r D e m o k r a t e n');
  assert.ok(!source.getDifferences([target]).items.some(item => item.sourceStart < at + 17 && item.sourceEnd > at),
    'the aligned phrase never enters the default review queue');
});

test('empty and newline-leading differences keep their comparison when mapping back from a marker', () => {
  const api = engine();
  for (const [html, pdf] of [['AB', 'AXB'], ['A\nB', 'A X B']]) {
    let target;
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
      getVisiblePages: () => [{ number: 1, index: target }] });
    const source = new api.PdfConnections(locator, html);
    target = new api.PdfConnections(locator, { raw: pdf, sourcePages: [1], parts: [{ start: 0, end: pdf.length }] });
    linked(source, target);
    const item = source.prepared.differences.items.find(item => item.comparison.pdf.includes('X'));
    assert.ok(item);
    target.layer = {};
    source.getDifferences = () => source.prepared.differences;
    const entry = source.candidateEntry(item);
    const [location] = locator.findLocations({}, [entry], true);
    assert.ok(location.targets.length, JSON.stringify([html, pdf]));
    assert.deepEqual(location.targets[0].range.end > location.targets[0].range.start, true);
    assert.deepEqual(location.targets[0].difference, item.comparison);
  }

  const whitespace = engine(), whitespaceLocator = new whitespace.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new whitespace.PdfConnections(whitespaceLocator, 'A B');
  const target = new whitespace.PdfConnections(whitespaceLocator, { raw: 'A  B', parts: [] });
  const connection = source.remember(0, source.raw.length, target, { start: 0, end: target.raw.length });
  connection.editorDiff = { reliable: true, parts: connectionParts(whitespace, [['A', 'A'], ['', ' '], ['B', ' B', false]]) };
  source.connections.set(target, { prepared: true, ranges: [connection], preparedRanges: [connection] });
  const hit = source.range(target, 1, 1, false, undefined, true);
  assert.deepEqual([hit.start, hit.end, target.raw.slice(hit.start, hit.end)], [1, 2, ' ']);
  const reverse = source.range(target, 2, 3, true, connection, true);
  assert.deepEqual([reverse.start, reverse.end, source.raw.slice(reverse.start, reverse.end)], [1, 2, ' ']);
});

test('whitespace-only PDF selections retain their raw difference', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const value = { html: 'A B', pdf: 'A  B' };
  const diff = api.comparisonIndex(value), { parts } = diff;
  assert.ok(!parts.some(part => part.inconsistent), 'default review ignores whitespace-only changes');
  assert.ok(parts.some(part => part.changed), 'selection review retains raw whitespace');
  assert.ok(diff instanceof api.diffIndex);
  assert.equal(api.comparisonIndex(value), diff);
  const rows = api.comparisonRows(value);
  assert.ok(diff.rows.includes(rows));
  assert.ok(!rows.some(row => row.parts.some(part => part.changed)));
  assert.ok(api.comparisonRows(value, true, false, true).some(row => row.parts.some(part => part.changed)));
  for (const [html, pdf, start, end] of [['A B', 'A  B', 1, 3], ['A B', 'A\nB', 1, 2], ['A\nB', 'A B', 1, 2]]) {
    const source = new api.PdfConnections(locator, html), target = new api.PdfConnections(locator, { raw: pdf, parts: [] });
    source.remember(0, html.length, target, { start: 0, end: pdf.length });
    const { hit, difference } = source.locateSource([{ index: target, start, end }]);
    assert.ok(hit, JSON.stringify([html, pdf]));
    assert.deepEqual([difference.html, difference.pdf], [html.slice(hit.start, hit.end), pdf.slice(start, end)]);
  }
});

test('letter-spacing stays selection-only and leaves a missing letter with an empty PDF counterpart', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const html = 'verschiedenen', pdf = 'v e r s c h i e d n e n';
  const source = new api.PdfConnections(locator, html), target = new api.PdfConnections(locator, { raw: pdf, parts: [] });
  linked(source, target);
  const items = reviewCandidates(source, { fonts: false, edits: true, text: true, targets: [target] });
  assert.deepEqual(Array.from(items, item => `${item.comparison.html}\0${item.comparison.pdf}`), ['e\0']);
  assert.ok(!items.some(item => item.comparison.html && !item.comparison.html.trim()
    || item.comparison.pdf && !item.comparison.pdf.trim()), 'inserted OCR spaces stay out of the default queue');
  const documentModel = new DocumentModel({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } });
  const marks = sourceDecorations(source, items, true, true, undefined, documentModel);
  assert.deepEqual(Array.from(marks, mark => [mark.range.startColumn - 1, mark.range.endColumn - 1]), [[9, 10]],
    'only the missing letter is marked by default');

  const value = { html, pdf };
  assert.deepEqual(Array.from(api.comparisonIndex(value).parts.filter(part => part.inconsistent),
    part => `${part.html}\0${part.pdf}`), ['e\0']);
  assert.ok(api.comparisonIndex(value).parts.some(part => part.changed && !part.html && part.pdf === ' '),
    'an explicit selection still retains every inserted OCR space');
});

test('normalized-only selections retain both the mapping and the raw difference', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, pdf, start, end] of [
    ['word-word', 'wordword', 4, 5],
    ['café', 'cafe\u0301', 3, 4],
    ['Ａ', 'A', 0, 1],
    ['ﬁ', 'fi', 0, 1],
    ['So’', "So'", 2, 3],
    ['A\u030A', 'Å', 0, 2]
  ]) {
    const source = new api.PdfConnections(locator, html), target = new api.PdfConnections(locator, { raw: pdf, parts: [] });
    source.remember(0, html.length, target, { start: 0, end: pdf.length });
    target.remember(0, pdf.length, source, { start: 0, end: html.length });
    const hit = source.range(target, start, end, false, undefined, true);
    assert.ok(hit, JSON.stringify([html, pdf]));
    const located = source.locateSource([{ index: target, start: hit.start, end: hit.end }]);
    assert.deepEqual([located.hit.start, located.hit.end, located.difference.html, located.difference.pdf], [start, end, html.slice(start, end), pdf.slice(hit.start, hit.end)]);
  }
});

test('selection reuses an ordinary gap rejected during page preparation', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const lead = 'The opening passage describes a very distinct sequence of events.';
  const tail = 'The final paragraph provides enough separate matching text for confirmation.';
  const source = new api.PdfConnections(locator, { raw: lead + ' ' + 'x'.repeat(180) + ' ' + tail });
  const target = new api.PdfConnections(locator, { raw: lead + ' ' + 'y'.repeat(180) + ' ' + tail });
  let attempts = 0;
  const remember = source.remember;
  source.remember = function (start, end, ...args) {
    if (start === lead.length + 1 && end === lead.length + 181) attempts++;
    return remember.call(this, start, end, ...args);
  };
  source.connect(target);
  assert.equal(attempts, 1);
  assert.equal(source.range(target, lead.length + 10, lead.length + 20), null);
  assert.equal(attempts, 1);
});

test('a cross-page gap already reachable by selection is not reported as missing text', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'Alpha footnote Beta');
  const raw = 'Alpha\nfootnote Beta', target = new api.PdfConnections(locator,
    { raw, sourcePages: [1, 2], parts: [{ start: 0, end: raw.length }] });
  const at = source.raw.indexOf('Beta'), targetAt = raw.indexOf('Beta');
  const first = source.remember(0, 5, target, { start: 0, end: 5 });
  const second = source.remember(at, source.raw.length, target, { start: targetAt, end: raw.length });
  target.pages = [{ number: 1, start: 0, end: 6, parts: [] },
    { number: 2, start: 6, end: raw.length, parts: [{ start: 6, end: raw.length }] }];
  source.connections.set(target, { prepared: true, scope: { start: 0, end: source.raw.length },
    ranges: [first, second], preparedRanges: [first, second] });
  source.prepared = { pdf: {}, full: target, pages: [target], pairs: [first, second],
    connections: [[first, second]], fonts: [{ parts: target.parts, pages: target.pages, fontVersion: target.fontVersion }] };
  const [range] = source.candidates([target], [first, second], true).missingRanges;
  assert.equal(source.raw.slice(range.sourceStart, range.sourceEnd), ' footnote ');
  assert.equal(range.resolved, true);
  assert.ok(!reviewCandidates(source, { fonts: false, edits: true, text: true, targets: [target] }).some(item => item.missing));

  const numbered = new api.PdfConnections(locator, 'Alpha 12 Beta');
  const numberedTarget = new api.PdfConnections(locator,
    { raw: 'Alpha\n12 Beta', sourcePages: [1, 2], parts: [{ start: 0, end: 13 }] });
  const numberedFirst = numbered.remember(0, 5, numberedTarget, { start: 0, end: 5 });
  const numberedSecond = numbered.remember(numbered.raw.indexOf('Beta'), numbered.raw.length, numberedTarget,
    { start: 9, end: 13 });
  numbered.connections.set(numberedTarget, { prepared: true, scope: { start: 0, end: numbered.raw.length },
    ranges: [numberedFirst, numberedSecond], preparedRanges: [numberedFirst, numberedSecond] });
  numbered.prepared = { pdf: {}, full: numberedTarget, pages: [numberedTarget],
    pairs: [numberedFirst, numberedSecond], connections: [[numberedFirst, numberedSecond]],
    fonts: [{ parts: numberedTarget.parts, pages: numberedTarget.pages, fontVersion: numberedTarget.fontVersion }] };
  assert.ok(!reviewCandidates(numbered, { fonts: false, edits: true, text: true, targets: [numberedTarget] }).some(item => item.missing));

  const hidden = new api.PdfConnections(locator, 'Alpha omitted Beta');
  const missingFirst = hidden.remember(0, 5, target, { start: 0, end: 5 });
  const missingSecond = hidden.remember(hidden.raw.indexOf('Beta'), hidden.raw.length, target,
    { start: targetAt, end: raw.length });
  hidden.connections.set(target, { prepared: true, scope: { start: 0, end: hidden.raw.length },
    ranges: [missingFirst, missingSecond], preparedRanges: [missingFirst, missingSecond] });
  hidden.prepared = { pdf: {}, full: target, pages: [target], pairs: [missingFirst, missingSecond],
    connections: [[missingFirst, missingSecond]], fonts: [{ parts: target.parts, pages: target.pages, fontVersion: target.fontVersion }] };
  assert.ok(reviewCandidates(hidden, { fonts: false, edits: true, text: true, targets: [target] }).some(item => item.missing
    && item.comparison.html.includes('omitted')));
});

test('numeric-only footnote changes align digit ranges without hiding their values', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, '4 Eigentum ist Diebstahl\n5 Großkordon');
  const target = new api.PdfConnections(locator,
    { raw: 'Eigentum ist Diebstahl - 2 Großkordon', sourcePages: [1], parts: [{ start: 0, end: 38 }] });
  const connection = { start: 0, end: source.raw.length, targetStart: 0, targetEnd: target.raw.length, target };
  connection.editorDiff = { reliable: true, parts: connectionParts(api, [
    ['4 ', ''], ['Eigentum ist Diebstahl', 'Eigentum ist Diebstahl'], ['\n5', ' - 2'], [' Großkordon', ' Großkordon']
  ]) };
  source.connections.set(target, { prepared: true, scope: { start: 0, end: source.raw.length },
    ranges: [connection], preparedRanges: [connection] });
  source.prepared = { pdf: {}, full: target, pages: [target], pairs: [connection],
    connections: [[connection]], fonts: [{ parts: target.parts, pages: target.pages, fontVersion: target.fontVersion }] };
  const item = reviewCandidates(source, { fonts: false, edits: true, text: true, targets: [target] }).find(value => value.comparison.html === '5');
  assert.deepEqual([item.sourceStart, item.sourceEnd, item.comparison.pdf], [25, 26, '2']);
  assert.equal(item.options[0].edits[0].text, '2');
});
