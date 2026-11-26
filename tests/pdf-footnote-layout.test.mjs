import assert from 'node:assert/strict';
import test from 'node:test';
import { engine } from './support/pdf-harness.mjs';

const api = engine();
const item = (str, x, baseline, height = 7.5, width = str.length * 4) => ({
  str, width, height, hasEOL: false, transform: [7.425, 0, 0, height, x, baseline]
});
const superscript = (str, x, baseline) => item(str, x, baseline, 4.875, 2.413125);
const space = (x, baseline, width = 3) => item(' ', x, baseline, 0, width);

test('a cross-page PDF selection uses the connection prepared for OCR review', async () => {
  const numbers = [1, 2];
  const text = ['Der erste Absatz endet mit diesem Satz.', 'Der nächste Absatz enthält einen Fehier.'];
  const pdf = { getPage: async number => ({
    getTextContent: async () => ({ items: [{ ...item(text[number - 1], 20, 120), hasEOL: true }] })
  }) };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf,
    getSourcePages: () => numbers, isCurrent: () => true, waitForIdle: async () => {} });
  const source = new api.PdfConnections(locator, text.join('\n').replace('Fehier', 'Fehler'));
  const full = await locator.indexDocument(pdf, numbers);
  const layers = full.pages.map(page => new api.PdfConnections(locator, {
    raw: full.raw.slice(page.start, page.end), layer: { closest: () => ({ dataset: { pageNumber: page.number } }) }
  }));
  const review = source.getDifferences(layers);
  assert.ok(review.items.some(item => item.comparison.html === 'l' && item.comparison.pdf === 'i' && !item.missing));
  const chunks = layers.map(index => ({ index, start: 0, end: index.raw.length }));
  const { hit, difference } = source.locateSource(chunks);
  assert.deepEqual([hit?.start, hit?.end], [0, source.raw.length]);
  assert.ok(review.connections.includes(hit.connection) && hit.connection.target === full);
  assert.match(difference.html, /Fehler/);
  assert.match(difference.pdf, /Fehier/);
});

for (const { name, items, expected } of [
  {
    name: 'ME04-472',
    items: [
      superscript('1', 109, 68.018), space(111, 68.018), item('(1848,1872,1883)', 114, 64.62),
      space(167, 64.62), item('eingefügt: denn -', 176, 64.62), space(231, 64.62),
      superscript('2', 234, 68.018), space(236, 68.018), item('(1848,1872,1883)', 239, 64.62),
      space(293, 64.62), item('bisherige Privatsicherheit', 303, 64.62)
    ],
    expected: '1 (1848,1872,1883) eingefügt: denn - 2 (1848,1872,1883) bisherige Privatsicherheit'
  },
  {
    name: 'ME04-474',
    items: [
      superscript('1', 109, 77.018), item('(1848, 1872)', 114, 73.62),
      item('weggezogen -', 163, 73.62), superscript('2', 208, 77.018),
      item('(1848, 1872)', 214, 73.62), item('ihre -', 259, 73.62),
      superscript('3', 281, 77.018), item('(1888)', 287, 73.62),
      item('sektiererischen -', 312, 73.62), superscript('4', 370, 77.018),
      item('(1848, 1872, 1883)', 375, 73.62), item('einerseits sie', 101, 63.36)
    ],
    expected: '1 (1848, 1872)weggezogen -2 (1848, 1872)ihre -3 (1888)sektiererischen -4 (1848, 1872, 1883)\neinerseits sie'
  },
  {
    name: 'ME04-475',
    items: [
      superscript('1', 36, 74.498), item('(1872,1883)', 39, 71.1),
      item('dem-', 85, 71.1), superscript('2', 100, 74.498),
      item('(1848,1872,1883)', 102, 71.1), item('eingefügt: die-', 175, 71.1),
      superscript('3', 221, 74.498), item('(1888)', 223, 71.1),
      item('Mehrheit-*(1888)', 257, 71.1), item('Minderheit', 24, 61.92)
    ],
    expected: '1(1872,1883)dem-2(1848,1872,1883)eingefügt: die-3(1888)Mehrheit-*(1888)\nMinderheit'
  }
]) test(`${name} keeps superscript note numbers inside their visual line`, async () => {
  const page = { getTextContent: async () => ({ items }) };
  const lines = (await api.readPageText(page)).raw.split('\n').map(line => line.replace(/\s+/g, ''));
  assert.deepEqual(lines, expected.split('\n').map(line => line.replace(/\s+/g, '')));
});

test('ME23 footnotes follow their text through page and layout breaks', async () => {
  const rows = [
    [
      ['Die Preise der Waren richten sich nach ihrer Arbeitszeit.50', 200, 9],
      ['52 Die Frage, warum das Geld nicht unmittelbar die Arbeitszeit selbst repräsentiert,', 170, 8],
      ['und warum Privatarbeit nicht unmittelbar gesellschaftlich sein kann, endet mit Schorn-', 159, 8],
      ['Gesundheitspohzeilichen Komitees', 135, 7],
    ],
    [
      ['Die Arbeiter in Kohlen- und anderen Bergwerken wohnen neben der Grube.', 202, 9],
      ['Sie arbeiten für den Pächter oder Eigentümer des Berg-', 189, 9],
      ['stein dient. Die Pocken wüten und haben schon verschiedne Todesfälle verursacht.', 178, 9],
      ['2. bis 4. Auflage: 14 704 000 - 2* siehe Band 13 unserer Ausgabe, S,58/59', 151, 7],
      ['v* kleine Sünde', 120, 7],
    ]
  ];
  const pages = rows.map(lines => ({
    getTextContent: async () => ({
      items: lines.map(([text, y, height]) => ({ ...item(text, 20, y, height), hasEOL: true }))
    })
  }));
  const numbers = [1, 2], pdf = { getPage: async n => pages[n - 1] };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getPdf: () => pdf, getSourcePages: () => numbers, isCurrent: () => true, waitForIdle: async () => {} });
  const source = new api.PdfConnections(locator, [
    '<p>Die Preise der Waren richten sich nach ihrer Arbeitszeit.(50)</p>',
    '<p>Die Arbeiter in Kohlen- und anderen Bergwerken wohnen neben der Grube. Sie arbeiten für den Pächter oder Eigentümer des Berg-</p>',
    '<aside><p>(50) Die Frage, warum das Geld nicht unmittelbar die Arbeitszeit selbst repräsentiert, und warum Privatarbeit nicht unmittelbar gesellschaftlich sein kann, endet mit Schornsteins dient. Die Pocken wüten und haben schon verschiedne Todesfälle verursacht.</p></aside>',
    '<aside><p>Gesundheitspolizeilichen Komitees</p><p>1* 2. bis 4. Auflage: 14 704 000</p><p>2* siehe Band 13 unserer Ausgabe, S.58/59</p>',
    '<p><a id="F2" href="#ZF2">(1*)</a> kleine Sünde</p></aside>'
  ].join('\n'));
  const layerText = await api.readPageText(pages[0]);
  const layer = new api.PdfConnections(locator, { ...layerText, layer: { closest: () => ({ dataset: { pageNumber: 1 } }) } });
  const remember = source.remember;
  source.remember = function (start, end, target, ...args) {
    const alignment = args.at(-1);
    assert.ok(!(target === layer && alignment?.recover && start === 0 && end === source.raw.length),
      'a layer ready before the document index must avoid whole-HTML recovery');
    return remember.call(this, start, end, target, ...args);
  };
  source.connect([layer]);
  const full = await locator.indexDocument(pdf, numbers);
  const { items } = source.getDifferences([layer]);
  const match = (html, expected, page) => {
    const start = source.raw.indexOf(html);
    const hit = source.range(full, start, start + html.length);
    assert.equal(hit && full.raw.slice(hit.start, hit.end), expected, html);
    assert.ok(hit.start >= full.pages[page].start && hit.end <= full.pages[page].end);
  };
  match('Die Frage, warum', 'Die Frage, warum', 0);
  match('Schorn', 'Schorn', 0);
  match('steins dient', 'stein dient', 1);
  match('des Berg-', 'des Berg-', 1);
  match('Gesundheitspolizeilichen Komitees', 'Gesundheitspohzeilichen Komitees', 0);
  match('14 704 000', '14 704 000', 1);
  match('S.58/59', 'S,58/59', 1);
  match('kleine Sünde', 'kleine Sünde', 1);
  const note = source.raw.indexOf('kleine Sünde');
  assert.ok(!items.some(item => item.missing && item.sourceStart < note + 12 && item.sourceEnd > note));
  const onSecondPage = await api.readPageText(pages[1]);
  const secondLayer = new api.PdfConnections(locator, { ...onSecondPage, layer: { closest: () => ({ dataset: { pageNumber: 2 } }) } });
  source.connect([layer, secondLayer]);
  const local = source.range(secondLayer, note, note + 12);
  assert.equal(secondLayer.raw.slice(local?.start, local?.end), 'kleine Sünde');
  assert.ok(!items.some(({ comparison }) => comparison.html === '-' && comparison.pdf.includes('stein')));
});

test('chapter HTML maps independent PDF passages without an aside and rejects ambiguous short text', async () => {
  const main = [
    'Der erste Absatz beschreibt den geschichtlichen Zusammenhang.',
    'Danach folgt eine ausführliche Darstellung der politischen Verhältnisse.',
    'Das letzte Beispiel schließt die zusammenhängende Darstellung ab.'
  ];
  const lines = [
    [main[0], 'v* Kleine Sünde', '** Gleicher Vermerk'],
    [main[1], '2* Gleicher Vermerk'],
    [main[2]]
  ];
  const numbers = [1, 2, 3], pdf = {
    getPage: async n => ({ getTextContent: async () => ({
      items: lines[n - 1].map((str, i) => ({ ...item(str, 20, 220 - i * 32), hasEOL: true }))
    }) })
  };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getPdf: () => pdf, getSourcePages: () => numbers, isCurrent: () => true, waitForIdle: async () => {} });
  const source = new api.PdfConnections(locator, '<section>' + [
    ...main, '(1*) Kleine Sünde', '(2*) Gleicher Vermerk', 'Ein vollständig fehlender Absatz.'
  ].map(line => `<p>${line}</p>`).join('') + '</section>');
  const full = await locator.indexDocument(pdf, numbers);
  const { items } = source.getDifferences();
  for (const [text, page] of [...main.map((line, i) => [line, i]), ['Kleine Sünde', 0]]) {
    const start = source.raw.indexOf(text);
    const hit = source.range(full, start, start + text.length);
    assert.ok(hit && hit.start >= full.pages[page].start && hit.end <= full.pages[page].end, text);
    assert.equal(full.raw.slice(hit.start, hit.end), text);
  }
  for (const text of ['Gleicher Vermerk', 'Ein vollständig fehlender Absatz.']) {
    const start = source.raw.indexOf(text);
    assert.ok(!source.range(full, start, start + text.length), text);
    assert.ok(items.some(item => item.missing && item.sourceStart <= start && item.sourceEnd >= start + text.length), text);
  }
});

for (const [markup, format] of [
  ['with note links', html => html],
  ['with paragraphs alone', html => html.replace(/<\/?(?:aside|a)\b[^>]*>/g, '')],
  ['with section and span tags', html => html.replace(/<\/?aside>/g, tag => tag.replace('aside', 'section'))
    .replace(/<(\/?)a\b[^>]*>/g, '<$1span>')]
]) test(`ME23-697 maps the last body line and an abbreviated footer note ${markup}`, () => {
  const api = engine(), pdf = {}, sourcePages = [699, 700];
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getPdf: () => pdf, getSourcePages: () => sourcePages });
  const body = 'Jetzt trat eine furchtbare Reaktion ein, die auch in andren Londoner Industrien';
  const continuation = 'Stunde, Ende März 1867, fortdauert. Zur Charakteristik der Lage der Arbeiter.';
  const longNote = 'Massenhafte Verhungerung der Londoner Armen während der letzten Tage.';
  const source = new api.PdfConnections(locator,
    `<p>${body}<sup><a href="#M136">(136)</a></sup> bis zur<a id="S698"></a> ${continuation}</p>
     ${format(`<aside><p><a id="M135" href="#ZM135">(135)</a> l. c. p. 16.</p>
     <p><a id="M136" href="#ZM136">(136)</a> ${longNote}</p>
     <p><a id="M140" href="#ZM140">(140)</a> l. c. p. 17.</p></aside>`)}`);
  const footer = '139 I.e. p.16.';
  const first = `${body}138 bis zur\n${footer}\n`;
  const page = first + '136 ' + longNote + '\n', raw = page + '\n' + continuation;
  const full = new api.PdfConnections(locator, { raw, sourcePages, pages: [
    { number: 699, start: 0, end: page.length, breaks: [first.length], parts: [] },
    { number: 700, start: page.length + 1, end: raw.length, breaks: [], parts: [] }
  ] });
  locator.documents.set(pdf, new Map([['pages:699,700', full]]));
  const { items } = source.getDifferences();
  for (const [html, target] of [['Industrien(136) bis zur', 'Industrien138 bis zur'], ['(135) l. c. p. 16.', footer]]) {
    const start = source.raw.indexOf(html), end = start + html.length, hit = source.range(full, start, end);
    assert.ok(hit && hit.end <= page.length, html);
    assert.equal(raw.slice(hit.start, hit.end), target);
    assert.ok(!items.some(item => item.missing && item.sourceStart < end && item.sourceEnd > start), html);
  }
  for (const [html, pdf] of [['l', 'I'], ['c', 'e']])
    assert.ok(items.some(({ comparison, missing }) => comparison.html === html && comparison.pdf === pdf && !missing));
  assert.ok(items.some(({ comparison, missing }) => missing && comparison.html.includes('l. c. p. 17.')));
});

test('ME04-483 matches both notes in one PDF footer by their complete bodies', async () => {
  const body = [
    'Wie der Pfaffe immer Hand in Hand ging mit dem Feudalen, so der pfäffische Sozialismus mit dem feudalistischen.',
    'Nichts leichter, als dem christlichen Asketismus einen sozialistischen Anstrich zu geben.'
  ];
  for (const [first, second] of [['1', '2'], ['‡', 'Q?']]) {
    const rows = [[body[0]], [body[1], `${first} (1848) ihre - ${second}`, '  (1848) heilige']];
    const numbers = [483, 484], pdf = { getPage: async number => ({
      getTextContent: async () => ({ items: rows[numbers.indexOf(number)].map((str, i) => ({
        ...item(str, 20, [120, 75, 65][i]), hasEOL: true
      })) })
    }) };
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
      getPdf: () => pdf, getSourcePages: () => numbers, isCurrent: () => true, waitForIdle: async () => {} });
    const source = new api.PdfConnections(locator, body.map(text => `<p>${text}</p>`).join('') +
      '<aside><p><a href="#ZF3">3</a> (1848) ihre</p><p><a href="#ZF4">4</a> (1848) heilige</p></aside>');
    const full = await locator.indexDocument(pdf, numbers), { items } = source.getDifferences();
    for (const text of ['(1848) ihre', '(1848) heilige']) {
      const start = source.raw.indexOf(text), end = start + text.length;
      const hit = source.range(full, start, end);
      assert.ok(hit && hit.start >= full.pages[1].start, text);
      assert.equal(full.raw.slice(hit.start, hit.end), text);
      const reverse = source.range(full, hit.start, hit.end, true);
      assert.deepEqual([reverse?.start, reverse?.end], [start, end]);
      assert.ok(!items.some(item => item.missing && item.sourceStart < end && item.sourceEnd > start), text);
    }
  }
});


