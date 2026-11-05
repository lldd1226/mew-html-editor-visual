import { DocumentModel as FixtureDocument } from './support/pdf-harness.mjs';
import { sourceDecorations } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { engine } from './support/pdf-harness.mjs';

const page = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32-018.json', import.meta.url), 'utf8'));
for (const newline of ['\r\n', '\n']) test(`ME32-018 wrapped compound shares the page and selection diff (${JSON.stringify(newline)})`, () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, page.source.replace(/\r?\n/g, newline));
  const target = new api.PdfConnections(locator, { raw: page.raw, sourcePages: page.physical, parts: [] });
  index.update([target]);
  const start = index.raw.indexOf('Prokesch-Osten'), end = start + 'Prokesch-Osten'.length;
  assert.ok(start >= 0);
  const pairs = [target].filter(Boolean).flatMap(target => index.connections.get(target)?.preparedRanges || index.connections.get(target)?.ranges || []);
  const connection = pairs.find(([c]) => c.start <= start && c.end >= end)[0];
  const diff = index.compare(target, connection);
  assert.equal(diff.parts.map(part => part.html).join(''), index.raw.slice(connection.start, connection.end));
  assert.equal(diff.parts.map(part => part.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
  assert.deepEqual(diff.parts, api.textDiff(index.raw.slice(connection.start, connection.end),
    target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true).parts);
  assert.ok(!index.candidates(null, false, true, true, [target]).some(item => item.sourceStart <= end && item.sourceEnd >= start),
    'line wrapping cannot delete kesch or insert a second kesch-');
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  for (const { range } of sourceDecorations(index, index.candidates(null, false, false, true, [], pairs), false, true, undefined, documentModel)) {
    assert.ok(range.endColumn - 1 <= index.starts[start] || range.startColumn - 1 >= index.ends[end - 1]);
  }
  for (const [a, b, pdf] of [[start, end, 'Pro-\nkesch-Osten'], [start + 3, end, 'kesch-Osten'], [start + 3, start + 8, 'kesch']]) {
    const hit = index.range(target, a, b);
    assert.ok(hit);
    assert.equal(target.raw.slice(hit.start, hit.end), pdf);
    const reverse = index.range(target, hit.start, hit.end, true);
    assert.equal(reverse.start, a);
    assert.equal(reverse.end, b);
  }
  assert.ok(!api.comparisonParts({ html: 'Prokesch-Osten', pdf: 'Pro-\nkesch-Osten' }).some(part => part.changed));
  assert.ok(api.comparisonParts({ html: 'Prokesch-Osten', pdf: 'Pro-\nkesdi-Osten' }).some(part => part.changed),
    'an actual OCR error remains reviewable inside a wrapped compound');
});

for (const number of [188, 198]) for (const newline of ['\r\n', '\n'])
  test(`ME32-${number} punctuation cannot split a hyphenated word (${JSON.stringify(newline)})`, async () => {
    const page = JSON.parse(await readFile(new URL(`./fixtures/pdf-selection-me32-${number}.json`, import.meta.url), 'utf8'));
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = new api.PdfConnections(locator, page.source.replace(/\r?\n/g, newline));
    const target = new api.PdfConnections(locator, { raw: page.raw, sourcePages: page.physical, parts: [] });
    index.update([target]);
    const word = number === 188 ? 'hineinzuziehen' : 'Revolutions-Agitations-';
    const pdf = number === 188 ? 'hin-,\neinzuziehen' : 'Revolutions-\nAgitations-';
    const start = index.raw.indexOf(word), end = start + word.length;
    assert.ok(start >= 0);
    const hit = index.range(target, start, end);
    assert.ok(hit);
    assert.equal(target.raw.slice(hit.start, hit.end), pdf);
    const reverse = index.range(target, hit.start, hit.end, true);
    assert.equal(reverse.start, start);
    assert.equal(reverse.end, end);
    const items = index.candidates(null, false, true, true, [target]).filter(item => item.sourceStart < end && item.sourceEnd >= start);
    if (number === 198) assert.equal(items.length, 0, 'a line-wrapped compound has no false deletion or insertion');
    else {
      assert.equal(items.length, 1);
      assert.equal(items[0].sourceStart, start + 3);
      assert.equal(items[0].sourceEnd, start + 3);
      assert.equal(items[0].comparison.html, '');
      assert.equal(api.significantText(items[0].comparison.pdf), ',', 'only the extra OCR comma is reviewable');
      const preview = new api.PdfConnections(locator, api.applyTextEdits(index.source, items[0].options[0].edits)).raw;
      assert.equal(preview.replace(/[^\p{L}\p{N}]/gu, ''), index.raw.replace(/[^\p{L}\p{N}]/gu, ''),
        'reviewing the comma cannot delete or duplicate the word');
      const typo = index.raw.indexOf('trokkener') + 4;
      assert.ok(index.candidates(null, false, true, true, [target]).some(item => item.sourceStart === typo && item.sourceEnd === typo + 1
        && item.comparison.html === 'k' && api.significantText(item.comparison.pdf) === '^'),
        'a real OCR error next to a line-break hyphen remains visible');
    }
    const connection = [target].filter(Boolean).flatMap(target => index.connections.get(target)?.preparedRanges || index.connections.get(target)?.ranges || []).find(([c]) => c.start <= start && c.end >= end)[0];
    const diff = index.compare(target, connection);
    assert.equal(diff.parts.map(part => part.html).join(''), index.raw.slice(connection.start, connection.end));
    assert.equal(diff.parts.map(part => part.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
    const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
    for (const { range } of sourceDecorations(index, index.candidates(null, false, false, true, [], [[connection, target]]), false, true, undefined, documentModel)) {
      if (range.startColumn - 1 < index.ends[end - 1] && range.endColumn - 1 > index.starts[start])
        assert.equal(range.startColumn, range.endColumn, 'unchanged letters cannot receive a difference highlight');
    }
  });

for (const hyphen of ['-', '\u2010', '\u2011']) test(`wrapped compounds retain alignment with ${JSON.stringify(hyphen)}`, () => {
  const api = engine();
  for (const [html, pdf] of [
    [`Revolutions${hyphen}Agitations${hyphen}`, `Revolutions${hyphen}\nAgitations${hyphen}`],
    ['hineinzuziehen, ohne', `hin${hyphen},\neinzuziehen, ohne`]
  ]) {
    const diff = api.textDiff(html, pdf, true, Infinity, true);
    assert.equal(diff.parts.map(part => part.html).join(''), html);
    assert.equal(diff.parts.map(part => part.pdf).join(''), pdf);
    assert.ok(diff.parts.filter(part => part.changed).every(part => !/[\p{L}\p{N}]/u.test(part.html + part.pdf)),
      'line-break punctuation cannot masquerade as changed letters');
  }
});
