import { reviewCandidates } from './support/pdf-harness.mjs';
import { PdfConnections as FixtureConnections } from './support/pdf-harness.mjs';
import { DocumentModel as FixtureDocument } from './support/pdf-harness.mjs';
import { sourceDecorations } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { engine, locator as selectionLocator } from './support/pdf-harness.mjs';

const pages = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32-noise.json', import.meta.url), 'utf8'));

test('ME32-323 highlights both ends of a relocated footnote, while tolerating an OCR omission', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32-323.json', import.meta.url), 'utf8'));
  for (const relocated of [true, false]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = new api.PdfConnections(locator, fixture.source);
    const target = new api.PdfConnections(locator, { raw: relocated ? fixture.raw : fixture.raw.replace('etc.1,', 'etc.,'),
      sourcePages: fixture.physical, parts: [] });
    index.connect([target]);
    const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    const at = index.raw.indexOf('etc.1)') + 4;
    assert.ok(at > 4);
    const deletion = items.find(item => item.sourceStart === at && item.sourceEnd === at + 1);
    assert.equal(!!deletion, relocated);
    if (relocated) {
      assert.deepEqual(JSON.parse(JSON.stringify(deletion.comparison)), { html: '1', pdf: '' });
      const hit = index.range(target, at, at + 1);
      assert.ok(hit && hit.start === hit.end, 'the deletion has a PDF caret');
      assert.ok(target.raw.slice(0, hit.start).endsWith('Varlin etc.'), 'the caret belongs to the first etc.');
      const insertion = items.find(item => item.comparison?.html === '' && item.comparison.pdf === '1');
      assert.ok(insertion && index.raw.slice(0, insertion.sourceStart).endsWith('Kiosques etc.'),
        'the insertion belongs to the second etc.');
    }
  }
});

const reordered = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32-496.json', import.meta.url), 'utf8'));
test('ME32-496 reuses rejected cross-page gaps until a confirmed neighbour changes', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, reordered.source);
  const target = new api.PdfConnections(locator, { raw: reordered.raw.slice(reordered.pages[0].start, reordered.pages[0].end),
    layer: {}, parts: [] });
  index.connect([target]);
  const remember = index.remember, failures = [];
  index.remember = function (start, end, page, hit, ...rest) {
    const result = remember.call(this, start, end, page, hit, ...rest);
    if (!result) failures.push([start, end, hit.start, hit.end]);
    return result;
  };
  const forward = index.range(target, 0, index.raw.length);
  const reverse = index.range(target, 0, target.raw.length, true);
  const first = failures.length;
  assert.ok(first > 0, 'the reordered pages contain a rejected gap');
  for (let repeat = 0; repeat < 10; repeat++) {
    assert.deepEqual(index.range(target, 0, index.raw.length), forward);
    assert.deepEqual(index.range(target, 0, target.raw.length, true), reverse);
  }
  assert.equal(failures.length, first, 'forward and reverse lookups do not retry rejected gaps');
  const state = index.connections.get(target);
  state.ranges = state.ranges.map(connection =>
    Object.defineProperty({ ...connection, gap: undefined }, 'target', { value: target }));
  assert.deepEqual(index.range(target, 0, index.raw.length), forward);
  assert.ok(failures.length > first, 'replaced neighbours trigger fresh comparisons');
});

for (const newline of ['\r\n', '\n']) test(`ME32-496 prepares footnotes reordered across PDF pages (${JSON.stringify(newline)})`, () => {
  for (const separator of ['-', '–', '—']) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = new api.PdfConnections(locator, reordered.source.replace(/\r?\n/g, newline));
    const target = new api.PdfConnections(locator, { raw: reordered.raw.replace(/ - /g, ` ${separator} `),
      sourcePages: reordered.physical, pages: reordered.pages, parts: [] });
    index.connect([target]);
    const pairs = [target].filter(Boolean).flatMap(target => index.connections.get(target)?.preparedRanges || index.connections.get(target)?.ranges || []);
    const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target], connections: pairs });
    let previous = 0;
    for (const text of ['vorerst', 'Vereinigtem Königreich', 'englischen Gesetze über Beweisführung']) {
      const start = index.raw.indexOf(text), end = start + text.length;
      assert.ok(start >= 0);
      assert.ok(!items.some(item => item.sourceStart < end && item.sourceEnd > start), `${separator}: ${text} has no false text difference`);
      const hit = index.range(target, start, end);
      assert.ok(hit, `${text} maps before selection`);
      assert.equal(target.raw.slice(hit.start, hit.end), text);
      assert.ok(hit.start >= previous && hit.end <= reordered.pages[0].end, 'footnotes retain their order on PDF page 524');
      previous = hit.end;
      const reverse = index.range(target, hit.start, hit.end, true);
      assert.ok(reverse && reverse.start <= start && reverse.end >= end);
    }
    assert.ok(items.some(item => item.comparison.html === 'su' && item.comparison.pdf === 'ni'),
      'the OCR error in versuchte/vernichte remains reported');
    assert.equal(JSON.stringify(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target], connections: pairs })), JSON.stringify(items),
      'selection lookups do not change the prepared review');
    api.validateEdits(index.source, items.flatMap(item => item.options[0].edits));
  }
});

test('ME32-524 partial selections cannot suppress cross-page group recovery', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32-524.json', import.meta.url), 'utf8'));
  for (const word of ['', 'Beste Grüße an Euch alle.', 'Wir haben jetzt', 'Eideshelfer', 'Kugelmann']) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = new api.PdfConnections(locator, fixture.source);
    const target = new api.PdfConnections(locator, { raw: fixture.raw, sourcePages: fixture.physical, pages: fixture.pages, parts: [] });
    locator.getDocumentIndex = () => target;
    const start = index.raw.indexOf(word), at = target.raw.indexOf(word);
    if (word) assert.ok(index.remember(start, start + word.length, target, { start: at, end: at + word.length }));
    index.connect([target]);
    const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    for (const text of ['8 S. G. ', 'sie 7 Eideshelfer', 'Will oder kann sie das nicht', 'Beste Grüße an Euch alle.']) {
      const from = index.raw.indexOf(text), end = from + text.length;
      assert.ok(from >= 0);
      assert.ok(!items.some(item => item.missing && item.sourceStart < end && item.sourceEnd > from), `${word}: ${text} is present in the OCR`);
    }
    const initials = index.raw.indexOf('8 S. G. ');
    const hit = index.range(target, initials, initials + 8);
    assert.ok(hit, 'initials map before selection');
    assert.equal(target.raw.slice(hit.start, hit.end).trim(), '8 S. G,');
    assert.deepEqual(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }), items,
      'selection lookup does not change the prepared review');
    assert.ok(items.some(item => item.missing && item.comparison.html.includes('F. E.')),
      'the signature absent from OCR must still be reported');
  }
});

test('ME32-099 prepares both bounded PDF pages without reusing an incomplete reverse scope', async () => {
  const page = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32-099.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, page.source);
  const target = new api.PdfConnections(locator, { raw: page.raw, sourcePages: page.physical, parts: [] });
  locator.getDocumentIndex = () => target;
  index.connect([target]);
  const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
  for (const [html, pdf] of [['in Manchester', 'in Manchester'], ['– wirklich gekostet haben.“', 'r wirklich gekostet haben*']]) {
    const start = index.raw.indexOf(html), end = start + html.length;
    const hit = index.range(target, start, end);
    assert.ok(hit, `${html} maps before the second page renders`);
    assert.equal(target.raw.slice(hit.start, hit.end), pdf);
    const reverse = index.range(target, hit.start, hit.end, true);
    assert.ok(reverse && reverse.start <= start && reverse.end >= end);
    assert.ok(!items.some(item => item.missing && item.sourceStart < end && item.sourceEnd > start));
  }
  assert.ok(items.some(item => item.missing && item.comparison.html.includes('K.M.')),
    'the signature absent from the OCR remains unresolved');
});

test('ME32-099 missing signatures cannot highlight the entire following PDF page', async () => {
  const page = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32-099.json', import.meta.url), 'utf8'));
  const pdf = {}, locator = selectionLocator({}, { getPdf: () => pdf, getSourcePages: () => page.physical });
  const index = new FixtureConnections(locator, page.source), Index = index.constructor;
  const seam = page.raw.indexOf('100 52');
  const pages = [
    { number: page.physical[0], start: 0, end: seam, parts: [{ start: 0, end: seam }] },
    { number: page.physical[1], start: seam, end: page.raw.length, parts: [{ start: seam, end: page.raw.length }] }
  ];
  const target = new Index(locator, { raw: page.raw, pdf, sourcePages: page.physical, pages });
  const layer = new Index(locator, { raw: page.raw.slice(seam), pdf,
    layer: { closest: () => ({ dataset: { pageNumber: String(page.physical[1]) } }) }, parts: [] });
  locator.getDocumentIndex = () => target;
  locator.environment.getTargets = () => [target, layer];
  locator.environment.getVisiblePages = () => [{ number: 125, index: layer }];
  index.connect([target, layer], pdf);
  for (const text of ['Moore zeichnete.', 'Dein\nK.M.']) {
    const start = index.raw.indexOf(text), end = start + text.length;
    const [location] = locator.findLocations(pdf, [index.entry(start, end, true)], true);
    assert.ok(location.notice?.missing, 'the missing-OCR reminder remains available');
    assert.equal(location.targets.length, 1, 'the missing signature has one caret');
    assert.equal(location.targets[0].pageNumber, page.physical[0], 'the caret stays on page 99');
    assert.equal(location.targets[0].range.start, location.targets[0].range.end);
  }
});

test('ME32-151 prepares the rendered footnotes before placing missing-letter carets', async () => {
  const page = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32-151.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, page.source);
  const layer = new api.PdfConnections(locator, { raw: page.raw, layer: { closest: () => null }, parts: [] });
  const target = new api.PdfConnections(locator, { raw: page.pdf, sourcePages: page.physical, parts: [] });
  index?.connect([layer, target]);
  const connections = index.targetConnections(layer);
  for (const [word, letter] of [['Führern', 'h'], ['Philipp', 'P']]) {
    const start = index.raw.indexOf(word) + word.indexOf(letter);
    const item = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [layer, target] }).find(item => item.sourceStart <= start && item.sourceEnd > start);
    assert.ok(item && item.comparison.html.includes(letter));
    const hit = index.range(layer, item.sourceStart, item.sourceEnd, false, undefined, true);
    assert.ok(hit, `${word} has a prepared rendered-layer mapping`);
    assert.equal(layer.raw.slice(hit.start, hit.end).trim(), '', `${word} uses a PDF caret`);
    assert.ok(connections.some(connection => connection.start <= item.sourceStart && connection.end >= item.sourceEnd));
  }
});
const passages = {
  144: [['Salut.', 'Salut.'], ['Dein', 'Dein'], ['K.M.', 'KM']],
  159: [['Sigismund Borkheim', 'Sigismund Borkheim'], ['Die unschuldige', 'Die unschuldige'],
    ['Isabella II.', 'Isabella IL-'], ['Napoleon III.', 'Napoleon III.'], ['erledigt', 'erle ig']],
  162: [['Dein', 'Dein'], ['Leiden', 'Leiden']]
};

for (const page of pages) for (const newline of ['\r\n', '\n'])
  test(`ME32-${page.number} recovers surviving OCR beside show-through noise (${JSON.stringify(newline)})`, () => {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const source = page.source.replace(/\r?\n/g, newline), index = new api.PdfConnections(locator, source);
    const target = new api.PdfConnections(locator, { raw: page.raw, sourcePages: page.physical, parts: [] });
    index?.connect([target]);
    const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    const documentModel = new FixtureDocument({ model: {
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }),
      getOffsetAt: ({ column }) => column - 1
    } });
    const marks = JSON.stringify(sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [target].filter(Boolean).flatMap(target => index.connections.get(target)?.preparedRanges || index.connections.get(target)?.ranges || []) }), true, true, undefined, documentModel));
    let previous = 0;
    for (const [html, pdf] of passages[page.number]) {
      const start = index.raw.indexOf(html), end = start + html.length;
      assert.ok(start >= 0);
      assert.ok(!items.some(item => item.missing && item.sourceStart < end && item.sourceEnd > start), html);
      const hit = index.range(target, start, end);
      assert.ok(hit, `${html} must have a prepared mapping`);
      assert.equal(target.raw.slice(hit.start, hit.end).trim(), pdf);
      assert.ok(hit.start >= previous, 'recovered passages retain their PDF order');
      previous = hit.end;
      const reverse = index.range(target, hit.start, hit.end, true);
      assert.ok(reverse && reverse.start <= start && reverse.end >= end - 1, `${html} maps back through the same alignment`);
    }
    assert.equal(JSON.stringify(sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [target].filter(Boolean).flatMap(target => index.connections.get(target)?.preparedRanges || index.connections.get(target)?.ranges || []) }), true, true, undefined, documentModel)), marks);
    api.validateEdits(source, items.flatMap(item => item.options[0].edits));
    if (page.number === 162) {
      assert.ok(items.some(item => item.missing && item.comparison.html.includes('F. E.')),
        'the signature absent from the OCR stays unresolved');
      assert.ok(!items.some(item => item.comparison.pdf.includes('Leiden')),
        'the next footnote cannot consume the recovered Leiden text');
    } else assert.ok(items.every(item => !item.missing));
    if (page.number === 159) {
      const body = index.raw.indexOf('An Gaudissart');
      const hit = index.range(target, body, body + 2);
      assert.equal(hit.start, target.raw.indexOf('An Gaudissart'), 'the header an cannot replace the body An');
      const header = target.raw.indexOf('an Marx');
      assert.equal(index.range(target, header, header + 2, true), null,
        'short repeated header words cannot establish a recovered mapping');
    }
  });

const tiltedPages = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32-skew.json', import.meta.url), 'utf8'));
for (const page of tiltedPages) test(`ME32 PDF ${page.number} keeps superscripts on their tilted scan line`, async () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const target = await locator.indexDocument({ numPages: 1, getPage: async () => ({
    getTextContent: async () => ({ items: page.items })
  }) });
  const passages = {
    417: ['schönen Klemme.14451 Und jetzt wieder Amnestie in Italien.\nÜber die Debatten',
      'Irish Character“. Irland ist von der Vorsehung zu einem grazing land10\nbestimmt, der Prophet'],
    419: ['are the true and genuine offspring of that „policy of conquest“, by the fiery\ndenunciation',
      'from officeI450J;\nthat the General Council'],
    429: ['York, die sich zunächst jenseits der Binn[en]landseen, say in Michigan f.i.4\nniederließen']
  };
  for (const passage of passages[page.number]) assert.ok(target.raw.includes(passage), passage);
  for (const part of target.pages[0].parts) assert.equal(target.raw.slice(part.start, part.end), part.item.str,
    'sorting retains the original text item and its character range');
  const nodes = page.items.map(item => ({ item, box: { bottom: -api.textItemBaseline(item), height: item.height,
    left: item.transform[4] } })).sort((a, b) =>
    Math.round((a.box.bottom - b.box.bottom) / Math.max(a.box.height, b.box.height)) || a.box.left - b.box.left);
  assert.deepEqual(nodes.map(node => node.item.str), Array.from(target.pages[0].parts, part => part.item.str),
    'rendered-layer ordering agrees with document ordering');
});
