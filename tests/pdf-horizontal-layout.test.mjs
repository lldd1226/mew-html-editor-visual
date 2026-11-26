import assert from 'node:assert/strict';
import test from 'node:test';
import { engine } from './support/pdf-harness.mjs';

for (const rows of [1, 2]) test(`${rows}-line horizontal passages align to HTML in a different order without table markup`, async () => {
  const api = engine();
  const passages = [
    ['Links steht der erste Absatz.', 'Er setzt sich auf dieser Zeile fort.'],
    ['Die zweite Spalte beginnt hier.', 'Sie enthält eine eigene Erläuterung.'],
    ['Der dritte Abschnitt beschreibt das Beispiel.', 'Hier endet die dritte Erläuterung.'],
    ['Ganz rechts steht die letzte Bemerkung.', 'Sie ergänzt den vorherigen Abschnitt.']
  ].map(lines => lines.slice(0, rows));
  const header = 'Die Einleitung steht über der gesamten Breite.';
  const footer = 'Nach den nebeneinanderstehenden Absätzen folgt der Schluss.';
  const item = (str, x, y, width = str.length * 3) => ({
    str, width, height: 8, hasEOL: true, transform: [8, 0, 0, 8, x, y]
  });
  const items = [item(header, 10, 124, 755),
    ...passages[0].flatMap((_, i) => passages.map((lines, column) => item(lines[i], 10 + column * 200, 102 - i * 12))),
    item(footer, 10, 65, 755)];
  const page = { getTextContent: async () => ({ items }) };
  const pdf = { getPage: async () => page }, numbers = [1];
  const locator = new api.PdfLocator({}, {
    document: { createElement: () => ({}) }, getPdf: () => pdf, getSourcePages: () => numbers,
    isCurrent: () => true, waitForIdle: async () => {}
  });
  const source = new api.PdfConnections(locator, [header, ...[2, 0, 3, 1].map(i => passages[i].join(' ')), footer]
    .map(text => `<section><p>${text}</p></section>`).join(''));
  const ordinary = await api.readPageText(page);
  assert.equal(ordinary.horizontal, false);
  const ordinaryLocator = new api.PdfLocator({}, locator.environment);
  const ordinarySource = new api.PdfConnections(ordinaryLocator, `<p>${ordinary.raw}</p>`);
  const ordinaryIndex = await ordinaryLocator.indexDocument(pdf, numbers, ordinarySource);
  assert.equal(ordinaryIndex.pages[0].horizontal, false);

  const full = await locator.indexDocument(pdf, numbers, source);
  const content = locator.columnText(pdf, 1);
  assert.equal(content?.horizontal, true);
  const layer = new api.PdfConnections(locator, { ...content, layer: { closest: () => ({ dataset: { pageNumber: 1 } }) } });
  const verify = target => {
    for (const text of [header, ...passages.map(lines => lines.join(' ')), footer]) {
      const start = source.raw.indexOf(text), end = start + text.length;
      const hit = source.range(target, start, end);
      assert.ok(hit, text);
      assert.equal(target.raw.slice(hit.start, hit.end).replace(/\s+/gu, ' ').trim(), text);
      const reverse = source.range(target, hit.start, hit.end, true);
      assert.deepEqual([reverse?.start, reverse?.end], [start, end], text);
    }
  };
  source.getDifferences([layer]);
  verify(layer);
  const { items: differences } = source.getDifferences([layer]);
  verify(full);
  assert.ok(!differences.some(item => item.missing));
});

test('a repeated horizontal anchor needs unique context within its passage', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const repeated = 'gleicher ausdruck', passage = `im ersten absatz steht ein ${repeated} zur erläuterung des begriffs.`;
  const source = new api.PdfConnections(locator, `<p>${passage}</p><p>im zweiten absatz dient ein ${repeated} dem vergleich.</p>`);
  const page = new api.PdfConnections(locator, { raw: passage });
  const options = { sample: repeated.length, step: 1, anchors: true, page, blocks: [0, page.raw.length] };
  const at = passage.indexOf(repeated);
  assert.ok(!source.matches([page.normalized.text], source.normalized, options).some(hit => hit.at === at));
  const anchors = source.matches([page.normalized.text], source.normalized, { ...options, contextual: true });
  assert.equal(anchors.find(hit => hit.at === at)?.start, source.normalized.text.indexOf(repeated));
  const duplicate = new api.PdfConnections(locator, `<p>${passage}</p><p>${passage}</p>`);
  assert.ok(!duplicate.matches([page.normalized.text], duplicate.normalized, { ...options, contextual: true })
    .some(hit => hit.at === at));
});

test('ME04-158 maps a short label with one OCR typo and a repeated suffix', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const heading = '§ 3. Konkurrenz und Monopol';
  const htmlLabel = 'Gute Seite\nder Konkurrenz', pdfLabel = 'Guts Seite\nder Konkurrenz';
  const otherLabel = 'Schlechte Seite\nder Konkurrenz';
  const quote = '„Die Konkurrenz gehört ebenso wesentlich zur Arbeit wie die Teilung.“';
  const raw = [heading, pdfLabel, otherLabel, quote].join('\n');
  const breaks = [pdfLabel, otherLabel, quote].map(text => raw.indexOf(text));
  const source = new api.PdfConnections(locator, `<h3>${heading}</h3><table>
    <tr><td><i>Gute Seite<br>der Konkurrenz</i></td>
      <td>{</td><td>${quote}</td></tr>
    <tr><td><i>Schlechte Seite<br>der Konkurrenz</i></td></tr></table>`);
  const target = new api.PdfConnections(locator, { raw, breaks, horizontal: true, sourcePages: [178] });
  const { items } = source.getDifferences([target]);
  const start = source.raw.indexOf(htmlLabel), end = start + htmlLabel.length;
  const hit = source.range(target, start, end);
  assert.equal(raw.slice(hit?.start, hit?.end), pdfLabel);
  const reverse = source.range(target, hit.start, hit.end, true);
  assert.deepEqual([reverse?.start, reverse?.end], [start, end]);
  assert.deepEqual(Array.from(items.filter(item => item.sourceStart < end && item.sourceEnd > start),
    item => [item.comparison.html, item.comparison.pdf, !!item.missing]), [['e', 's', false]]);

  const ambiguous = new api.PdfConnections(locator, '<p>Gute Seite<br>der Konkurrenz</p><p>Guta Seite<br>der Konkurrenz</p> Schluss.');
  assert.equal(ambiguous.matches([target.normalized.text], ambiguous.normalized,
    { sample: 12, step: 8, anchors: true, page: target, blocks: [0, ...breaks, raw.length], contextual: true })
    .some(anchor => anchor.block === 1), false);
});
