import { reviewCandidates } from './support/pdf-harness.mjs';
import { DocumentModel as FixtureDocument } from './support/pdf-harness.mjs';
import { sourceDecorations } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { engineSource, source, engine, reviewProvider, connectionParts } from './support/pdf-harness.mjs';
const pdfApi = engine();

test('offset edit transactions are atomic data operations independent of an editor', () => {
  const api = engine(), edits = [{ start: 4, end: 5, text: 'Y', expected: 'e' }, { start: 1, end: 2, text: 'XX', expected: 'b' }];
  const snapshot = JSON.stringify(edits), result = api.applyEdits({ source: 'abcdef', edits });
  assert.equal(result.source, 'aXXcdYf');
  assert.equal(JSON.stringify(edits), snapshot);
  assert.equal(JSON.stringify(result.edits.map(edit => edit.start)), '[1,4]');
  assert.throws(() => api.applyEdits({ source: 'abcdef', edits: [{ start: 1, end: 2, text: 'x', expected: 'old' }] }), /原文已变化/);
  assert.throws(() => api.applyEdits({ source: 'abcdef', edits: [{ start: 1, end: 3, text: '' }, { start: 2, end: 4, text: '' }] }), /重叠/);
});

test('the update controller owns confirmed pairs while temporary selections use live connections', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, 'Alpha unique selected word beta.'), target = new api.PdfConnections(locator, index.raw);
  assert.equal(Object.getPrototypeOf(index).constructor, api.PdfConnections);
  index.connect([target]);
  const pairs = index.pairs, start = index.raw.indexOf('selected');
  assert.ok(Array.isArray(pairs));
  const selection = index.remember(start, start + 8, target, { start, end: start + 8 });
  assert.equal(index.pairs, pairs);
  assert.ok(index.livePairs.includes(selection));
  index.connect([target]);
  assert.ok(!index.pairs.includes(selection));
  assert.equal(index.range(target, start, start + 8).connection, selection);
});

test('bounded OCR recovery uses the shared word diff without requiring a global function', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, 'z'.repeat(200)), target = new api.PdfConnections(locator, 'w'.repeat(200));
  assert.equal(index.remember(0, 200, target, { start: 0, end: 200 }, { recover: true }), null);
});

test('connection models own source parsing and read shared document data without locator callbacks', () => {
  const api = engine(), pdf = {}, environment = { document: { createElement: () => ({}) }, getPdf: () => pdf, getSourcePages: () => [2] };
  const locator = new api.PdfLocator({}, environment), source = new api.PdfConnections(locator, '<p>Alpha <i>beta</i>.</p>');
  const target = new api.PdfConnections(locator, { raw: source.raw, sourcePages: [2] });
  locator.documents.set(pdf, new Map([['pages:2', target]]));
  locator.getDocumentIndex = () => { throw new Error('models must not call the provider'); };
  assert.equal(source.locator, undefined);
  assert.equal(source.connect([target]).full, target);
  assert.equal(source.formats[source.raw.indexOf('beta')].italic, true);
  Object.assign(locator.options, { wholeWords: true });
  assert.equal(source.options.wholeWords, true);
  assert.equal(source.matches(['pha']).length, 0);
});

test('indexed missing ranges preserve pairwise font overlap decisions at every boundary', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'a'.repeat(400));
  source.formats = source.formats.map(style => ({ ...style, tags: [] }));
  const fontItems = Array.from({ length: 120 }, (_, i) => ({ start: i * 3 + 1, end: i * 3 + 2, font: { italic: true, bold: false } }));
  const connection = new api.diffIndex(source.raw, source.raw);
  connection.editorDiff = { fontItems };
  source.compare = () => connection.editorDiff;
  let seed = 731;
  const next = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let round = 0; round < 100; round++) {
    const missing = Array.from({ length: 30 }, () => {
      const start = next() % 380;
      return { missing: true, sourceStart: start, sourceEnd: start + next() % 12 };
    });
    const expected = fontItems.filter(item => !missing.some(value => value.sourceStart < item.end && value.sourceEnd > item.start));
    const actual = reviewCandidates(source, { items: missing, fonts: ['italic'], edits: false, connections: [connection] }).filter(item => item.font);
    assert.deepEqual(actual.map(item => item.sourceStart), expected.map(item => item.start));
  }
});

test('connection updates match fresh diff parts and distances including repeated text and UTF-16 boundaries', () => {
  const api = engine();
  const passage = Array.from({ length: 20 }, (_, i) => `Passage ${i} provides a long unchanged anchor around wrong${i}. `).join('');
  const cases = [
    [passage, passage.replace(/wrong/g, 'right'), passage.replace('wrong2', 'right2')],
    [passage, passage.replace(/wrong/g, 'right'), passage.replace('wrong2', 'right2').replace('wrong3', 'right3')],
    ['aa ab aa', 'ab aa ab', 'aa aa ab'],
    ['one two one two', 'one one two two', 'one two two'],
    ['abc', 'aXbc', 'aXbc'], ['aXbc', 'abc', 'abc'],
    ['abc', 'abc', 'abXc'], ['abc', 'abc', 'abcd'], ['abc', 'abc', 'Xabc'],
    ['A 😀 B wrong C', 'A 😀 B right C', 'A 😎 B wrong C'],
    ['A 😀 B wrong C', 'A 😀 B right C', `A ${String.fromCodePoint(0x1fa00)} B wrong C`]
  ];
  for (const condense of [false, true]) for (const [before, pdf, after] of cases) {
    const locator = new api.PdfLocator(), original = new api.PdfConnections(locator, { raw: before }),
      current = new api.PdfConnections(locator, { raw: after }), target = new api.PdfConnections(locator, { raw: pdf });
    const hit = { start: 0, end: pdf.length }, right = { text: pdf };
    const previous = original.remember(0, before.length, target, hit, { left: { text: before }, right });
    previous.editorDiff = api.textDiff(before, pdf, true, Infinity, true);
    const snapshot = JSON.stringify(previous), change = api.changedRange(before, after);
    const connection = current.remember(0, after.length, target, hit, { previous, change, left: { text: after }, right });
    const result = condense ? connection.editorDiff : { distance: connection.distance, parts: connection.spans };
    assert.equal(result.parts.map(part => part.html).join(''), after);
    assert.equal(result.parts.map(part => part.pdf).join(''), pdf);
    assert.equal(JSON.stringify(previous), snapshot);
    const fresh = api.textDiff(after, pdf, true, Infinity, condense);
    assert.equal(result.distance, fresh.distance);
    assert.deepEqual(result.parts, fresh.parts);
  }
});

test('source updates retain edited connections and reuse their prepared scope', () => {
  const api = engine(), pdf = {};
  let value = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} has plenty of unchanged context for its independent comparison. wrong${i}. `).join('')
    + 'The closing paragraph provides a final unchanged anchor.', version = 1;
  const documentModel = new FixtureDocument({ model: { getValue: () => value, getVersionId: () => version } }), model = documentModel.model;
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf });
  const target = new api.PdfConnections(locator, value.replace(/wrong/g, 'right'));
  locator.getDocumentIndex = () => target;
  const previous = locator.editorSourceIndex(documentModel, [target]);
  previous.connect([target], pdf);
  const original = previous.byTarget.get(target), snapshots = original.map(item => JSON.stringify(item.editorDiff.parts));
  value = value.replace('wrong2', 'right2').replace('wrong3', 'right3'); version++; documentModel.update(documentModel.content);
  const current = locator.editorSourceIndex(documentModel, [target]);
  assert.equal(current.byTarget.get(target).length, original.length);
  current.matches = () => assert.fail('retained edited connections must keep their prepared scope');
  current.connect([target], pdf);
  const items = reviewCandidates(current, { fonts: false, edits: true, text: true, targets: [target] });
  assert.equal(api.applyTextEdits(value, items.flatMap(item => item.options[0].edits)), target.raw);
  original.forEach((item, i) => assert.equal(JSON.stringify(item.editorDiff.parts), snapshots[i]));
});

test('replacement returns shifted next entries before any full diff preparation', async () => {
  for (const mode of ['complete', 'interrupt', 'font']) {
    const interrupt = mode === 'interrupt', fonts = mode === 'font';
    const api = engine(), pdf = {}, timers = [];
    let value = Array.from({ length: 20 }, (_, i) => `${fonts ? `<i>Marker ${i}</i> ` : ''}Passage ${i} has enough unchanged context for its independent mapping. wrong${i}. `).join('')
      + 'The final unchanged paragraph anchors the end of the complete passage.', version = 1;
    const documentModel = new FixtureDocument({ model: { getValue: () => value, getVersionId: () => version,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
    const editor = { document: documentModel, getModel: () => model };
    const document = { createElement: () => ({}) };
    const locator = new api.PdfLocator({}, { document, getPdf: () => pdf });
    const target = new api.PdfConnections(locator, value.replace(/wrong/g, 'correct'));
    if (fonts) target.parts = [{ start: 0, end: target.raw.length, font: { italic: false, bold: false } }];
    locator.fontStyles = fonts ? ['italic'] : [];
    locator.getDocumentIndex = () => target;
    locator.indexDocument = async () => target;
    locator.indexFonts = async () => target;
    const providers = new Map();
    reviewProvider(api, providers, { locator, editor, viewer: { pdfDocument: pdf } }, document,
      { setTimeout: callback => { timers.push(callback); } });
    const initial = locator.editorSourceIndex(documentModel, [target]);
    initial.connect([target], pdf);
    const summarize = items => JSON.stringify(items.map(item => ({ id: item.id, start: item.sourceStart, end: item.sourceEnd, options: item.options })));
    const cached = locator.reviewItems(), snapshot = summarize(cached.items);
    const wordStart = initial.raw.indexOf('wrong2.');
    const item = fonts ? cached.items.find(item => item.font && item.text === 'Marker 2')
      : cached.items.find(item => !item.font && item.sourceStart >= wordStart && item.sourceStart < wordStart + 6
        && item.comparison.html.length !== item.comparison.pdf.length);
    assert.ok(item);
    const offset = initial.starts[item.sourceStart];
    value = api.applyTextEdits(value, item.options[0].edits); version++; documentModel.update(documentModel.content);
    let fullBuilds = 0, entries = 0, partial;
    const difference = Object.getOwnPropertyDescriptor(api.PdfConnections.prototype, 'differences');
    Object.defineProperty(api.PdfConnections.prototype, 'differences', { ...difference, get() { fullBuilds++; return difference.get.call(this); } });
    const sourceEntry = api.PdfConnections.prototype.entry;
    api.PdfConnections.prototype.entry = function (...args) { entries++; return sourceEntry.apply(this, args); };
    const result = locator.reviewItems({ editor, model, pdf, source: value, version, priority: { offset },
      onProgress: data => { partial = data; return new Promise(resolve => { timers.push(resolve); }); } });
    assert.equal(partial?.partial, true);
    assert.equal(partial.items.length, 5);
    assert.equal(fullBuilds, 0, 'the early return must precede the full differences getter');
    assert.equal(entries, 0, 'PDF anchors are reused without preparing the whole candidate list');
    assert.equal(timers.length, 1, 'full preparation waits for a paint opportunity');
    const review = providers.get('pdf-ocr'), state = { items: partial.items, item: partial.items[0], position: 0, context: { editor, model, documentModel: editor.document, snapshot: editor.document.snapshot, source: value, version } };
    assert.equal(locator.reviewLists.get(partial.items[0]).items.length, 1);
    assert.equal(review.content(state, partial.items[0]).all, false);
    assert.throws(() => review.apply(state, true), /完整差异队列/);
    for (const candidate of partial.items) for (const edit of candidate.options[0].edits)
      assert.equal(value.slice(edit.start, edit.end), edit.expected, 'shifted edits refer to the current source');
    if (interrupt) { value += ' New edit.'; version++; documentModel.update(documentModel.content); }
    timers.shift()();
    const full = await result;
    if (interrupt) {
      assert.equal(fullBuilds, 0, 'superseded work must not start the full build');
      assert.equal(full.items.length, 0);
    } else {
      assert.ok(fullBuilds > 0);
      assert.ok(full.items.length > partial.items.length);
      for (const candidate of partial.items) {
        const completed = full.items.find(item => item.id === candidate.id);
        assert.ok(completed);
        assert.equal(JSON.stringify(candidate.options[0].edits), JSON.stringify(completed.options[0].edits));
      }
    }
    assert.equal(summarize(cached.items), snapshot, 'the old queue remains unchanged');
  }
});

test('popup releases replacement on early results and keeps selection when the full queue arrives', async () => {
  for (const folder of ['public', 'mew-html-reader-vscode']) {
    const script = await readFile(new URL(`../${folder}/pdfdiff/replacement-review.js`, import.meta.url), 'utf8');
    const extract = (a, b) => script.slice(script.indexOf(a), script.indexOf(b, script.indexOf(a)));
    let source = 'updated source', version = 2, finish;
    const items = Array.from({ length: 8 }, (_, i) => ({ id: String(i), range: {
      startLineNumber: 1, startColumn: i + 1, endLineNumber: 1, endColumn: i + 2
    }, options: [{ id: 'pdf', edits: [] }] }));
    const documentModel = new FixtureDocument({ model: { getValue: () => source, getVersionId: () => version, getOffsetAt: position => position.column - 1 } }), model = documentModel.model;
    const editor = { document: documentModel, getModel: () => model };
    const saved = { context: { model, editor, documentModel, snapshot: documentModel.snapshot }, items: [], choices: new Map(), resumeOffset: 0,
      stale: true, manualPending: true, applying: true, provider: { locator: {
        reviewItems(context) {
          assert.ok(context.priority);
          context.onProgress({ items: items.slice(0, 5), partial: true });
          return new Promise(resolve => { finish = resolve; });
        }
      } } };
    const window = { saved, renders: 0, MewEditorCore: { DocumentModel: pdfApi.DocumentModel } };
    vm.runInNewContext(`let session = window.saved, generation = 0, composing = false, manualTimer;
      function render() { window.renders++; } function message() {}
      ${extract('  function validateCandidates(', folder === 'public' ? '  function updateMenu(' : '  function toggle(')}
      ${extract('  function refreshAfterEdit(', '  function controls(')}
      window.refresh = refreshAfterEdit;`, { window, document: { visibilityState: 'visible' },
      requestAnimationFrame: callback => callback(), setTimeout, clearTimeout });
    await window.refresh(saved, true);
    assert.equal(saved.partial, true);
    assert.equal(saved.refreshTask, null, 'replacement must stop waiting while the full result is pending');
    assert.equal(window.renders, 1);
    saved.position = 3;
    finish({ items });
    await new Promise(setImmediate);
    assert.equal(saved.partial, false);
    assert.equal(saved.items.length, 8);
    assert.equal(saved.position, 3, 'completion must preserve the item selected in the early queue');
    assert.equal(window.renders, 2);
    source = 'another replacement'; version++; documentModel.update(documentModel.content);
    saved.manualPending = saved.stale = true;
    await window.refresh(saved, true);
    const renders = window.renders;
    source = 'edited while the full queue was pending'; version++; documentModel.update(documentModel.content);
    finish({ items });
    await new Promise(setImmediate);
    assert.equal(saved.partial, true);
    assert.equal(window.renders, renders, 'a stale full result must not replace the early queue');
  }
});

test('page scope closes independently and reuses exact matches when preparing connections', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [raw, expected] of [['prefix Alpha omega suffix', true], ['Alpha omega and Alpha omega', false]]) {
    const index = new api.PdfConnections(locator, { raw }), page = new api.PdfConnections(locator, { raw: 'Alpha omega' });
    const matches = index.matches;
    let calls = 0;
    index.matches = function (...args) { calls++; return matches.apply(this, args); };
    index.search = () => assert.fail('page preparation must not enter selection lookup');
    assert.equal(!!index.connect(page), expected);
    assert.equal(calls, 1);
    assert.equal(!!index.connect(page), expected);
    assert.equal(calls, 1, 'preparation reuses both unique and ambiguous exact matches');
    assert.equal(!!index.byTarget.get(page)?.length, expected);
  }
});

test('page preparation shares its connection and normalized scope', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, '<p>Alpha wrong omega</p>');
  const target = new api.PdfConnections(locator, { raw: index.raw.replace('wrong', 'right'), layer: {} });
  const scope = index.connect(target);
  assert.equal(scope, index.byTarget.get(target)[0]);
  assert.equal(scope.normalized.text, api.normalized(index.raw).text);
  assert.equal(scope.normalized, index.normalized, 'full-source scope reuses the normalized index');
  assert.equal(index.connect(target), scope);
});

test('matching stages stop after a usable result and keep anchor uniqueness separate', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const text = 'Alpha starts here. Beta continues with a different sentence. Gamma supplies another unique passage. Delta closes the final paragraph.';
  const index = new api.PdfConnections(locator, { raw: text }), matches = index.matches, stages = [];
  index.matches = function (queries, haystack, options = {}, ...layout) {
    stages.push(typeof options === 'number' ? options : options.sample || (options.fuzzy ? 'fuzzy' : 'exact'));
    return matches.call(this, queries, haystack, options, ...layout);
  };
  assert.ok(!index.search({ text: 'Beta', before: '', after: '' }).approximate);
  const fuzzy = index.search({ text: 'Beto', before: 'Alpha starts here. ', after: ' continues with a different sentence.' });
  assert.equal(fuzzy.approximate, true, 'an exact miss advances to fuzzy matching');
  stages.length = 0;
  const page = new api.PdfConnections(locator, { raw: text.replace('Gamma', 'Gomma') });
  assert.ok(index.connect(page));
  assert.ok(stages.includes(24), 'page preparation samples overlapping anchors');
  assert.ok(!stages.includes(96), 'confirmed preparation skips fallback sampling');
  stages.length = 0;
  assert.equal(index.connect(new api.PdfConnections(locator, { raw: 'Z'.repeat(140) })), null);
  assert.deepEqual(stages.filter(stage => typeof stage === 'number'), [24], 'failed preparation has no separate coarse-scope pass');
  stages.length = 0;
  const absent = new api.PdfConnections(locator, { raw: 'Y'.repeat(140) });
  assert.equal(index.connect(absent), null);
  assert.equal(index.connect(absent), null);
  assert.deepEqual(stages.filter(stage => typeof stage === 'number'), [24], 'failed preparation is reused by the next lookup');
  const repeated = new api.PdfConnections(locator, { raw: 'Alpha '.repeat(20) });
  assert.equal(repeated.matches(['Alpha '.repeat(5)], repeated.normalized, { sample: 24, step: 8 }).length, 0,
    'repeated anchors cannot become unique by pooling their hits');
});

test('confirmed page anchors resolve repetitions without treating changed spans as exact anchors', () => {
  const api = engine(engineSource.replace('function* matchPositions(index, needle, { text }, anchors) {',
    '$& index.searches?.push(needle);'));
  const locator = new api.PdfLocator();
  const text = 'Alpha starts a unique passage. Beta continues with several different words. Gamma closes the final paragraph.';
  for (const changed of [false, true]) {
    const index = new api.PdfConnections(locator, { raw: text + '\n' + text });
    const page = new api.PdfConnections(locator, { raw: changed ? text.replace('starts', 'storts') : text });
    const offset = text.length + 1, searches = index.searches = [];
    index.remember(offset, offset + 64, page, { start: 0, end: 64 });
    const anchors = index.matches([page.normalized.text], index.normalized, { sample: 24, step: 8, page });
    assert.ok(anchors.length, 'confirmed context resolves anchors repeated elsewhere');
    assert.ok(anchors.every(anchor => index.normalized.starts[anchor.start] >= offset));
    assert.equal(searches.includes(page.normalized.text.slice(0, 24)), changed,
      'only unchanged mapped anchors bypass searching');
    assert.equal(anchors.some(anchor => anchor.at === 0), !changed,
      'a changed span cannot supply an exact anchor');
  }
});

test('review, styles and bidirectional selections reuse ranges at nonzero offsets', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const html = '<p>prefix Alpha <i>wrong</i> omega suffix</p>', index = new api.PdfConnections(locator, html);
  const raw = 'noise\nAlpha right omega\nrest';
  const target = new api.PdfConnections(locator, { raw, parts: [
    { start: 0, end: raw.length, font: { italic: false, bold: false } }
  ] });
  const start = index.raw.indexOf('Alpha'), end = index.raw.indexOf(' suffix');
  const connection = index.remember(start, end, target, { start: 6, end: raw.indexOf('\nrest') });
  const diff = index.compare(target, connection), ranges = diff.parts;
  Object.defineProperty(diff, 'parts', { get() { assert.fail('consumers must reuse the mapped ranges'); } });
  const pairs = [[connection, target]], items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target], connections: pairs });
  assert.equal(api.applyTextEdits(html, items.flatMap(item => item.options[0].edits)), html.replace('wrong', 'right'));
  const fonts = reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: pairs });
  assert.equal(fonts.length, 1);
  assert.equal(api.applyTextEdits(html, fonts[0].options[0].edits), html.replace('<i>wrong</i>', 'wrong'));
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  assert.ok(sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: pairs }), true, true, undefined, documentModel).length);
  for (const range of ranges) for (const key of ['html', 'pdf'])
    Object.defineProperty(range[4], key, { get() { assert.fail('selection must reuse prepared boundary checks'); } });
  const at = index.raw.indexOf('wrong'), hit = index.range(target, at, at + 5);
  assert.equal(raw.slice(hit.start, hit.end), 'right');
  const reverse = index.range(target, hit.start, hit.end, true);
  assert.equal(index.raw.slice(reverse.start, reverse.end), 'wrong');
  assert.equal(diff.ranges, ranges);
  assert.equal(connection.editorDiff, diff, 'selection projection reads the diff owned by the connection');
});

test('review candidate switches skip disabled text work and keep font styles independent', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, 'Alpha wrong Omega');
  const target = new api.PdfConnections(locator, { raw: 'Alpha right Omega', parts: [
    { start: 0, end: 17, font: { italic: true, bold: true } }
  ] });
  index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  index.connect([target]);
  const connections = index.pairs;
  assert.ok(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target], connections: connections }).some(item => item.comparison.pdf === 'right'));
  const comparisonIndex = api.comparisonIndex;
  api.comparisonIndex = () => assert.fail('a cold font-only build must not build the full cache');
  assert.equal(reviewCandidates(index, { fonts: ['bold'], edits: false, text: false, targets: [target], connections: connections }).length, 1);
  assert.equal(index.prepared.differences, undefined, 'filtered builds do not populate the full cache');
  api.comparisonIndex = comparisonIndex;
  const snapshot = JSON.stringify(index.getDifferences().items);
  api.comparisonIndex = () => assert.fail('font-only builds must skip text previews');
  index.textEdits = () => assert.fail('font-only builds must skip text edits');
  for (const fonts of [true, ['italic'], ['bold'], [], false]) {
    const items = reviewCandidates(index, { fonts: fonts, edits: false, text: false, targets: [target], connections: [...connections] });
    assert.ok(items.every(item => item.font && !item.options.length));
    assert.equal(items.length, fonts === false || Array.isArray(fonts) && !fonts.length ? 0 : 1);
    if (Array.isArray(fonts) && fonts.length === 1) assert.equal(items[0].font[fonts[0] === 'bold' ? 'italic' : 'bold'], null);
  }
  assert.equal(JSON.stringify(index.getDifferences().items), snapshot, 'filtered builds leave the shared collection unchanged');
});

test('shared differences refresh on replaced font data and published font versions', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, 'Alpha'), target = new api.PdfConnections(locator, { raw: 'Alpha', parts: [
    { start: 0, end: 5, font: { italic: false, bold: false } }
  ] });
  index.targets = [target];
  const original = index.getDifferences();
  assert.equal(original.items.filter(item => item.font).length, 0);
  target.parts = [{ start: 0, end: 5, font: { italic: false, bold: true } }];
  const refreshed = index.getDifferences();
  assert.notEqual(refreshed, original);
  assert.equal(refreshed.items.filter(item => item.font).length, 1);
  assert.equal(index.getDifferences(), refreshed, 'unchanged data keeps its shared results');
  target.parts[0].font.bold = false;
  target.fontVersion = 1;
  assert.equal(index.getDifferences().items.filter(item => item.font).length, 0);
});

test('ME08-432 joined derZuver retains der and maps the final sentence across anchor groups', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-432.json', import.meta.url), 'utf8'));
  for (const newline of ['\r\n', '\n']) for (const raw of [fixture.pdf, fixture.layerRaw]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const html = fixture.source.replace(/\r?\n/g, newline), index = new api.PdfConnections(locator, html);
    const target = new api.PdfConnections(locator, { raw, parts: [] });
    index?.connect([target]);
    const candidates = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    const der = index.raw.lastIndexOf('der Zuverlässigkeit');
    assert.ok(!candidates.some(c => c.sourceStart >= der && c.sourceStart <= der + 4 && c.comparison.pdf.trim() === 'der'),
      'the same der cannot be counted again in the following passage');
    const sentence = 'Beweise der Wahrheit und Beweise der Zuverlässigkeit!';
    const at = index.raw.indexOf(sentence);
    const hit = index.range(target, at, at + sentence.length, false, undefined, true);
    assert.ok(hit, 'one confirmed mapping must cover the sentence across the former seam');
    assert.equal(api.significantText(raw.slice(hit.start, hit.end)), 'BeweisederWahrhaftigkeitundBeweisederZuverlassigkeit!');
    assert.ok(hit.start > raw.lastIndexOf('Mitteilungen'), 'mapping stays in the last paragraph');
    const item = candidates.find(c => c.sourceStart >= at && c.sourceStart < der && c.comparison.pdf === 'aftigk');
    assert.ok(item, 'the actual Wahrheit/Wahrhaftigkeit difference remains reviewable');
    const inserted = index.range(target, item.sourceStart, item.sourceEnd, false, undefined, true);
    assert.equal(raw.slice(inserted.start, inserted.end), 'aftigk');
    assert.ok(inserted.start >= hit.start && inserted.end <= hit.end);
    assert.ok(api.applyTextEdits(html, item.options[0].edits).includes('Beweise der Wahrhaftigkeit und Beweise der'));
  }
});

test('ME08-412 OCR spacing preserves des and prepares the complete footnote dash difference', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-412.json', import.meta.url), 'utf8'));
  for (const newline of ['\r\n', '\n']) for (const space of [' ', '  ']) for (const dash of ['–', '—']) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const html = fixture.source.replace(/\r?\n/g, newline).replace('597–601', `597${dash}601`);
    const index = new api.PdfConnections(locator, html);
    const target = new api.PdfConnections(locator, { raw: fixture.pdf.replace('Gestalt des.', `Gestalt${space}des.`), parts: [] });
    index?.connect([target]);
    const candidates = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    const des = index.raw.indexOf('des deutschen'), missing = des + 4;
    const word = candidates.filter(c => c.sourceStart < missing + 9 && c.sourceEnd > des);
    assert.equal(word.length, 1);
    assert.equal(word[0].comparison.html.trim(), 'deutschen', 'matching des cannot be borrowed from deutschen');
    assert.ok(word[0].sourceStart >= des + 3);
    assert.match(api.applyTextEdits(html, word[0].options[0].edits), /Gestalt des\s*\.\s*Proletariats/);
    const at = index.raw.indexOf(`597${dash}601`) + 3;
    const item = candidates.find(c => c.sourceStart === at && c.sourceEnd === at + 1);
    assert.ok(item, 'dash is a replacement on first preparation, not a missing -601 insertion');
    assert.deepEqual({ ...item.comparison }, { html: dash, pdf: '-' });
    const hit = index.range(target, at, at + 1, false, undefined, true);
    assert.equal(target.raw.slice(hit.start, hit.end), '-');
    assert.ok(api.applyTextEdits(html, item.options[0].edits).includes('597-601'));
    const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [target].filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || []) }), true, true, undefined, new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }));
    assert.ok(marks.some(m => m.range.startColumn === index.starts[at] + 1 && m.range.endColumn === index.ends[at] + 1));
    assert.ok(!marks.some(m => m.range.startColumn <= index.starts[des + 2] + 1 && m.range.endColumn > index.starts[des] + 1));
    for (const [connection] of [target].filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || [])) {
      const diff = index.compare(target, connection);
      assert.equal(diff.parts.map(p => p.html).join(''), index.raw.slice(connection.start, connection.end));
      assert.equal(diff.parts.map(p => p.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
    }
  }
});

test('ME08-411 page text owns overlapping document highlights and hover messages', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-411.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, fixture.source);
  const page = new api.PdfConnections(locator, { raw: fixture.pdf, parts: [] });
  index?.connect([page]);
  const document = new api.PdfConnections(locator, { raw: fixture.pdf, pages: [] });
  const pageConnection = index.byTarget.get(page)[0];
  const connection = index.remember(pageConnection.start, pageConnection.end, document,
    { start: pageConnection.targetStart, end: pageConnection.targetEnd });
  // Both alignments are valid: the larger scope deletes the earlier repeated re.
  const parts = index.compare(page, pageConnection).parts.map(part => ({ ...part }));
  const re = parts.findIndex(part => part.changed && part.html === 're' && !part.pdf);
  assert.ok(re > 0);
  for (const key of ['html', 'pdf']) {
    parts[re - 1][key] = parts[re - 1][key].slice(0, -2);
    parts[re + 1][key] = 're' + parts[re + 1][key];
  }
  connection.editorDiff = { distance: 50, parts: parts.map(({ html, pdf, start, targetStart, changed }) =>
    new api.diffIndex(html, pdf, start, targetStart, changed)) };
  assert.equal(parts.map(part => part.html).join(''), index.raw.slice(connection.start, connection.end));
  assert.equal(parts.map(part => part.pdf).join(''), document.raw.slice(connection.targetStart, connection.targetEnd));
  // The real rendered page ends before the document mapping does.
  const pageEnd = index.raw.indexOf('noch eine Vorbemerkung');
  const mapped = index.range(page, pageConnection.start, pageEnd, false, pageConnection, true);
  pageConnection.end = pageEnd;
  pageConnection.targetEnd = mapped.end;
  delete pageConnection.editorDiff;
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const expected = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [page].filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || []) }), true, true, undefined, documentModel);
  const candidates = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [page] }).map(({ preview, ...item }) => item);
  const rendered = new api.PdfConnections(locator, { raw: fixture.pdf, parts: [], layer: {} });
  index.byTarget.set(rendered, [pageConnection]);
  for (const targets of [[document, page], [page, document], [document, page, rendered], [document, page]]) {
    assert.deepEqual(sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: targets.filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || []) }), true, true, undefined, documentModel)
      .filter(mark => mark.range.startColumn - 1 < index.starts[pageEnd]), expected);
    assert.deepEqual(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: targets }).filter(item => item.sourceStart < pageEnd)
      .map(({ preview, ...item }) => item), candidates);
    assert.ok(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: targets }).some(item => item.sourceStart >= pageEnd), 'document-only differences remain available');
    const at = index.raw.indexOf('Prahlerereien');
    const repeated = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: targets }).filter(item => item.sourceStart >= at && item.sourceStart < at + 12);
    assert.equal(repeated.length, 1);
    const [item] = repeated;
    const hit = index.range(page, item.sourceStart, item.sourceEnd, false, undefined, true);
    assert.equal(page.raw.slice(hit.start, hit.end), '');
    assert.deepEqual({ ...item.comparison }, { html: 're', pdf: '' });
    assert.ok(api.applyTextEdits(fixture.source, item.options[0].edits).includes('durch Prahlereien mit'));
  }
});

test('ME08-423 marked OCR errors reuse confirmed document mappings beyond page connections', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-423.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, fixture.source);
  const page = new api.PdfConnections(locator, { raw: fixture.pdf, parts: [] });
  const full = new api.PdfConnections(locator, { raw: fixture.pdf,
    pages: [{ number: 445, start: 0, end: fixture.pdf.length, parts: [] }] });
  locator.getDocumentIndex = () => full;
  locator.environment.getVisiblePages = () => [{ number: 445, index: page }];
  source?.connect([page], {});
  locator.indexDocument = () => { throw new Error('marker lookup must not load offscreen text'); };
  full.search = () => { throw new Error('marker lookup must reuse a confirmed connection'); };
  for (const [word, pdf] of [['weißen', '\nÎ^'], ['ab', '»h']]) {
    const start = source.raw.lastIndexOf(word === 'ab' ? 'abnahm' : word), end = start + word.length;
    const mapped = source.range(page, start, end, false, undefined, true);
    if (mapped) assert.equal(page.raw.slice(mapped.start, mapped.end).trim(), pdf.trim());
    const [location] = locator.findLocations({}, [{ index: source, start, end, marked: true,
      text: source.raw.slice(start, end) }], true);
    assert.equal(location.targets.length, 1);
    const target = location.targets[0];
    assert.equal(target.pageNumber, 445);
    assert.equal(target.difference.html, word);
    assert.equal(target.difference.pdf, pdf);
    assert.equal(target.source.index, source);
  }
});

test('ME08-364 initial selection stays in the article when contents has a stronger word match', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-364.json', import.meta.url), 'utf8'));
  for (const ready of [false, true]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = new api.PdfConnections(locator, fixture.source), raw = fixture.pdf + '\n' + fixture.contents;
    const full = new api.PdfConnections(locator, { raw, pages: [
      { number: 387, start: 0, end: fixture.pdf.length, parts: [] },
      { number: 778, start: fixture.pdf.length + 1, end: raw.length, parts: [] }
    ] });
    let available = ready;
    locator.getDocumentIndex = () => available ? full : undefined;
    locator.indexDocument = async () => { available = true; return full; };
    // The first word can lie outside a retained connection while page preparation finishes.
    full.connect(index);
    index.prepared = { document: full };
    const body = index.raw.indexOf('Die folgenden');
    index.remember(body, index.raw.length, full, { start: raw.indexOf('Die folgenden'), end: fixture.pdf.length });
    const start = index.raw.indexOf('Kossuths'), end = start + 'Kossuths'.length;
    const entry = { index, start, end, text: index.raw.slice(start, end),
      before: index.raw.slice(Math.max(0, start - 160), start), after: index.raw.slice(end, end + 160) };
    const mapped = index.range(full, start, end);
    assert.equal(full.raw.slice(mapped.start, mapped.end), 'Kossuths');
    assert.ok(mapped.end <= fixture.pdf.length, 'on-demand preparation stays in the article');
    assert.ok(full.search(entry).start > fixture.pdf.length, 'unrestricted search prefers the contents entry');
    full.connect = () => { throw new Error('selection must reuse its prepared page scope'); };
    const [location] = await locator.findLocations({}, [entry]);
    assert.equal(location.targets.length, 1);
    assert.equal(location.targets[0].pageNumber, 387, 'selection must stay on printed page 364');
    assert.equal(location.targets[0].text, 'Kossuths');
  }
});

test('ME08-364 wrapped title compounds keep both sides of the anchor boundary', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-364.json', import.meta.url), 'utf8'));
  for (const full of [false, true]) for (const hyphen of ['-', '\u2010', '\u2011']) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const source = fixture.source.replaceAll('Kossuths-Bündnis', `Kossuths${hyphen}Bündnis`);
    const raw = fixture.pdf.replace('Kossuths-\n', `Kossuths${hyphen}\n`);
    const target = new api.PdfConnections(locator, { raw });
    if (full) locator.getDocumentIndex = () => target;
    const index = new api.PdfConnections(locator, source);
    index?.connect([target], {});
    const start = index.raw.indexOf('Kossuths'), end = start + 'Kossuths-Bündnis'.length;
    for (const marked of [false, true]) {
      const hit = index.range(target, start, end, false, undefined, marked);
      assert.ok(hit, 'the title is inside the confirmed connection');
      assert.equal(raw.slice(hit.start, hit.end), `Kossuths${hyphen}\nBündnis`);
      const reverse = index.range(target, hit.start, hit.end, true);
      assert.equal(index.raw.slice(reverse.start, reverse.end), `Kossuths${hyphen}Bündnis`);
    }
    const candidates = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    assert.ok(candidates.length, 'unrelated real OCR differences remain reviewable');
    assert.ok(candidates.every(item => item.sourceStart >= end), 'no false title insertion');
    const corrected = api.applyTextEdits(source, candidates.flatMap(item => item.options[0].edits));
    assert.equal(corrected.split(`Kossuths${hyphen}`).length, 3, 'title and heading each retain one occurrence');
    assert.ok(corrected.endsWith(source.slice(source.indexOf('<aside>'))), 'footnote and file ending stay intact');
  }
});

test('ME05-486 joined PDF words retain matching text at passage edges', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-486.json', import.meta.url), 'utf8'));
  for (const missing of [false, true]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const source = missing ? fixture.source.replace('Unsre ', '') : fixture.source;
    const index = new api.PdfConnections(locator, source), target = new api.PdfConnections(locator, { raw: fixture.pdf });
    index?.connect([target]);
    const candidates = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    assert.deepEqual(Array.from(candidates, item => ({ ...item.comparison })), missing
      ? [{ html: '×', pdf: 'X' }, { html: '', pdf: 'Unsre' }] : []);
    if (missing) {
      const corrected = api.applyTextEdits(source, candidates.find(item => item.comparison.pdf === 'Unsre').options[0].edits);
      assert.equal(corrected.replace('UnsreVerwickelungen', 'Unsre Verwickelungen'), fixture.source);
    } else {
      const start = index.raw.indexOf('Unsre'), hit = index.range(target, start, start + 5);
      assert.ok(hit);
      assert.equal(target.raw.slice(hit.start, hit.end), 'Unsre');
    }
  }
});

test('ME05-284 wrapped words and dash variants do not create text highlights', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-284.json', import.meta.url), 'utf8'));
  for (const source of [fixture.source, fixture.source.replace(/\r\n/g, '\n')]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const target = new api.PdfConnections(locator, { raw: fixture.pdf,
      pages: [{ start: 0, end: fixture.pdf.length }], parts: [{ start: 0, end: fixture.pdf.length }] });
    locator.getDocumentIndex = () => target;
    const pdf = {}, index = new api.PdfConnections(locator, source);
    index?.connect([target], pdf);
    const candidates = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    assert.ok(candidates.length, 'real OCR errors remain reviewable');
    for (const item of candidates) {
      assert.ok(!/Wo|ist|dem|–/.test(item.comparison.html + item.comparison.pdf),
        JSON.stringify(item.comparison));
    }
    const corrected = api.applyTextEdits(source, candidates.flatMap(item => item.options[0].edits));
    const documentModel = new FixtureDocument({ model: { getValue: () => corrected, getVersionId: () => 2,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
    const revised = locator.editorSourceIndex(documentModel, [target]);
    revised?.connect([target], pdf);
    assert.equal(reviewCandidates(revised, { fonts: false, edits: true, text: true, targets: [target] }).length, 0, 'replaced text stays corrected after remapping');
    assert.equal(sourceDecorations(revised, reviewCandidates(revised, { fonts: true, edits: false, text: true, targets: [], connections: [target].filter(Boolean).flatMap(target => revised.connections.get(target)?.ranges || []) }), true, true, undefined, documentModel).length, 0);
  }
});

test('ME05-284 a real missing letter disappears from review after replacement', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-284.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const target = new api.PdfConnections(locator, { raw: fixture.pdf });
  locator.getDocumentIndex = () => target;
  let source = fixture.source.replace('Kölnischen Zeitung', 'Kölnische Zeitung'), version = 1;
  const documentModel = new FixtureDocument({ model: { getValue: () => source, getVersionId: () => version } }), model = documentModel.model;
  const pdf = {}, index = locator.editorSourceIndex(documentModel, [target]);
  index?.connect([target], pdf);
  const missing = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }).find(item => item.comparison.pdf === 'n');
  assert.ok(missing, 'a real missing letter must still be detected');
  source = api.applyTextEdits(source, missing.options[0].edits); version++; documentModel.update(documentModel.content);
  assert.ok(source.includes('Kölnischen Zeitung'));
  const revised = locator.editorSourceIndex(documentModel, [target]);
  revised?.connect([target], pdf);
  assert.equal(reviewCandidates(revised, { fonts: false, edits: true, text: true, targets: [target] }).some(item => item.comparison.pdf === 'n'), false);
});

test('ME05-389 OCR error near the final anchor retains the complete font correction', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-389.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, fixture.source), target = new api.PdfConnections(locator, { raw: fixture.pdf, parts: fixture.parts });
  locator.getDocumentIndex = () => target;
  index?.connect([target], {});
  const text = 'Geschrieben von Friedrich Engels.', start = index.raw.indexOf(text), end = start + text.length;
  const hit = index.range(target, start, end, false, undefined, true);
  assert.ok(hit, 'the final attribution stays in the confirmed alignment');
  assert.equal(target.raw.slice(hit.start, hit.end), 'Geschrieben vyn Friedrich Engels.');
  const item = reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [target].filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || []) }).find(item => item.sourceStart === start);
  assert.equal(item?.text, text, 'surplus bold is detected across the OCR error and matching suffix');
  const corrected = api.applyTextEdits(fixture.source, item.options[0].edits);
  assert.equal(corrected, fixture.source.replace(`<b>${text}</b>`, text), 'only formatting changes');
  assert.ok(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }).some(item => item.comparison.html === 'o' && item.comparison.pdf === 'y'));
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [target].filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || []) }), true, true, undefined, documentModel);
  assert.ok(marks.some(mark => mark.options.description === 'PDF font difference'
    && fixture.source.slice(mark.range.startColumn - 1, mark.range.endColumn - 1) === text));
  assert.ok(marks.some(mark => mark.options.description === 'PDF OCR text difference'
    && fixture.source.slice(mark.range.startColumn - 1, mark.range.endColumn - 1) === 'o'));
});

test('ME05-398 missing word prefix shares the highlight, click mapping and replacement', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-398.json', import.meta.url), 'utf8'));
  for (const source of [fixture.source, fixture.source.replace(/\r\n/g, '\n')]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = new api.PdfConnections(locator, source), target = new api.PdfConnections(locator, { raw: fixture.pdf });
    locator.getDocumentIndex = () => target;
    index?.connect([target], {});
    const at = index.raw.indexOf('versammlung'), item = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }).find(item => item.sourceStart === at);
    assert.equal(item?.comparison.html, '');
    assert.equal(item?.comparison.pdf, 'Vereinbarungs');
    assert.equal(item.sourceEnd, at);
    const hit = index.range(target, at, at, false, undefined, true);
    assert.equal(target.raw.slice(hit.start, hit.end), 'Vereinbarungs');
    const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
    const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [target].filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || []) }), true, true, undefined, documentModel);
    const mark = marks.find(mark => mark.options.before?.inlineClassName === 'mew-ocr-diff-insert'
      && mark.range.startColumn - 1 === source.indexOf('versammlung') && mark.range.endColumn - 1 === source.indexOf('versammlung'));
    assert.ok(mark, 'the missing prefix has its own clickable insertion caret');
    const range = { start: api.lowerBound(index.ends, mark.range.startColumn),
      end: api.lowerBound(index.starts, mark.range.endColumn - 1) };
    const clicked = index.range(target, range.start, range.end, false, undefined, true);
    assert.equal(target.raw.slice(clicked.start, clicked.end).trim(), 'Vereinbarungs');
    const corrected = api.applyTextEdits(source, item.options[0].edits);
    assert.equal(corrected, source.replace('Auflösung der versammlung', 'Auflösung der Vereinbarungsversammlung'));
    const revised = new api.PdfConnections(locator, corrected);
    revised?.connect([target], {});
    assert.ok(!reviewCandidates(revised, { fonts: false, edits: true, text: true, targets: [target] }).some(item => item.comparison.pdf.includes('Vereinbarungs')));
  }
});

test('ME05-281 repeated anchors across a broken word preserve the complete passage', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-281.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, fixture.source), target = new api.PdfConnections(locator, { raw: fixture.pdf });
  locator.getDocumentIndex = () => target;
  index?.connect([target], {});
  const start = index.raw.lastIndexOf('Anforderungen'), end = start + 'Anforderungen'.length;
  const hit = index.range(target, start, end, false, undefined, true);
  assert.ok(hit);
  assert.equal(api.significantText(target.raw.slice(hit.start, hit.end)), 'Anforderungen');
  const candidates = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
  assert.equal(candidates.some(item => item.sourceStart < end && item.sourceEnd > start), false);
  assert.deepEqual(Array.from(candidates, item => ({ ...item.comparison })), [{ html: 'h', pdf: 'b' }, { html: 'lb', pdf: 'ih' }]);
});

test('ME05-281 trailing whitespace cannot become a replacement from the next page header', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-281-boundary.json', import.meta.url), 'utf8'));
  for (const lf of [false, true]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
      isCurrent: () => true, waitForIdle: async () => {} });
    const index = new api.PdfConnections(locator, lf ? fixture.source.replace(/\r\n/g, '\n') : fixture.source);
    const page = new api.PdfConnections(locator, fixture.pages[0]), pdf = { numPages: 2, getPage: async number => ({
      getTextContent: async () => ({ items: [{ str: fixture.pages[number - 1],
        transform: [1, 0, 0, 1, 0, 100], width: 100, height: 10 }] })
    }) };
    index?.connect([page], pdf);
    const before = Array.from(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [page] }), item => ({ ...item.comparison }));
    const full = await locator.indexDocument(pdf);
    index?.connect([page, full], pdf);
    assert.deepEqual(Array.from(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [page, full] }), item => ({ ...item.comparison })), before);
    for (const connection of index.targetConnections(full))
      assert.equal(full.raw.slice(full.pages[0].end, connection.targetEnd).trim(), '', 'next page text stays outside the confirmed connection');
    const edits = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [full] }).flatMap(item => item.options[0].edits);
    assert.ok(!api.applyTextEdits(index.source, edits).includes('Karl'), 'batch replacement cannot append the next header');
  }
});

test('source index initializes empty, page-backed and explicit text parts', () => {
  const { PdfConnections, PdfLocator } = engine(), locator = new PdfLocator();
  const empty = new PdfConnections(locator);
  assert.equal(empty.locator, locator);
  assert.equal(empty.raw, '');
  assert.equal(empty.normalized.text, '');
  assert.deepEqual(Array.from(empty.parts), []);
  assert.deepEqual(Array.from(empty.fontRuns()), []);
  const first = { start: 0, end: 1, font: { bold: true, italic: false } };
  const second = { start: 2, end: 3, font: { bold: false, italic: true } };
  const pages = [{ parts: [first] }, { parts: [second] }];
  const full = new PdfConnections(locator, { raw: 'A B', pages });
  assert.deepEqual(Array.from(full.parts), [first, second]);
  assert.deepEqual(Array.from(full.fontRuns(), run => run.bold), [true, false]);
  const parts = [first];
  assert.equal(new PdfConnections(locator, { raw: 'A', pages, parts }).parts, parts);
});

test('concurrent font indexing shares page work while cancellation stays caller-local', async () => {
  const api = engine();
  let pageReads = 0, operators = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const page = {
    commonObjs: new Map([['f', { name: 'Times', bold: false, italic: false }]]),
    getTextContent: async () => ({ items: [{ str: 'Text', fontName: 'f', transform: [1, 0, 0, 1, 0, 10], height: 10, width: 20 }] }),
    getOperatorList: async () => { operators++; await gate; return { fnArray: [], argsArray: [] }; }
  };
  const pdf = { numPages: 1, getPage: async () => { pageReads++; return page; } };
  const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const index = await locator.indexDocument(pdf);
  const controller = new AbortController();
  const first = locator.indexFonts(pdf, null, controller.signal), second = locator.indexFonts(pdf);
  await Promise.resolve();
  controller.abort(); release();
  assert.equal(await first, null);
  assert.equal(await second, index);
  assert.equal(pageReads, 1, 'text indexing and font detection use the same PDF page read');
  assert.equal(operators, 1);
  assert.equal(index.fontVersion, 1, 'one metadata publication per page');
});

test('prepared page reuse invalidates when connections or target pages change', () => {
  const locator = new (engine().PdfLocator)({}, { document: { createElement: () => ({}) } });
  const source = new pdfApi.PdfConnections(locator, 'Alpha Beta Gamma Delta');
  const page = new pdfApi.PdfConnections(locator, source.raw), pdf = {};
  source?.connect([page], pdf);
  const initial = source.byTarget.get(page);
  let scopeReads = 0;
  const scopes = source.scopes;
  source.scopes = { get(target) { scopeReads++; return scopes.get(target); }, set: (target, value) => scopes.set(target, value) };
  for (let i = 0; i < 20; i++) source?.connect([page], pdf);
  assert.equal(scopeReads, 0, 'unchanged mappings bypass preparation entirely');
  assert.equal(source.byTarget.get(page), initial);
  source.remember(0, 5, page, { start: 0, end: 5 });
  source?.connect([page], pdf);
  assert.ok(scopeReads > 0, 'new selection mappings invalidate preparation');
  const rebuilt = new pdfApi.PdfConnections(locator, source.raw);
  source?.connect([rebuilt], pdf);
  assert.ok(source.byTarget.get(rebuilt)?.length, 'rebuilt text layers receive fresh mappings');
});

test('file diff updates shared state and retains unchanged sequence diffs', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, 'Alpha wrong Omega');
  const target = new api.PdfConnections(locator, 'Alpha right Omega'), pdf = {};
  target.sourcePages = [1];
  source.connect([target], pdf);
  const pairs = source.pairs;
  assert.ok(pairs.length);
  assert.equal(source.pairs, pairs);
  source.connect([target], pdf);
  assert.equal(source.pairs, pairs, 'unchanged file diff reuses its state');
  const diffs = new Map(pairs.map(([connection]) => [connection, connection.editorDiff]));
  for (const pair of pairs) {
    const [connection, index] = pair;
    assert.equal(pair.length, 2, 'prepared pairs do not duplicate the connection-owned diff');
    assert.ok(connection.editorDiff, 'file preparation still prepares sequence diffs eagerly');
    assert.equal(source.compare(index, connection), diffs.get(connection), 'sequence and global handlers share the same result');
  }
  assert.equal(api.applyTextEdits(source.source, reviewCandidates(source, { fonts: false, edits: true, text: true, targets: [target], connections: pairs })
    .flatMap(item => item.options[0].edits)), 'Alpha right Omega');
  const extra = new api.PdfConnections(locator, 'Alpha wrong Omega');
  source.connect([target, extra], pdf);
  const updated = source.pairs;
  assert.notEqual(updated, pairs, 'changing targets updates the overall diff');
  assert.ok(updated.some(([, index]) => index === extra));
  for (const [connection, index] of pairs)
    assert.equal(updated.find(([item, page]) => item === connection && page === index)?.[0].editorDiff, diffs.get(connection),
      'unchanged sequences survive a global update');
  source.connect([target], {});
  assert.notEqual(source.pairs, updated, 'PDF replacement refreshes shared state');
});

test('shared differences refresh target and fonts on the explicitly selected source snapshot', () => {
  const api = engine(), pdf = {};
  let source = 'Alpha wrong Omega', version = 1, targets = [];
  const documentModel = new FixtureDocument({ model: { getValue: () => source, getVersionId: () => version,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getPdf: () => pdf, getTargets: () => targets });
  const page = raw => new api.PdfConnections(locator, { raw, sourcePages: [1], fontVersion: 0,
    parts: [{ start: 0, end: raw.length, font: { bold: false, italic: false } }] });
  targets = [page('Alpha right Omega')];
  let index = locator.editorSourceIndex(documentModel);
  const first = index.getDifferences();
  assert.equal(index.getDifferences(), first, 'unchanged consumers reuse the whole classified result');
  assert.ok(first.items.filter(item => !item.font).some(item => item.comparison.pdf === 'right'));
  assert.equal(first.items.filter(item => item.font).length, 0);
  const alignment = first.connections[0][2];
  index.remember(0, 5, targets[0], { start: 0, end: 5 });
  assert.notEqual(index.getDifferences(), first, 'new mappings invalidate the overall result automatically');
  assert.deepEqual(index.getDifferences().items.filter(item => !item.font), first.items.filter(item => !item.font), 'selection mappings preserve the prepared file diff');
  targets[0].parts[0].font.italic = true;
  targets[0].fontVersion++;
  const styled = index.getDifferences();
  assert.notEqual(styled, first);
  assert.ok(styled.items.filter(item => item.font).length, 'font publication refreshes the shared classification');
  assert.equal(styled.connections[0][2], alignment, 'font updates preserve the text alignment');
  const snapshot = JSON.stringify(styled.items);
  Object.freeze(styled.items);
  const buildText = index.textEdits;
  index.textEdits = () => assert.fail('highlight filters must reuse the shared text candidates');
  for (const fonts of [true, false, [], ['bold'], ['italic']]) for (const text of [true, false]) {
    const marks = sourceDecorations(index, reviewCandidates(index, { fonts: fonts, edits: false, text: text, targets: [], connections: styled.connections }), fonts, text, undefined, documentModel);
    if (!text) assert.ok(marks.every(mark => mark.options.description === 'PDF font difference'));
    if (fonts === false || Array.isArray(fonts) && !fonts.length)
      assert.ok(marks.every(mark => mark.options.description === 'PDF OCR text difference'));
    assert.equal(index.getDifferences().items, styled.items, 'toggles keep the shared collection');
  }
  index.textEdits = buildText;
  reviewCandidates(index, { selected: true, items: [{ sourceStart: 6, sourceEnd: 11,
    selection: true, comparison: { html: 'wrong', pdf: 'right', source: { index, start: 6, end: 11 } } }] });
  assert.equal(index.getDifferences().items, styled.items, 'explicit selections keep their candidates temporary');
  assert.equal(JSON.stringify(styled.items), snapshot, 'views do not mutate the shared candidates');
  source = 'Alpha right Omega'; version++; documentModel.update(documentModel.content);
  index = locator.editorSourceIndex(documentModel);
  const edited = index.getDifferences();
  assert.equal(edited.index.source, source, 'the caller explicitly selects the current editor snapshot');
  assert.equal(edited.items.filter(item => !item.font).length, 0, 'the new editor snapshot has its own diff');
  source = '<i>Alpha right Omega</i>'; version++; documentModel.update(documentModel.content);
  index = locator.editorSourceIndex(documentModel);
  assert.equal(index.getDifferences().items.filter(item => item.font).length, 0, 'markup edits refresh HTML formatting with unchanged visible text');
  targets = [page('Alpha RIGHT Omega')];
  const replaced = index.getDifferences();
  assert.ok(replaced.items.filter(item => !item.font).length, 'replacing targets updates the current editor diff');
  assert.ok(replaced.connections.every(([, target]) => target === targets[0]), 'disposed targets leave the shared state');
  assert.equal(index.getDifferences(), replaced);
});

test('candidate interval lookup retains overlap and insertion boundary rules', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, 'abcdefghijklmnopqrstuv');
  const intervals = [[5, 8], [0, 2], [2, 5], [8, 8], [7, 10], [8, 11], [11, 14], [14, 14], [13, 15]];
  const targets = intervals.map(([start, end]) => {
    const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: 'XYZ' });
    index.byTarget.set(target, [{ start, end, targetStart: 0, targetEnd: 3,
      editorDiff: { parts: [new api.diffIndex(index.raw.slice(start, end), target.raw, 0, 0, true)] } }]);
    return target;
  });
  assert.deepEqual(Array.from(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: targets }), item => item.id),
    ['0:2', '2:5', '5:8', '8:8', '11:14', '14:14']);
});

test('large selected passages share one comparison between replacement edits and popup rendering', async () => {
  const api = engine(), providers = new Map(), pdf = {};
  const diff = api.textDiff;
  let comparisons = 0;
  api.textDiff = (...args) => { comparisons++; return diff(...args); };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const html = 'A long selected passage with surrounding context. '.repeat(320);
  const index = new api.PdfConnections(locator, html), changed = html.indexOf('selected') + 3;
  const reading = html.slice(0, changed) + 'X' + html.slice(changed + 1);
  const notice = { html, pdf: reading, source: { index, start: 0, end: html.length } };
  const documentModel = new FixtureDocument({ model: { getValue: () => html, getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const editor = { document: documentModel, getModel: () => model };
  reviewProvider(api, providers, { viewer: { pdfDocument: pdf }, locator, editor });
  const provider = providers.get('pdf-ocr');
  const items = (await provider.locator.reviewItems({ source: html, model, request: { pdf, notice }, signal: new AbortController().signal })).items;
  assert.equal(items.length, 1);
  const item = items[0], state = { model, items, choices: new Map([[item.id, 'pdf']]) };
  const content = provider.content(state, item);
  provider.content(state, item);
  assert.equal(comparisons, 1, 'opening and rendering the same selection must not repeat its character diff');
  assert.equal(api.applyTextEdits(html, item.options[0].edits), reading, 'cached parts preserve the exact replacement');
  assert.equal(content.comparison[0].parts.map(part => part.text).join(''), html);
  assert.equal(content.comparison[1].parts.map(part => part.text).join(''), reading);
  notice.pdf = reading + '!';
  provider.content(state, item);
  assert.equal(comparisons, 2, 'a changed PDF reading invalidates the comparison');
});

test('review navigation reuses comparison diffs and invalidates changed readings', () => {
  const api = engine(), providers = new Map(), diff = api.textDiff;
  let calls = 0;
  api.textDiff = (...args) => { calls++; return diff(...args); };
  reviewProvider(api, providers);
  const item = { id: 'item', comparison: { html: 'before WRONG after', pdf: 'before RIGHT after' },
    options: [{ id: 'pdf', edits: [] }] };
  const state = { choices: new Map([['item', 'pdf']]), items: [item] };
  const provider = providers.get('pdf-ocr');
  const first = provider.content(state, item);
  for (let i = 0; i < 20; i++) assert.deepEqual(provider.content(state, item).comparison, first.comparison);
  assert.equal(calls, 1);
  item.comparison.pdf = 'before NEW after';
  provider.content(state, item);
  assert.equal(calls, 2, 'changed text must not reuse the preceding diff');
});

test('popup anchor reuses mappings and text geometry while following scrolling and changed connections', () => {
  const window = {};
  vm.runInNewContext(engineSource.replace(
    '  range(target, start, end, reverse = false, connection, marked = false) {',
    '$& window.mappingCalls = (window.mappingCalls || 0) + 1;'
  ), { window });
  let top = 20, scale = 1, visible, measurements = 0;
  const locator = new window.PdfReviewProvider.PdfLocator({}, {
    getVisiblePages: () => [{ index: visible }],
    document: { createElement: () => ({}), createRange: () => ({ setStart() {}, setEnd() {},
      getClientRects: () => { measurements++; return [
        { left: 10, top, bottom: top + 12, width: 20, height: 12 },
        { left: 0, top: top + 16, bottom: top + 28, width: 0, height: 12 }
      ]; } }) }
  });
  const source = new window.PdfSelectionDiff.PdfConnections(locator, 'Alpha Beta');
  visible = new window.PdfSelectionDiff.PdfConnections(locator, 'Alpha Beta');
  visible.layer = { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: top - 20, width: 600 * scale, height: 800 * scale }) };
  visible.parts = [{ start: 0, end: visible.raw.length, node: { length: visible.raw.length } }];
  source.remember(0, source.raw.length, visible, { start: 0, end: visible.raw.length });
  const item = { sourceStart: 6, sourceEnd: 10, pdfSource: { index: source, start: 6, end: 10 } };
  assert.equal(locator.reviewAnchors([item.pdfSource]).get(item.pdfSource).top, 20);
  assert.equal(locator.reviewAnchors([item.pdfSource]).get(item.pdfSource).left, 10, 'a collapsed next-line rect must not pull a text anchor to the left');
  assert.equal(locator.reviewAnchors([item.pdfSource]).get(item.pdfSource).bottom, 32, 'a collapsed next-line rect must not extend a text anchor downwards');
  const initial = window.mappingCalls;
  top = 50;
  assert.equal(locator.reviewAnchors([item.pdfSource]).get(item.pdfSource).top, 50, 'scrolling follows the current layer position');
  assert.equal(measurements, 1, 'scrolling does not remeasure selected text');
  assert.equal(window.mappingCalls, initial, 'scrolling reuses the confirmed mapping');
  scale = 2;
  assert.equal(locator.reviewAnchors([item.pdfSource]).get(item.pdfSource).bottom, 94, 'cached coordinates follow the layer scale');
  assert.equal(measurements, 1, 'scaling existing geometry needs no text measurement');
  scale = 1;
  source.byTarget.set(visible, [...source.byTarget.get(visible)]);
  locator.reviewAnchors([item.pdfSource]).get(item.pdfSource);
  assert.ok(window.mappingCalls > initial, 'changed connections invalidate the mapping');
  assert.equal(measurements, 2, 'changed connections invalidate text geometry');
  visible.layer.isConnected = false;
  assert.equal(locator.reviewAnchors([item.pdfSource]).get(item.pdfSource), undefined, 'detached layers never anchor a popup');
});

test('PDF newline differences use a caret without highlighting adjacent letters', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const endpoints = [];
    const provider = reviewProvider(engine(), new Map(), undefined, { createRange: () => ({
      setStart(node, offset) { endpoints.push([node, offset]); },
      setEnd(node, offset) { endpoints.push([node, offset]); },
      getBoundingClientRect: () => ({ left: 20, right: 20, top: 20, width: 0, height: 10 }),
      getClientRects: () => [{ left: 20, right: 20, top: 20, width: 0, height: 10 }]
    }) });
    const next = { length: 4 }, raw = 'alpha' + newline + 'beta';
    const index = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw, parts: [
      { node: { length: 5 }, start: 0, end: 5 },
      { node: next, start: 5 + newline.length, end: raw.length }
    ] });
    const div = { clientLeft: 0, clientTop: 0, clientWidth: 100, clientHeight: 100,
      offsetWidth: 100, offsetHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
    const hit = { start: 5, end: 5 + newline.length, difference: { html: 's', pdf: newline } };
    const result = provider.highlights.measureHighlights(div, index, [hit], hit);
    assert.deepEqual(endpoints, [[next, 0], [next, 0]], 'both PDF range endpoints stay at the insertion point');
    assert.equal(result.boxes.length, 1);
    assert.equal(result.boxes[0].caret, true);
    assert.equal(result.boxes[0].w, .02);
    assert.equal(result.notices[0].pdf, newline, 'replacement retains the actual line break');
  }
});

test('font detection preserves unknown attributes and merges only compatible UTF-16 runs', () => {
  const api = engine();
  assert.equal(api.fontStyle(null, 'g_d0_f1').italic, null);
  assert.equal(api.fontStyle(null, 'serif', { fontWeight: '400', fontStyle: 'normal' }).bold, null);
  const italic = api.fontStyle({ name: 'ABCDEF+Times-Italic', italic: true, bold: false });
  const bold = api.fontStyle({ name: 'Helvetica-Bold', italic: false, bold: true });
  assert.equal(italic.italic, true);
  assert.equal(italic.bold, false);
  assert.equal(api.fontStyle({ name: 'Blackadder', bold: false }).bold, false, 'explicit metadata takes priority over name hints');
  assert.equal(api.fontStyle(null, 'Times-BoldOblique').bold, true);
  assert.equal(api.fontStyle(null, '', { fontStyle: 'oblique 12deg' }).italic, true);
  const index = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: '𠀀a b c', parts: [
    { start: 0, end: 3, font: italic }, { start: 4, end: 5, font: italic }, { start: 6, end: 7, font: bold }
  ] });
  const runs = index.fontRuns(2, 7);
  assert.equal(runs.length, 2);
  assert.equal(index.raw.slice(runs[0].start, runs[0].end), 'a b');
  const hover = formats => reviewProvider(api).sourceHover({ font: {}, formats }, {}).value;
  assert.match(hover(runs.map(run => ({ htmlFont: run, font: run }))), /斜体：混合；粗体：混合/);
  assert.match(hover([]), /未知/);
});

test('independent text differences stay separate across tags while format runs retain their grouping', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = '<p><i>liebe</i>“ …</p>\n<p>later <b>abc</b>.</p>';
  const documentModel = new FixtureDocument({ model: { getValue: () => source, getVersionId: () => 1 } }), model = documentModel.model;
  const index = locator.editorSourceIndex(documentModel);
  const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: index.raw.replace('liebe“ …', 'Liebe" ...').replace('abc', 'xyz') });
  index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
  assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]),
    [['l', 'L'], ['“', '"'], ['…', '...'], ['abc', 'xyz']]);
  const updated = api.applyTextEdits(source, items.flatMap(item => item.options[0].edits));
  assert.equal(updated, '<p><i>Liebe</i>" ...</p>\n<p>later <b>xyz</b>.</p>', 'merged edits preserve inline tags');

  const formatted = '<p><i>a</i><b>b</b> <i>c</i><b>d</b></p>\n<p><i>E</i><b>F</b></p>';
  const formatIndex = locator.editorSourceIndex(new FixtureDocument({ model: { getValue: () => formatted, getVersionId: () => 1 } }));
  const regular = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: formatIndex.raw, parts: [{ start: 0, end: formatIndex.raw.length, font: { italic: false, bold: false } }] });
  const connection = formatIndex.remember(0, formatIndex.raw.length, regular, { start: 0, end: regular.raw.length });
  const formats = reviewCandidates(formatIndex, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, regular]] });
  assert.deepEqual(Array.from(formats, item => item.text), ['ab cd', 'EF']);
  assert.equal(formats[0].formats.length, 4, 'both bold and italic details survive grouping');
});

test('OCR text indexing starts shared font detection and retains unavailable metadata as unknown', async () => {
  const api = engine();
  let operators = 0;
  const objects = new Map();
  const pdf = { numPages: 1, getPage: async () => ({
    commonObjs: objects,
    getOperatorList: async () => { operators++; objects.set('f1', { name: 'Times-BoldItalic', italic: true, bold: true }); },
    getTextContent: async () => ({ items: ['f1', 'missing'].map((fontName, i) => ({
      str: i ? 'unknown' : 'styled', fontName, transform: [1, 0, 0, 1, 0, 100 - i * 20], height: 12, width: 40
    })) })
  }) };
  const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const text = await locator.indexDocument(pdf);
  assert.equal(operators, 1, 'the OCR page read starts font detection without a separate review pass');
  const full = await locator.indexFonts(pdf);
  assert.equal(full, text, 'font data enriches the existing text index');
  const runs = full.fontRuns();
  assert.equal(runs[0].italic, true);
  assert.equal(runs[0].bold, true);
  assert.equal(runs[1].italic, null);
  assert.equal(await locator.indexFonts(pdf), full);
  assert.equal(operators, 1);
});

test('page-uniform styles become unknown independently of other pages', async () => {
  for (const styles of [
    [[true, false], [true, true]],
    [[false, true], [true, true]],
    [[true, true], [true, true]],
    [[true, false], [true, false]],
    [[false, true], [false, true]],
    [[false, false], [true, true]],
    [[true, true], [null, null]]
  ]) {
    const api = engine();
    const pages = styles.map(([bold, italic], i) => ({
      commonObjs: new Map([['f', { name: `Face${i}`, bold, italic }]]),
      getOperatorList: async () => ({ fnArray: [37, 38, 44], argsArray: [['f', 12], [3], []] }),
      getTextContent: async () => ({ items: [{ str: `Page${i}`, fontName: 'f', transform: [1, 0, 0, 1, 0, 100], height: 12, width: 40 }] })
    }));
    const pdf = { numPages: pages.length, getPage: async number => pages[number - 1] };
    const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
    const full = await locator.indexFonts(pdf);
    for (let i = 0; i < styles.length; i++) {
      const font = full.pages[i].parts[0].font;
      for (const [column, key] of ['bold', 'italic'].entries()) {
        const uniform = styles[i][column] === true;
        assert.equal(font[key], uniform ? null : styles[i][column]);
        if (uniform) assert.match(font.reason, /均为/);
      }
    }
    assert.equal(await locator.indexFonts(pdf), full);
    if (styles.every(style => style[0] === styles[0][0] && style[1] === styles[0][1])) {
      // Unknown attributes must produce neither missing nor surplus style marks.
      for (const htmlStyle of [false, true]) {
        const index = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: full.raw, formats: Array.from(full.raw, () => ({ bold: htmlStyle, italic: htmlStyle })) });
        const connection = { start: 0, end: full.raw.length, targetStart: 0, targetEnd: full.raw.length };
        const items = reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, full]] });
        const knownMismatch = styles[0].some(value => value === false && htmlStyle);
        assert.equal(items.length > 0, knownMismatch);
      }
    }
  }
});

test('uniform page styles are unknown even while later pages are pending', async () => {
  const api = engine();
  let finish, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const pages = [1, 2].map(number => ({
    commonObjs: new Map([['f', { name: 'Times-BoldItalic', bold: true, italic: true }]]),
    getTextContent: async () => ({ items: [{ str: `Page${number}`, fontName: 'f', transform: [1, 0, 0, 1, 0, 100], height: 12, width: 40 }] }),
    async getOperatorList() { if (number === 2) { entered(); await gate; } return { fnArray: [], argsArray: [] }; }
  }));
  const pdf = { numPages: 2, getPage: async number => pages[number - 1] };
  const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const full = await locator.indexDocument(pdf);
  const pending = locator.indexFonts(pdf);
  await waiting;
  assert.ok(full.fontRuns().every(run => run.bold === null && run.italic === null));
  finish();
  await pending;
  assert.ok(full.fontRuns().every(run => run.bold === null && run.italic === null));
});

test('text and font differences coexist across changed text with uniform PDF fonts', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, pdf] of [['WRONG', 'RIGHT'], ['longer', 'x'], ['x', 'longer']]) {
    const index = new api.PdfConnections(locator, html);
    const target = new api.PdfConnections(locator, { raw: pdf,
      parts: [{ start: 0, end: pdf.length, font: { bold: true, italic: false } }] });
    const connection = index.remember(0, html.length, target, { start: 0, end: pdf.length });
    const diff = { parts: [new api.diffIndex(html, pdf)] };
    connection.editorDiff = diff;
    const fonts = reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target]] });
    assert.deepEqual(Array.from(fonts, item => item.text), [html]);
    assert.ok(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }).length, 'font detection retains the text candidate');
    assert.equal(api.applyTextEdits(html, fonts[0].options[0].edits), `<b>${html}</b>`);
    target.parts = [{ start: 0, end: 1, font: { bold: true } },
      { start: 1, end: pdf.length, font: { bold: false } }];
    if (pdf.length > 1) assert.equal(reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target]] }).length, 0,
      'unaligned text spanning conflicting PDF fonts has no inferred format edit');
  }
});

test('wrong OCR readings retain eligible styles across font names and HTML-only characters', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [text, pdf] of [['Neue Rheinische Zeitung', 'Neüe Rheinische Zeitung'],
    ['Neue Rheinische Zeitung', 'Nue Rheinische Zeitung'], ['WRONG', 'RIGHT']]) {
    const html = `<b>${text}</b>`, index = new api.PdfConnections(locator, html);
    const target = new api.PdfConnections(locator, { raw: pdf, parts: Array.from(pdf, (_, i) => ({
      start: i, end: i + 1, font: { name: `Face${i % 2}`, bold: false, italic: false }
    })) });
    const connection = index.remember(0, text.length, target, { start: 0, end: pdf.length });
    const items = reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target]] });
    assert.equal(items.length, 1);
    assert.equal(items[0].text, text, 'the correction covers the complete HTML bold span');
    assert.equal(api.applyTextEdits(html, items[0].options[0].edits), text, 'format correction preserves the HTML reading');
    assert.ok(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }).length, 'OCR text remains separately reviewable');
  }
  const index = new api.PdfConnections(locator, '<b>AxB</b>');
  const target = new api.PdfConnections(locator, { raw: 'AB', parts: [
    { start: 0, end: 1, font: { bold: false, italic: false } },
    { start: 1, end: 2, font: { bold: true, italic: false } }
  ] });
  const connection = index.remember(0, 3, target, { start: 0, end: 2 });
  assert.deepEqual(Array.from(reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target]] }), item => item.text), ['A'],
    'an HTML-only character between conflicting styles has no inferred bold correction');
  const mixed = new api.PdfConnections(locator, '<b><i>WRONG</i></b>');
  target.raw = 'RIGHT';
  target.parts = [
    { start: 0, end: 2, font: { bold: false, italic: false } },
    { start: 2, end: 5, font: { bold: false, italic: true } }
  ];
  const changed = { start: 0, end: 5, targetStart: 0, targetEnd: 5,
    editorDiff: { parts: [new api.diffIndex('WRONG', 'RIGHT')] } };
  const eligible = reviewCandidates(mixed, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[changed, target]] });
  assert.equal(api.applyTextEdits(mixed.source, eligible[0].options[0].edits), '<i>WRONG</i>',
    'uniform bold is corrected while mixed italic stays unchanged');
  target.parts[1].font.bold = null;
  target.fontVersion = (target.fontVersion || 0) + 1;
  assert.equal(reviewCandidates(mixed, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[changed, target]] }).length, 0, 'unknown bold prevents an inferred edit');
});

test('non-bold OCR metadata survives a page containing normal and italic text', async () => {
  const api = engine();
  const items = [{ str: 'Neüe Rheinische Zeitung', fontName: 'regular' }, { str: 'Köln', fontName: 'italic' }];
  const page = { commonObjs: new Map([
    ['regular', { name: 'TimesNewRomanPSMT', bold: false, italic: false }],
    ['italic', { name: 'TimesNewRomanPS-ItalicMT', bold: false, italic: true }]
  ]), getOperatorList: async () => ({ fnArray: [37, 38, 44, 37, 44],
    argsArray: [['regular', 12], [3], [], ['italic', 12], []] }) };
  const fonts = await api.readPageFonts(page, items);
  assert.equal(fonts.get('regular').bold, false);
  assert.equal(fonts.get('regular').italic, false);
  assert.equal(fonts.get('italic').bold, false);
  assert.equal(fonts.get('italic').italic, true);
});

test('text and font highlights keep independent ranges across tags and adjacent changes', () => {
  const api = engine(), provider = reviewProvider(api);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  for (const [markup, pdf, text, fonts] of [
    ['<i>keinen</i>', 'keinem', ['n'], ['keinen']],
    ['h<i>eine</i>X', 'keineY', ['h', 'X'], ['eine']],
    ['<i>h<b>ein</b>e</i>', 'keine', ['h'], ['h', 'ein', 'e']],
    ['<i>heine Worte</i>', 'keine Worte', ['h'], ['heine Worte']]
  ]) {
    const index = new api.PdfConnections(locator, markup);
    const target = new api.PdfConnections(locator, { raw: pdf,
      parts: [{ start: 0, end: pdf.length, font: { italic: false, bold: false } }] });
    const connection = index.remember(0, index.raw.length, target, { start: 0, end: pdf.length });
    index.fontEdits = () => assert.fail('Highlighting must not build format replacement edits');
    const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [target], connections: [[connection, target], [connection, target]] }), true, true, item => provider.sourceHover(item, model), documentModel);
    for (const [className, expected] of [['mew-ocr-diff-text', text], ['mew-font-diff-text', fonts]]) {
      assert.deepEqual(Array.from(marks.filter(mark => mark.options.inlineClassName === className),
        mark => markup.slice(mark.range.startColumn - 1, mark.range.endColumn - 1)), expected);
    }
    for (const { options } of marks) {
      const font = options.inlineClassName === 'mew-font-diff-text';
      assert.equal(options.description, font ? 'PDF font difference' : 'PDF OCR text difference');
      assert.match(options.hoverMessage.value, font ? /PDF: 斜体/ : /PDF:/);
    }
  }
  const index = new api.PdfConnections(locator, '<i>word</i> gap WRONG');
  const target = new api.PdfConnections(locator, { raw: 'word gap RIGHT',
    parts: [{ start: 0, end: 14, font: { italic: false, bold: false } }] });
  const connection = index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  assert.deepEqual(Array.from(sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [[connection, target]] }), true, true, undefined, documentModel), mark => mark.options.description),
    ['PDF font difference', 'PDF OCR text difference'], 'unchanged gaps keep unrelated differences separate');
});

test('independent bold and italic detection limits highlights and applied styles', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const html = '<p>Word</p>', index = new api.PdfConnections(locator, html);
  const target = new api.PdfConnections(locator, { raw: index.raw,
    parts: [{ start: 0, end: index.raw.length, font: { italic: true, bold: true } }] });
  const connection = index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const pairs = [[connection, target]], documentModel = new FixtureDocument({ model: { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) } }), model = documentModel.model;
  for (const key of ['bold', 'italic']) {
    const items = reviewCandidates(index, { items: [], fonts: [key], edits: true, connections: pairs });
    assert.equal(items.length, 1);
    const result = new api.PdfConnections(locator, api.applyTextEdits(html, items[0].options[0].edits));
    assert.equal(result.formats[0][key], true);
    assert.equal(result.formats[0][key === 'bold' ? 'italic' : 'bold'], false, 'disabled style is never applied');
    assert.equal(sourceDecorations(index, reviewCandidates(index, { fonts: [key], edits: false, text: false, targets: [], connections: pairs }), [key], false, undefined, documentModel).length, 1);
    assert.equal(reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: pairs })[0].font[key === 'bold' ? 'italic' : 'bold'], true,
      'filtering preserves the cached PDF font');
  }
  assert.equal(reviewCandidates(index, { items: [], fonts: [], edits: true, connections: pairs }).length, 0);
  assert.equal(sourceDecorations(index, reviewCandidates(index, { fonts: [], edits: false, text: false, targets: [], connections: pairs }), [], false, undefined, documentModel).length, 0);
  const italic = new api.PdfConnections(locator, '<p><i>Word</i></p>');
  const same = italic.remember(0, italic.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(reviewCandidates(italic, { items: [], fonts: ['italic'], edits: true, connections: [[same, target]] }).length, 0,
    'a bold-only fault disappears when bold detection is disabled');
  const item = reviewCandidates(italic, { items: [], fonts: ['bold'], edits: true, connections: [[same, target]] })[0];
  const updated = new api.PdfConnections(locator, api.applyTextEdits(italic.source, item.options[0].edits));
  assert.equal(updated.formats[0].bold, true);
  assert.equal(updated.formats[0].italic, true, 'adding bold preserves existing italic markup');
});

test('format differences include missing, surplus and partially marked bold italic', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (let level = 1; level <= 6; level++) {
    const heading = new api.PdfConnections(locator, `<h${level}>2<br>Engels an Marx<br>in London</h${level}>`);
    const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: heading.raw, parts: [{ start: 0, end: heading.raw.length, font: { bold: false, italic: false } }] });
    const connection = heading.remember(0, heading.raw.length, target, { start: 0, end: target.raw.length });
    assert.equal(reviewCandidates(heading, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target]] }).length, 0, 'a heading alone does not declare bold');
    for (const markup of ['<b>Title</b>', '<strong>Title</strong>', '<span style="font-weight:700">Title</span>']) {
      const explicit = new api.PdfConnections(locator, `<h${level}>${markup}</h${level}>`);
      assert.equal(explicit.formats[0].bold, true, 'explicit bold inside a heading is retained');
    }
  }
  const html = '<p><i>A</i> <b>B</b> <b><i>C</i></b> <strong>D</strong> <em>E</em> <b style="font-weight:normal">F</b> <i style="font-style:normal">G</i> 𠀀</p>';
  const index = new api.PdfConnections(locator, html);
  const styles = [
    ['A', true, true], ['B', true, true], ['C', false, false], ['D', false, true],
    ['E', true, false], ['F', false, false], ['G', false, false], ['𠀀', true, null]
  ];
  const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: index.raw, parts: styles.map(([text, italic, bold]) => ({
    start: index.raw.indexOf(text), end: index.raw.indexOf(text) + text.length, font: { italic, bold, name: 'fixture' }
  })) });
  const connection = index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const items = reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target], [connection, target]] });
  assert.deepEqual(Array.from(items, item => item.text), ['A B C', '𠀀']);
  assert.equal(items[0].htmlFont.bold, false, 'italic alone misses the bold half');
  assert.equal(items[0].formats[1].htmlFont.italic, false, 'bold alone misses the italic half');
  assert.equal(items[0].formats[2].font.bold, false, 'surplus HTML formatting is also flagged');
  const revised = api.applyTextEdits(html, items.flatMap(item => item.options[0].edits));
  const corrected = new api.PdfConnections(locator, revised);
  assert.equal(corrected.raw, index.raw, 'format replacement preserves all visible text and UTF-16 characters');
  const confirmed = corrected.remember(0, corrected.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(reviewCandidates(corrected, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[confirmed, target, api.textDiff(corrected, target, confirmed)]] }).length, 0, 'missing, surplus and mixed bold/italic are corrected together');
  assert.ok(revised.includes('<strong>D</strong> <em>E</em>'), 'already correct formatting stays unchanged');
  const documentModel = new FixtureDocument({ model: { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) } }), model = documentModel.model;
  const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [[connection, target]] }), true, true, undefined, documentModel);
  assert.ok(marks.length >= 4);
  assert.ok(marks.every(mark => !html.slice(mark.range.startColumn - 1, mark.range.endColumn - 1).includes('<')), 'decorations exclude markup');
});

test('font edits move nearby bold and italic boundaries instead of duplicating wrappers', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, font, expected] of [
    ['<p><b>A</b> B</p>', { bold: true }, '<p><b>A B</b></p>'],
    ['<p>B <strong>C</strong></p>', { bold: true }, '<p><strong>B C</strong></p>'],
    ['<p><em>A</em> B <em>C</em></p>', { italic: true }, '<p><em>A B C</em></p>'],
    ['<p><i>A</i>\tB\t<i>C</i></p>', { italic: true }, '<p><i>A\tB\tC</i></p>'],
    ['<p><b>A</b> B <strong>C</strong></p>', { bold: true }, '<p><b>A B</b> <strong>C</strong></p>'],
    ['<p><b>A</b>\nB</p>', { bold: true }, '<p><b>A</b>\n<b>B</b></p>'],
    ['<p><b>A</b> X B</p>', { bold: true }, '<p><b>A</b> X <b>B</b></p>'],
    ['<p><b style="font-weight:normal">A</b> B</p>', { bold: true }, '<p><b style="font-weight:normal">A</b> <b>B</b></p>'],
    ['<p><b>A</b> B <i>C</i></p>', { bold: true, italic: true }, '<p><b>A</b> <b><i>B</i></b> <i>C</i></p>']
  ]) {
    const index = new api.PdfConnections(locator, html), start = index.raw.indexOf('B');
    const revised = api.applyTextEdits(html, index.fontEdits(start, start + 1, font));
    assert.equal(revised, expected);
    const corrected = new api.PdfConnections(locator, revised);
    assert.equal(corrected.raw, index.raw);
    for (const key of ['bold', 'italic']) {
      for (let at = 0; at < index.raw.length; at++) {
        if (/\s/.test(index.raw[at])) continue;
        assert.equal(corrected.formats[at][key], at === start && typeof font[key] === 'boolean' ? font[key] : index.formats[at][key]);
      }
    }
  }
});

test('font edits move touching tags and remove all selected bold and italic wrappers for plain text', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, selected, font, expected] of [
    ['<p><i>A</i>B</p>', 'B', { italic: true }, '<p><i>AB</i></p>'],
    ['<p>B<em>C</em></p>', 'B', { italic: true }, '<p><em>BC</em></p>'],
    ['<p><strong>A</strong>B<strong>C</strong></p>', 'B', { bold: true }, '<p><strong>ABC</strong></p>'],
    ['<p><b><i>ABC</i></b></p>', 'ABC', { bold: false, italic: false }, '<p>ABC</p>'],
    ['<p><b>A<i>B</i>C</b></p>', 'ABC', { bold: false, italic: false }, '<p>ABC</p>'],
    ['<p><i style="font-style:normal">ABC</i></p>', 'ABC', { italic: false }, '<p>ABC</p>'],
    ['<p><b><i>ABC</i></b></p>', 'B', { bold: false, italic: false }, '<p><b><i>A</i></b>B<b><i>C</i></b></p>']
  ]) {
    const index = new api.PdfConnections(locator, html), start = index.raw.indexOf(selected);
    const revised = api.applyTextEdits(html, index.fontEdits(start, start + selected.length, font));
    assert.equal(revised, expected);
    assert.equal(new api.PdfConnections(locator, revised).raw, index.raw);
  }
});

test('font edits reuse source coordinates and preserve entities, attributes and inline structure', () => {
  const api = engine();
  const document = { createElement: () => ({ set innerHTML(text) { this.content = { textContent: text === '&amp;' ? '&' : text }; } }) };
  const locator = new api.PdfLocator({}, { document });
  const html = '<p id="keep"><i>A&amp;<a href="/keep">𠀀B</a>C</i></p>';
  const index = new api.PdfConnections(locator, html);
  document.createElement = () => { throw new Error('must reuse the existing source index'); };
  const edits = index.fontEdits(1, 5, { italic: false, bold: true });
  const revised = api.applyTextEdits(html, edits);
  assert.equal(revised, '<p id="keep"><i>A</i><span style="font-weight:bold">&amp;</span><a href="/keep"><span style="font-weight:bold">𠀀B</span></a><i>C</i></p>');
  assert.equal(index.fontEdits(0, 1, { italic: null, bold: null }).length, 0, 'unknown PDF styles never produce automatic edits');
  assert.throws(() => api.applyTextEdits(html.replace('𠀀B', 'changed'), edits), /原文已变化/);
});

test('normal PDF formatting removes surplus tags and preserves formatting outside a partial correction', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, expected] of [
    ['<p><i>Vorträge über die Grundlagen</i></p>', '<p>Vorträge über die Grundlagen</p>'],
    ['<p><b><em>Vorträge über die Grundlagen</em></b></p>', '<p>Vorträge über die Grundlagen</p>'],
    ['<p><span style="font-style:italic;color:red">Vorträge über die Grundlagen</span></p>', '<p><span style="color:red">Vorträge über die Grundlagen</span></p>'],
    ['<p><i id="keep">Vorträge über die Grundlagen</i></p>', '<p><span id="keep">Vorträge über die Grundlagen</span></p>']
  ]) {
    const index = new api.PdfConnections(locator, html), end = index.raw.trimEnd().length;
    assert.equal(api.applyTextEdits(html, index.fontEdits(0, end, { italic: false, bold: false })), expected);
  }
  const html = '<p><i>A<a href="/keep">BC</a>D</i></p>', index = new api.PdfConnections(locator, html);
  const edits = index.fontEdits([
    { sourceStart: 1, sourceEnd: 2, font: { italic: false, bold: null } },
    { sourceStart: 3, sourceEnd: 4, font: { italic: false, bold: null } }
  ]);
  const revised = api.applyTextEdits(html, edits);
  assert.equal(revised, '<p><i>A</i><a href="/keep">B<i>C</i></a>D</p>');
  const corrected = new api.PdfConnections(locator, revised);
  assert.equal(corrected.raw, index.raw);
  assert.deepEqual(Array.from(corrected.formats.slice(0, 4), font => font.italic), [true, false, true, false]);
});

test('retained OCR font declarations participate in style comparison even when invisible or not embedded', async () => {
  const api = engine();
  const objects = new Map([
    ['hidden', { name: 'TimesNewRomanPS-BoldMT', italic: false, bold: true, missingFile: true }],
    ['hiddenItalic', { name: 'TimesNewRomanPS-BoldItalicMT', italic: true, bold: true, missingFile: false }],
    ['visible', { name: 'Helvetica-Bold', italic: false, bold: true, missingFile: true }],
    ['regular', { name: 'Helvetica', italic: false, bold: false }]
  ]);
  const items = [...objects.keys()].map(fontName => ({ fontName, str: fontName }));
  let calls = 0;
  const page = { commonObjs: objects, getOperatorList: async () => {
    calls++;
    return { fnArray: [10, 38, 37, 44, 37, 44, 11, 37, 44],
      argsArray: [[], [3], ['hidden', 8.5], [], ['hiddenItalic', 8.5], [], [], ['visible', 12], []] };
  } };
  const fonts = await api.readPageFonts(page, items);
  assert.equal(fonts.get('hidden').bold, true);
  assert.equal(fonts.get('hidden').declaredBold, true);
  assert.match(fonts.get('hidden').reason, /OCR 字体/);
  assert.equal(fonts.get('hiddenItalic').italic, true);
  assert.equal(fonts.get('hiddenItalic').declaredItalic, true);
  assert.equal(fonts.get('hiddenItalic').bold, true);
  assert.equal(fonts.get('visible').bold, true);
  assert.equal(await api.readPageFonts(page, items), fonts);
  assert.equal(calls, 1);
});

test('mixed visibility retains font declarations but failed inspection remains unknown', async () => {
  const api = engine(), commonObjs = new Map([['f', { name: 'Helvetica-Bold', bold: true, italic: false }]]);
  for (const [i, getOperatorList] of [
    async () => ({ fnArray: [37, 44, 38, 44], argsArray: [['f', 12], [], [7], []] }),
    async () => { throw new Error('unavailable operators'); }
  ].entries()) {
    const fonts = await api.readPageFonts({ commonObjs, getOperatorList }, [{ fontName: 'f', str: 'Word' }]);
    assert.equal(fonts.get('f').bold, null, 'uniform bold is unknown regardless of visibility');
    assert.equal(fonts.get('f').italic, i === 0 ? false : null);
    assert.ok(fonts.get('f').reason);
  }
});

test('review font loading uses metadata without reading scan pixels', async () => {
  for (const uniform of [false, true]) {
    const api = engine(), width = 600, height = 600, data = new Uint8Array(width * height / 8).fill(255);
    const items = Array.from({ length: 12 }, (_, i) => ({ str: 'abcdefghijklmnopqrst', fontName: i === 11 ? 'regular' : 'bold',
      transform: [24, 0, 0, 24, 50, 550 - i * 40], height: 24, width: 400 }));
    for (const [i, item] of items.entries()) {
      const thickness = uniform || i === 2 ? 5 : 2, top = height - item.transform[5] - 18;
      for (let glyph = 0; glyph < 20; glyph++) for (let y = top; y < top + 18; y++)
        for (let x = 55 + glyph * 18; x < 55 + glyph * 18 + thickness; x++)
          data[y * (width / 8) + (x >> 3)] &= ~(128 >> (x & 7));
    }
    const page = { commonObjs: new Map([['bold', { name: 'Same-Bold', bold: true, italic: false }],
      ['regular', { name: 'Same-Regular', bold: false, italic: false }]]),
      objs: { get: (id, resolve) => resolve({ data, width, height, kind: 1 }) },
      getOperatorList: async () => ({ fnArray: [10, 12, 85, 11, 37, 38, 44],
        argsArray: [[], [600, 0, 0, 600, 0, 0], ['scan'], [], ['bold', 24], [3], []] }),
      getTextContent: async () => ({ items }) };
    let scanReads = 0;
    page.objs.get = () => { scanReads++; throw new Error('Review must not read scan pixels'); };
    const pdf = { numPages: 1, getPage: async () => page };
    const baseFonts = await api.readPageFonts(page, items);
    assert.equal(api.textItemFont(baseFonts, items[2]).bold, null, 'PDF loading alone never detects scan bold');
    const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
    const readPageFonts = api.readPageFonts;
    const index = await locator.indexFonts(pdf), fonts = await readPageFonts(page, items);
    assert.equal(await readPageFonts(page, structuredClone(items)), fonts, 'provider shares cached PDF metadata');
    assert.equal(api.textItemFont(baseFonts, items[2]).bold, null, 'review retains unknown bold metadata');
    assert.equal(fonts.get('bold').bold, null, 'character-weighted dominant declaration is not trusted');
    assert.equal(index.pages[0].parts[0].font.bold, null, 'baseline text is not guessed regular');
    assert.equal(index.pages[0].parts[11].font.bold, false, 'minority regular metadata survives');
    const spans = items.map(item => ({ textContent: item.str, ownerDocument: { defaultView: {
      getComputedStyle: () => ({ fontFamily: 'Same', fontStyle: 'normal', fontWeight: '400' })
    } } }));
    const view = { pdfPage: page, _textHighlighter: { textDivs: spans } };
    await new Promise(resolve => api.layerFonts(view, {}, resolve));
    const fontAt = api.layerFonts(view, {}, () => {});
    assert.deepEqual(Array.from(fontAt.spans), spans, 'selection reuses the font lookup span list');
    assert.equal(fontAt(spans[2]).bold, null, 'selection uses PDF metadata without scan estimates');
    assert.equal(api.textItemFont(fonts, structuredClone(items[2])).bold, null);
    assert.equal(index.pages[0].parts[2].font.bold, null);
    assert.equal(scanReads, 0, 'review indexing and selection never access scan image data');
  }
});

test('Tesseract placeholder fonts remain unknown and cannot produce surplus HTML style differences', async () => {
  const api = engine();
  for (const name of ['GlyphLessFont', 'ABCDEF+GlyphLessFont']) {
    const style = api.fontStyle({ name, bold: false, italic: false }, '', { fontWeight: '700', fontStyle: 'italic' });
    assert.equal(style.bold, null);
    assert.equal(style.italic, null);
    assert.match(style.reason, /占位字体/);
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const html = '<p><b><i>Word</i></b></p>';
    const index = new api.PdfConnections(locator, html);
    const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: index.raw, parts: [{ start: 0, end: index.raw.length, font: style }] });
    const connection = index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
    assert.equal(reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target]] }).length, 0);
  }
});

test('locator returns page targets and rendered/source ranges without the highlight script', async () => {
  const api = engine();
  const texts = ['First page heading. Repeated words end here.', 'Second page heading. Repeated words end here.'];
  let reads = 0, indexed = 0;
  const pdf = { numPages: 2, async getPage(number) {
    reads++;
    return { async getTextContent() { return { items: [{ str: texts[number - 1],
      transform: [1, 0, 0, 1, 0, 500], width: 800, height: 24 }] }; } };
  } };
  const locator = new api.PdfLocator({}, {
    document: { createElement: () => ({}) }, isCurrent: current => current === pdf,
    waitForIdle: async () => {}, onIndexed: () => indexed++
  });
  const source = new api.PdfConnections(locator, '<p>' + texts.join('</p><p>') + '</p>');
  const start = source.raw.lastIndexOf('Repeated'), end = start + 'Repeated words'.length;
  const entry = { index: source, start, end, text: source.raw.slice(start, end),
    before: 'Second page heading. ', after: ' end here.' };
  const [location] = await locator.findLocations(pdf, [entry]);
  assert.equal(location.targets.length, 1);
  assert.equal(location.targets[0].pageNumber, 2);
  const page = new api.PdfConnections(locator, texts[1]);
  const { hits, focusHit } = locator.locateLayer(page, [], location.targets);
  assert.equal(hits.length, 1);
  assert.equal(page.raw.slice(focusHit.start, focusHit.end), entry.text);
  const { hit, difference } = locator.locateSource(source, [{ index: page, start: focusHit.start, end: focusHit.end }]);
  assert.equal(hit.start, start, 'reverse search respects the second page scope');
  assert.equal(hit.end, end);
  assert.equal(difference, null);
  assert.ok(Array.isArray(locator.findLocations(pdf, [entry])), 'prepared locations are synchronous');
  assert.equal(reads, 2, 'the PDF index is reused');
  assert.equal(indexed, 1);
});

test('ME32-007 reverse selections reuse OCR alignment around Gewißheit', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32.json', import.meta.url), 'utf8'));
  const api = engine();
  const pdf = { numPages: 1, async getPage() {
    return { getTextContent: async () => ({ items: fixture.pages[0].items }) };
  } };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const source = new api.PdfConnections(locator, fixture.html), full = await locator.indexDocument(pdf);
  const page = new api.PdfConnections(locator, full.raw.trim());
  source?.connect([page], pdf);
  for (const [word, expected] of [['hatte', 'hatte'], ['ihn', 'ihn'], ['GewiBheit', 'Gewißheit'], ['abzunehmen', 'abzunehmen']]) {
    const start = page.raw.indexOf(word, page.raw.indexOf('GewiBheit'));
    assert.ok(start >= 0);
    const { hit, difference } = locator.locateSource(source, [{ index: page, start, end: start + word.length }]);
    assert.ok(hit, `reverse selection of ${word} must survive neighbouring OCR errors`);
    assert.equal(source.raw.slice(hit.start, hit.end), expected);
    assert.equal(!!difference, word === 'GewiBheit');
    const forward = source.range(page, hit.start, hit.end);
    assert.equal(forward.start, start);
    assert.equal(forward.end, start + word.length);
  }
});

test('background document mapping retains page font highlights alongside text differences', async () => {
  const api = engine();
  const text = 'Und endlich kommt er doch. Wie Kinder unter dem großen Himmelssaal.';
  const later = 'Another independent passage follows on the next page with enough context.';
  const pdf = { numPages: 2, getPage: async number => ({ getTextContent: async () => ({ items: [{
    str: number === 1 ? text : later, transform: [1, 0, 0, 1, 0, 100], height: 12, width: 400
  }] }) }) };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const index = new api.PdfConnections(locator, '<p>' + text.replace('Kinder', '<i>Kinder</i>').replace('endlich', '<b>endlich</b>').replace('unter', 'untex')
    + '</p><p>' + later + '</p>');
  const page = new api.PdfConnections(locator, text);
  page.parts = [{ start: 0, end: page.raw.length, font: { italic: false, bold: false } }];
  index.remember(0, text.length, page, { start: 0, end: page.raw.length });
  const documentModel = new FixtureDocument({ model: { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) } }), model = documentModel.model;
  const marks = targets => sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: targets.flatMap(target =>
    (index.byTarget.get(target) || []).map(connection => [connection, target])) }), true, true, undefined, documentModel);
  assert.equal(marks([page]).filter(mark => mark.options.description === 'PDF font difference').length, 2);
  const full = await locator.indexDocument(pdf);
  for (let refresh = 0; refresh < 2; refresh++) {
    index?.connect([page, full], pdf);
    const refreshed = marks([page, full]);
    assert.ok(refreshed.some(mark => mark.options.description === 'PDF OCR text difference'));
    assert.equal(refreshed.filter(mark => mark.options.description === 'PDF font difference').length, 2,
      'the text-only document mapping must not discard the page font mapping');
  }
});

test('locator cancels obsolete extraction and keeps document caches per reader', async () => {
  const api = engine();
  let current = true, reads = 0;
  const pdf = { numPages: 1, async getPage() {
    reads++;
    return { async getTextContent() { return { items: [] }; } };
  } };
  const locator = new api.PdfLocator({}, {
    isCurrent: () => current, waitForIdle: async () => { current = false; }
  });
  assert.equal(await locator.indexDocument(pdf), null);
  assert.equal(reads, 0, 'a replaced PDF is not extracted after the idle wait');
  assert.equal(locator.getDocumentIndex(pdf), undefined);
  current = true;
  const other = new api.PdfLocator({}, { isCurrent: () => current, waitForIdle: async () => {} });
  const full = await other.indexDocument(pdf);
  assert.ok(full);
  assert.equal(full, other.getDocumentIndex(pdf), 'document extraction returns the published class cache');
  assert.equal(await other.indexDocument(pdf), full, 'cache hits return the same document index');
  assert.equal(reads, 1);
  assert.equal(locator.getDocumentIndex(pdf), undefined, 'another reader cannot populate this cache');
});

test('source/PDF pairs reuse one snapshot and rebuild all mappings after edits', () => {
  const api = engine();
  const firstPdf = {}, secondPdf = {};
  let pdf = firstPdf, source = '<p>First independent passage with enough unchanged words for mapping.</p>', version = 1;
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf });
  const documentModel = new FixtureDocument({ model: { getValue: () => source, getVersionId: () => version } }), model = documentModel.model;
  const target = new api.PdfConnections(locator, 'First independent passage with enough unchanged words for mapping.');
  const before = locator.editorSourceIndex(documentModel);
  assert.ok(before instanceof api.PdfConnections);
  assert.equal(before.source, source);
  before?.connect([target], pdf);
  assert.ok(before.byTarget.get(target).length);
  assert.equal(locator.editorSourceIndex(documentModel), before);
  pdf = secondPdf;
  assert.notEqual(locator.editorSourceIndex(documentModel), before, 'PDF switches have independent owners');
  pdf = firstPdf;
  assert.equal(locator.editorSourceIndex(documentModel), before);
  source = source.replace('<p>', '<p><b>').replace('</p>', '</b></p>'); version++; documentModel.update(documentModel.content);
  const after = locator.editorSourceIndex(documentModel);
  assert.notEqual(after, before);
  assert.equal(after.byTarget.get(target), undefined, 'markup edits invalidate mappings too');
  after?.connect([target], pdf);
  assert.ok(after.byTarget.get(target).length);
  assert.equal(after.formats[0].bold, true);
  assert.equal(locator.editorSourceIndex(documentModel), after, 'all consumers share the rebuilt snapshot');
});

test('ME23-109 regression: a repeated phrase does not turn an extra letter into missing text', async () => {
  const api = engine(), numbers = [1, 2], phrase = 'separate descriptions of price or';
  const body = 'The second object may be represented by different quantities of metals and therefore has several '
    + phrase + '\nappears alongside other descriptions that serve the same mathematical purpose. '
    + 'Later the text explains also why several measures are needed in force at the same time, and gives separate descriptions of price in silver.';
  const next = 'Another paragraph begins on the next page and describes a single unit of account.';
  const notes = ['A footnote explains the first example.', 'The second footnote identifies its source.'];
  const pdf = { getPage: async n => ({ getTextContent: async () => ({
    items: [[body, next][n - 1], notes[n - 1]].map((str, i) => ({
      str, height: 9, width: 400, transform: [9, 0, 0, 9, 20, 200 - i * 30], hasEOL: true
    }))
  }) }) };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getPdf: () => pdf, getSourcePages: () => numbers, isCurrent: () => true, waitForIdle: async () => {} });
  const edited = 'separeate descriptions of price or';
  const html = body.replace(phrase, edited).replace('\nappears', ' apzpears');
  const index = new api.PdfConnections(locator, '<p>' + html + '</p><p>' + next + '</p><aside><p>' + notes.join('</p><p>') + '</p></aside>');
  const full = await locator.indexDocument(pdf, numbers);
  const { items } = index.getDifferences();
  assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf, !!item.missing]),
    [['e', '', false], ['z', '', false]]);
  const at = full.raw.indexOf(phrase), hit = index.range(full, at, at + phrase.length, true);
  assert.ok(hit);
  assert.equal(index.raw.slice(hit.start, hit.end), edited);
});

test('MEW_BRIEF/23/ME23-316 prepares reusable mappings across five actual OCR pages', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me23.json', import.meta.url), 'utf8'));
  const api = engine();
  const pdf = { numPages: fixture.pages.length, async getPage(n) {
    return { getTextContent: async () => ({ items: fixture.pages[n - 1].items }) };
  } };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const source = new api.PdfConnections(locator, fixture.html);
  const full = await locator.indexDocument(pdf, fixture.pages.map((_, i) => i + 1));
  for (const page of full.pages) for (const part of page.parts)
    assert.equal(full.raw.slice(part.start, part.end), part.item.str, 'page-local construction keeps global item offsets');
  source.connect([full]);
  const connections = source.targetConnections(full);
  assert.ok(connections.length >= 8, 'footnote ordering must not discard independently validated passages');
  source.connect([full]);
  assert.equal(source.targetConnections(full), connections, 'review initialization reuses prepared mappings');
  const touchedPages = new Set();
  let changed = 0, probes = 0;
  for (const item of connections) {
    const ranges = source.compare(item).parts;
    for (const [position, span] of ranges.entries()) {
      if (span.html.length && span.pdf.length) {
        const start = item.start + span.start + (span.changed ? 0 : Math.floor(span.html.length / 2));
        const end = span.changed ? item.start + span.end : start + 1;
        const hit = source.range(full, start, end, false, item);
        assert.ok(hit);
        const insertions = (parts, offset) => parts.filter(part =>
          part.start === offset && part.end === offset && api.significantText(part.pdf)).map(part => part.pdf).join('');
        const before = insertions(ranges.slice(0, position), start - item.start);
        const after = insertions(ranges.slice(position + 1), end - item.start);
        assert.equal(api.significantText(full.raw.slice(hit.start, hit.end)),
          api.significantText(before + (span.changed ? span.pdf : source.raw.slice(start, end)) + after));
        const reverse = source.range(full, hit.start, hit.end, true, item);
        assert.ok(reverse.start <= start && reverse.end >= end, 'reverse selections include touching HTML-only text');
        const roundTrip = source.range(full, reverse.start, reverse.end, false, item);
        assert.equal(roundTrip.start, hit.start); assert.equal(roundTrip.end, hit.end);
        for (const page of full.pages) if (hit.start < page.end && hit.end > page.start) touchedPages.add(fixture.pages[page.number - 1].number);
        changed += Number(span.changed); probes++;
      }
    }
  }
  assert.equal(touchedPages.size, 5); assert.ok(changed > 0); assert.ok(probes > 20);
});

test('long multi-page passages retain OCR mappings beyond the whole-range edit limit', () => {
  const api = engine(), locator = new api.PdfLocator();
  let seed = 29;
  const raw = Array.from({ length: 20000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(97 + seed % 26);
  }).join('');
  const positions = Array.from({ length: 300 }, (_, i) => i * 64 + 48);
  const changed = [...raw]; for (const at of positions) changed[at] = '7';
  const index = raw => (new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw, normalized: api.normalized(raw), }));
  const source = index(raw), target = index(changed.join(''));
  source.connect(target);
  assert.ok(source.byTarget.get(target).length > 1, 'bounded groups survive more than 128 total OCR edits');
  for (const at of positions) {
    const hit = source.range(target, at, at + 1);
    assert.ok(hit, `missing mapping at ${at}`);
    assert.equal(target.raw.slice(hit.start, hit.end), '7');
    const reverse = source.range(target, hit.start, hit.end, true);
    assert.equal(reverse.start, at); assert.equal(reverse.end, at + 1);
  }
});

test('local highlight hunks separate OCR boundary spaces', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = 'aft der\n' + 'x'.repeat(100), target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: 'äft  der\n' + 'y'.repeat(100) });
  const index = new api.PdfConnections(locator, source);
  const connection = { start: 0, end: source.length, targetStart: 0, targetEnd: target.raw.length };
  index.byTarget.set(target, [connection]);
  const parts = index.compare(target, connection).parts;
  assert.deepEqual(Array.from(parts.slice(0, 4), part => [part.html, part.pdf, part.changed]),
    [['a', 'ä', true], ['ft ', 'ft ', false], ['', ' ', true], ['der\n', 'der\n', false]]);
  const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
  assert.deepEqual({ ...items[0].comparison }, { html: 'a', pdf: 'ä' });
  assert.equal(api.applyTextEdits(source, items[0].options[0].edits), source.replace('aft', 'äft'));
  const hit = index.range(target, 0, 3, false, connection, true);
  assert.equal(target.raw.slice(hit.start, hit.end), 'äft', 'click excludes the following space insertion');
});

test('an over-budget page comparison does not highlight or replace the whole passage', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const lines = Array.from({ length: 150 }, (_, i) => `Passage ${i} contains matching words.`);
  const index = new api.PdfConnections(locator, lines.join(' '));
  const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: lines.join('\n').replace('Passage 5', 'Passage X') });
  const broad = index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  assert.ok(broad, 'normalized text still confirms the page mapping');
  const end = index.raw.indexOf('Passage 10'), targetEnd = target.raw.indexOf('Passage 10');
  const local = index.remember(0, end, target, { start: 0, end: targetEnd });
  assert.ok(api.differences(index, target, local).text.length, 'confirmed local changes remain available');
  assert.equal(api.differences(index, target, broad).text.length, 0, 'failed traceback supplies no discrepancy spans');
  assert.equal(index.range(target, 0, index.raw.length, false, broad, true), null,
    'failed traceback cannot map a discrepancy to the entire PDF page');
  const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
  assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]), [['5', 'X']]);
});

test('ME04-608 wrapped prose stays aligned across blank-line anchors', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const paragraph = "<p><i>Born</i> stattet Bericht ab über die Versammlung im Café l'Europe; ebenso <i>Sterbitzki</i>. Mit großer Mehrzahl beschlossen, nicht in dieses Café zu gehn, wo Decker und Venedey eine Versammlung halten.</p>";
  const pdf = "Born stattet Bericht ab über die Versammlung im Cafe l'Europe; ebenso\n\nSterhitzki' Mit großer Mehrzahl beschlossen, nicht in dieses Cafe zu gehn,\nwo Decker und Venedey eine Versammlung halten.\nEngler, Buchfink und Vogler (Weitlingianer) aufgenommen einstimmig.\n";
  for (const newline of ['\r\n', '\n']) {
    const html = paragraph + newline + '<p>Engler, Buchfink und Vogler (Weitlingianer) aufgenommen einstimmig.</p>';
    const index = locator.editorSourceIndex(new FixtureDocument({ model: { getValue: () => html, getVersionId: () => 1 } }));
    const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: pdf });
    index.remember(0, index.raw.length, target, { start: 0, end: pdf.length });
    const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]),
      [['é', 'e'], ['b', 'h'], ['.', "'"], ['é', 'e']]);
    assert.equal(api.applyTextEdits(html, items.flatMap(item => item.options[0].edits)),
      html.replaceAll('Café', 'Cafe').replace('Sterbitzki</i>.', "Sterhitzki</i>'"));
  }
});

test('bounded local anchor checks reject impossible lengths and count Unicode code points', () => {
  const api = engine();
  const left = 'a'.repeat(80), right = 'b'.repeat(577854);
  assert.equal(api.textDiff(left, right, false, 12).distance, 13);
  const rejected = api.textDiff(right, left, true, 12);
  assert.equal(rejected.distance, 13);
  assert.deepEqual(Array.from(rejected.parts, part => [part.html, part.pdf, part.changed]), [[right, left, true]]);
  assert.equal(api.textDiff('a', 'a𠀀', false, 1).distance, 1);
  assert.equal(api.textDiff('a', 'ab', false, 1).distance, 1);
  const unbounded = api.textDiff('a', 'abc', true);
  assert.equal(unbounded.parts.map(part => part.pdf).join(''), 'abc');
});

test('local wavefront preserves bounded distances and traceback at short sequence edges', () => {
  const window = {};
  vm.runInNewContext(engineSource + '\nwindow.localDiff = localTextDiff;', { window });
  const values = ['', 'a', 'b', '𠀀', 'aa', 'ab', 'ba', 'a𠀀', '𠀀b'];
  for (const left of values) for (const right of values) for (const substitutions of [false, true]) {
    const a = [...left], b = [...right];
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1,
        row[j] + (a[i] === b[j] ? 0 : substitutions ? 1 : 2)));
      row = next;
    }
    for (const limit of [0, 1, 2, Infinity]) for (const details of [false, true]) {
      const diff = window.localDiff(a, b, details, limit, undefined, substitutions);
      assert.equal(diff.distance, Math.min(row[b.length], Math.min(limit, Math.max(a.length, b.length)) + 1));
      if (!details) continue;
      assert.equal(diff.parts.map(part => part.html).join(''), left);
      assert.equal(diff.parts.map(part => part.pdf).join(''), right);
      assert.ok(diff.parts.every(part => part.changed || part.html === part.pdf));
    }
  }
});

test('local diff preserves complete Unicode readings and maps source positions in both directions', () => {
  const api = engine();
  for (const [left, right] of [
    ['First line\nwork together\n中文𠀀 last', 'First line\nworks together\n中文𠀀 last'],
    ['a𠀀b', 'a𠀁b'], ['before\nend', 'before\nextra\nend'], ['', 'added'], ['deleted', ''],
    ['Die Straße', 'Die Strasse'], ['line\r\nnext', 'line\r\nnew next']
  ]) {
    const diff = api.textDiff(left, right, true);
    assert.equal(diff.parts.map(part => part.html).join(''), left);
    assert.equal(diff.parts.map(part => part.pdf).join(''), right);
    assert.equal(diff.distance, api.textDiff(left, right).distance);
    for (const part of diff.parts) if (!part.changed) assert.equal(part.html, part.pdf);
  }
  const normalized = api.normalized;
  const index = raw => (new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw, normalized: normalized(raw) }));
  const left = index('Before working together after.'), right = index('Before working nicely together after.');
  left.remember(0, left.raw.length, right, { start: 0, end: right.raw.length });
  const word = left.raw.indexOf('together'), mapped = left.range(right, word, word + 8);
  assert.equal(right.raw.slice(mapped.start, mapped.end), 'nicely together');
  const reverse = left.range(right, mapped.start, mapped.end, true);
  assert.equal(left.raw.slice(reverse.start, reverse.end), 'together');
});

test('native decorations split changes around tags, map entities, and mark missing HTML text', () => {
  const api = engine(), provider = reviewProvider(api);
  assert.equal(api.textDiff('a', 'b', true).parts[0].changed, true);
  assert.deepEqual([...new api.PdfConnections(new api.PdfLocator(), { raw: '' }).sourceDecorations([], true, true, undefined, {})], []);
  const markup = '<p>a<b>X</b>&amp;𠀀Z</p>', raw = 'aX&𠀀Z';
  const starts = [3, 7, 12, 17, 18, 19], ends = [4, 8, 17, 18, 19, 20];
  const index = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw, starts, ends }), target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: 'aY!𠀀Z+' });
  const connection = { start: 0, end: raw.length, targetStart: 0, targetEnd: target.raw.length };
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const hover = item => provider.sourceHover(item, model);
  const decorations = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [target], connections: [[connection, target]] }), true, true, hover, documentModel);
  const ranges = decorations.map(({ range }) => markup.slice(range.startColumn - 1, range.endColumn - 1));
  assert.deepEqual([...ranges], ['X', '&amp;', '']);
  assert.ok(decorations.every(item => !('linesDecorationsClassName' in item.options) && !('linesDecorationsTooltip' in item.options)),
    'source decorations omit unused gutter marks at creation');
  assert.equal(decorations.at(-1).options.before?.inlineClassName, 'mew-ocr-diff-insert');
  assert.equal(decorations.at(-1).range.startColumn, 21, 'trailing insertion is anchored before the closing tag');
  assert.match(decorations.at(-1).options.hoverMessage.value, /PDF:.*\+/);
  const saved = connection.editorDiff;
  assert.equal(index.compare(target, connection), saved, 'direct index comparisons reuse the editor diff');
  sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [[connection, target]] }), true, true, undefined, documentModel);
  assert.equal(connection.editorDiff, saved);
  assert.equal(api.textDiff('a', 'b', true).parts[0].changed, true);
  assert.deepEqual([...sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [target], connections: [[{ ...connection, editorDiff: null }, target]] }), true, true, hover, documentModel)], [...decorations]);
  assert.deepEqual([...sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [target], connections: [[connection, target]] }), true, true, hover, documentModel)], [...decorations]);
});

test('ME04-004 quote markers exclude matching paragraphs, PDF wrapping and the footnote', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me04.json', import.meta.url), 'utf8'));
  const api = engine();
  const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: fixture.layerRaw, parts: [] }), pdf = {};
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getVisiblePages: () => [{ number: 20, index: target }] });
  Object.assign(target, { normalized: api.normalized(target.raw) });
  const documentModel = new FixtureDocument({ model: { getValue: () => fixture.html, getVersionId: () => 1,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const index = locator.editorSourceIndex(documentModel);
  index.connect(target);
  const connections = (index.byTarget.get(target) || []).map(connection => [connection, target]);
  const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: connections }), true, true, undefined, documentModel);
  const quote = fixture.html.indexOf('entwickeln.') + 'entwickeln.'.length;
  const mark = marks.find(({ range }) => range.startColumn - 1 <= quote && range.endColumn - 1 > quote);
  assert.equal(mark, undefined, 'normalized quote shapes are not reported as text differences');
  const start = index.raw.indexOf('entwickeln.') + 'entwickeln.'.length;
  const [location] = locator.findLocations(pdf, [{ index, marked: true, start, end: start + 1,
    text: '“', before: index.raw.slice(start - 160, start), after: index.raw.slice(start + 1, start + 161) }]);
  assert.equal(location.targets.length, 1);
  assert.equal(location.targets[0].difference.html, '“');
  assert.equal(location.targets[0].difference.pdf, '"');
  const { focusHit } = locator.locateLayer(target, [], location.targets);
  assert.equal(target.raw.slice(focusHit.start, focusHit.end), '"');
  for (const { range } of marks) {
    const text = fixture.html.slice(range.startColumn - 1, range.endColumn - 1);
    assert.doesNotMatch(text, /Kinder|Herzen|Gemeinschaft|entwickeln|Haschen|>1</,
      'matching words and the footnote must not receive difference markers');
  }
});

test('ME04-117 case-only differences survive selection mapping in both directions', () => {
  const html = '<p>Ein sozialer Vorteil, gleich 400, stellt für das Individuum, wenn die Gesellschaft nur aus einer Million Menschen besteht, <sup>4</sup>/<sub>10000</sub> dar.</p>';
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, html);
  const start = index.raw.indexOf('Gesellschaft nur') + 'Gesellsc'.length;
  const target = new api.PdfConnections(locator, index.raw.slice(0, start) + 'H' + index.raw.slice(start + 1));
  index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  for (const reverse of [false, true]) {
    const hit = index.range(target, start, start + 1, reverse);
    assert.equal(hit.start, start);
    assert.equal(hit.end, start + 1);
    assert.equal(hit.approximate, true, 'case folding for locating must not erase a text difference');
  }
  const { difference } = locator.locateSource(index, [{ index: target, start, end: start + 1 }]);
  assert.equal(difference.html, 'h');
  assert.equal(difference.pdf, 'H');
});

test('ME07-073 and ME07-074 alignment excludes neighboring pages and preserves the final punctuation', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me07-073-074.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) for (const lf of [false, true]) {
    const api = engine();
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
      isCurrent: () => true, waitForIdle: async () => {} });
    const pdf = { numPages: fixture.pages.length, getPage: async n => ({
      getTextContent: async () => ({ items: [{ str: fixture.pages[n - 1],
        transform: [1, 0, 0, 1, 0, 100], width: 100, height: 10 }] })
    }) };
    const html = lf ? fixture.html.replace(/\r\n/g, '\n') : fixture.html;
    const index = new api.PdfConnections(locator, html), pages = fixture.pages.map(raw => new api.PdfConnections(locator, raw));
    index?.connect(pages, pdf);
    const before = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: pages }).map(item => item.comparison);
    const full = await locator.indexDocument(pdf);
    index?.connect(pages, pdf);
    const after = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [...pages, full] }).map(item => item.comparison);
    assert.deepEqual(after, before, 'background alignment must not add neighboring text or delete final punctuation');
    const page = full.pages[fixture.number - 72];
    for (const connection of index.byTarget.get(full) || []) {
      assert.equal(full.raw.slice(connection.targetStart, Math.max(connection.targetStart, page.start)).trim(), '',
        'previous page content stays outside the mapping');
      assert.equal(full.raw.slice(Math.min(connection.targetEnd, page.end), connection.targetEnd).trim(), '',
        'next page content stays outside the mapping');
    }
    const word = fixture.number === 73 ? 'Taten!' : 'Clichy!';
    const start = index.raw.indexOf(word);
    const hit = index.range(full, start, start + word.length, false, undefined, true);
    assert.ok(hit);
    assert.equal(full.raw.slice(hit.start, hit.end), word, 'final footnote punctuation survives alignment');
    const reverse = index.range(full, hit.start, hit.end, true);
    assert.equal(index.raw.slice(reverse.start, reverse.end), word, 'reverse selection uses the same boundary');
  }
});

test('ME07-066 missing page-end text maps before whole-document indexing', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me07-066.json', import.meta.url), 'utf8'));
  for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const api = engine();
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = new api.PdfConnections(locator, html), target = new api.PdfConnections(locator, fixture.layerRaw);
    const pdf = {};
    index?.connect([target], pdf);
    assert.equal(locator.getDocumentIndex(pdf), undefined, 'only the visible page is available');
    const item = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }).find(item => item.comparison.pdf.includes('Delegierten'));
    assert.ok(item, 'the missing word is highlighted without waiting for the full PDF');
    assert.equal(item.sourceStart, item.sourceEnd, 'HTML has an insertion point, not selectable text');
    assert.equal(item.comparison.html, '');
    const hit = index.range(target, item.sourceStart, item.sourceEnd, false, undefined, true);
    assert.ok(hit, 'the same page mapping supplies the popup anchor');
    assert.equal(target.raw.slice(hit.start, hit.end).trim(), 'Delegierten');
    const edit = item.options[0].edits[0];
    assert.equal(edit.start, edit.end);
    assert.match(api.applyTextEdits(html, [edit]), /Montagne und Delegierten\s+der geheimen/);
  }
});

test('ME04-117 adjacent-page quotations cannot override a complete page mapping', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me04-117.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getTargets: () => pages });
  const index = new api.PdfConnections(locator, fixture.html);
  const pages = fixture.pages.map(page => new api.PdfConnections(locator, page.raw));
  index?.connect(pages, {});
  // Font metadata can rebuild just the adjacent layer after the first preparation.
  pages[1] = new api.PdfConnections(locator, fixture.pages[1].raw);
  index?.connect([pages[1]], {});
  const connections = pages.flatMap(page => (index.byTarget.get(page) || []).map(connection => [connection, page]));
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: connections }), true, true, undefined, documentModel);
  const at = fixture.html.indexOf('Gesellschaft nur') + 8;
  assert.ok(!marks.some(({ range }) => range.startColumn - 1 <= at && range.endColumn - 1 > at),
    'the uppercase H in the next page quotation is not a difference in this page');
  assert.ok(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: pages }).some(item => /ooo/.test(item.comparison?.pdf)), 'actual OCR differences remain reviewable');
});

test('ME17-463/464 discard prepared font mappings to a shorter adjacent-page quotation', () => {
  const quote = 'Ein Delegierter oder mehrere Delegierte werden in den Generalrat entsandt';
  for (const italic of [false, true]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = new api.PdfConnections(locator, `<p>Der Generalrat erklärte seinen Beschluß zu den Statuten.</p><p>${italic ? '<i>' + quote + '</i>' : quote}</p><p>Die Sektion antwortet auf diesen Beschluß.</p>`);
    const page = (raw, italic) => new api.PdfConnections(locator, {
      raw, parts: [{ start: 0, end: raw.length, font: { italic, bold: false } }]
    });
    const adjacent = page(quote, !italic), own = page(index.raw, italic), pdf = {};
    own.parts = index.formats.map((font, start) => ({ start, end: start + 1,
      font: { italic: font.italic, bold: font.bold } }));
    index?.connect([adjacent], pdf);
    assert.ok(reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [adjacent].filter(Boolean).flatMap(target => index.connections.get(target)?.preparedRanges || index.connections.get(target)?.ranges || []) }).length,
      'the repeated quotation initially maps to the adjacent page with different formatting');
    index.remember(0, index.raw.length, own, { start: 0, end: own.raw.length });
    index.scopes.set(own, { prepared: true, connections: index.byTarget.get(own) });
    index?.connect([adjacent, own], pdf);
    assert.deepEqual(index.scopes.get(adjacent).connections, index.byTarget.get(adjacent),
      'superseded quotations must also leave the prepared highlight snapshot');
    assert.equal(reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [adjacent, own].filter(Boolean).flatMap(target => index.connections.get(target)?.preparedRanges || index.connections.get(target)?.ranges || []) }).length, 0);
  }
});

test('ME04-037 keeps the matching heading out of deletion/reinsertion markers', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me04-037.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const index = new api.PdfConnections(locator, html), target = new api.PdfConnections(locator, fixture.layerRaw);
    index.connect(target);
    const connections = (index.byTarget.get(target) || []).map(connection => [connection, target]);
    assert.ok(connections.length);
    const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
    const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: connections }), true, true, undefined, documentModel);
    const start = html.indexOf('[Erklärung', html.indexOf('<h1>'));
    const end = start + '[Erklärung gegen Karl Grün'.length;
    assert.ok(marks.length, 'actual OCR differences still receive markers');
    for (const { range } of marks) {
      assert.ok(range.endColumn - 1 <= start || range.startColumn - 1 >= end,
        'the matching heading must not be marked as deleted');
      assert.doesNotMatch(html.slice(range.startColumn - 1, range.endColumn - 1), /<\/?h1>/,
        'the closing heading tag must not be highlighted');
    }
    const connection = connections[0][0];
    assert.equal(connection.editorDiff.parts.map(part => part.html).join(''), index.raw.slice(connection.start, connection.end));
    assert.equal(connection.editorDiff.parts.map(part => part.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
    const at = index.raw.indexOf('Erklärung');
    const hit = index.range(target, at, at + 'Erklärung'.length, false, connection, true);
    assert.equal(target.raw.slice(hit.start, hit.end), 'Erklärung', 'click mapping shares the refined alignment');
  }
});

test('ME32-169 word-ending noise maps past an overlapping connection ending at its insertion', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, '<p>durch ihre Organisation einen Hinterhalt gewähren.</p><p>Dein</p>');
  const target = new api.PdfConnections(locator, { raw: 'durch ihre Organisation einen Hinterhalt gewähren.,  , <\nDein', parts: [] });
  const at = index.raw.indexOf('gewähren.') + 'gewähren.'.length, end = target.raw.indexOf(',  , <');
  index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  index.remember(0, at, target, { start: 0, end });
  const item = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }).find(item => item.sourceStart === at);
  assert.ok(item && item.sourceEnd === at, 'the extra OCR noise has an HTML insertion marker');
  const hit = index.range(target, at, at, false, undefined, true);
  assert.ok(hit, 'the insertion uses the overlapping connection that contains its diff');
  assert.equal(target.raw.slice(hit.start, hit.end), ',  , <');
  assert.equal(index.range(target, at, at, false, index.byTarget.get(target)[0], true), null,
    'an explicitly supplied connection still limits lookup to its own diff');
});

test('ME07-261 missing prefixes use a caret before the term and retain their click mapping', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  for (const gap of [' ', '\n', '\r\n ', '\t']) {
    const html = `<p>Folgerung${gap}schließt</p>`, pdf = 'Folgerung\nanschließt';
    const index = new api.PdfConnections(locator, html), target = new api.PdfConnections(locator, pdf);
    index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
    const connections = index.byTarget.get(target).map(connection => [connection, target]);
    const [mark, ...extra] = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: connections }), true, true, undefined, documentModel);
    assert.equal(extra.length, 0);
    assert.ok(mark, 'whitespace-only HTML changes must still mark missing PDF letters');
    const [item] = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    assert.equal(mark.range.startColumn, html.indexOf('schließt') + 1);
    assert.equal(html.slice(mark.range.startColumn - 1, mark.range.endColumn - 1), '');
    assert.equal(mark.options.before?.inlineClassName, 'mew-ocr-diff-insert');
    assert.equal(mark.options.inlineClassName, undefined);
    const at = index.raw.indexOf('schließt');
    const hit = index.range(target, at, at, false, undefined, true);
    assert.ok(hit, 'clicking the insertion caret maps back to the missing letters');
    assert.equal(target.raw.slice(hit.start, hit.end).trim(), 'an');
    const anchor = api.lowerBound(index.ends, mark.range.startColumn);
    const end = api.lowerBound(index.starts, mark.range.endColumn - 1);
    const clicked = index.range(target, anchor, end, false, undefined, true);
    assert.equal(target.raw.slice(clicked.start, clicked.end).trim(), 'an', 'the insertion start maps to the same missing letters');
    if (gap === ' ') assert.equal(index.range(target, at, at), null,
      'ordinary caret does not select whitespace-adjacent changes');
    const patched = api.applyTextEdits(html, item.options[0].edits);
    assert.equal(patched, '<p>Folgerung\nanschließt</p>', 'replacement consumes the original whitespace exactly once');
  }
});

test('space markers cover only changed spaces while prefixes use carets without changing replacement ranges', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({
    set innerHTML(text) { this.content = { textContent: text === '&nbsp;' ? '\u00a0' : text }; }
  }) } });
  for (const [html, pdf, space] of [
    ['So wenig', 'So’wenig', 2], ['So wenig', 'SoX wenig', null],
    ['So wenig', 'So Xwenig', null], ['So&nbsp;wenig', 'So’wenig', 2],
    ['Sowenig', 'SoXwenig', null]
  ]) {
    const markup = '<p>' + html + '</p>', index = new api.PdfConnections(locator, markup), target = new api.PdfConnections(locator, pdf);
    index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
    const [mark] = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [target].filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || []) }), true, true, undefined, new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }));
    const insertion = pdf === 'SoX wenig' ? markup.indexOf(' wenig') : markup.indexOf('wenig');
    assert.equal(mark.range.startColumn - 1, space === null ? insertion : index.starts[space]);
    assert.equal(mark.range.endColumn - 1, space === null ? insertion : index.ends[space]);
    assert.equal(mark.options.before?.inlineClassName, space === null ? 'mew-ocr-diff-insert' : undefined);
    const from = { start: api.lowerBound(index.ends, mark.range.startColumn),
      end: api.lowerBound(index.starts, mark.range.endColumn - 1) };
    const hit = index.range(target, from.start, from.end, false, undefined, true);
    assert.ok(hit?.approximate, 'the highlighted space still reaches the actual difference');
    const [item] = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    assert.equal(api.applyTextEdits(markup, item.options[0].edits), '<p>' + pdf + '</p>');
  }
});

test('ME07-316 missing heading text marks the insertion before the closing tag and remains clickable', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me07-316.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, fixture.html), target = new api.PdfConnections(locator, fixture.layerRaw);
  index?.connect([target], {});
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: index.byTarget.get(target).map(connection => [connection, target]) }), true, true, undefined, documentModel);
  const marker = marks.find(mark => mark.options.before?.inlineClassName === 'mew-ocr-diff-insert');
  const offset = marker.range.startColumn - 1;
  assert.equal(offset, fixture.html.indexOf('</h1>'));
  const at = api.lowerBound(index.ends, offset + 1);
  const hit = index.range(target, at, at, false, undefined, true);
  assert.equal(target.raw.slice(hit.start, hit.end), '12763');
  const item = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }).find(item => item.comparison.pdf === '12763');
  assert.equal(item.options[0].edits[0].start, offset);
  assert.equal(api.applyTextEdits(fixture.html, item.options[0].edits), fixture.html.replace('</h1>', '12763</h1>'));
});

test('source decorations ignore whitespace and hyphens while preserving subsequent character offsets', () => {
  const api = engine();
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const decorate = (raw, pdf) => {
    const index = new api.PdfConnections(new api.PdfLocator(), { raw, model,
      starts: Array.from({ length: raw.length }, (_, i) => i),
      ends: Array.from({ length: raw.length }, (_, i) => i + 1) });
    return sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [[{ start: 0, end: raw.length, targetStart: 0, targetEnd: pdf.length }, { raw: pdf }]] }));
  };
  for (const [html, pdf] of [
    ['word word', 'wordword'], ['wordword', 'word word'],
    ['word  word', 'word word'], ['word\tword', 'word word'],
    ['word\nword', 'word word'], ['word\u00a0word', 'word word'],
    [' word ', 'word'], ['word-word', 'wordword'], ['wordword', 'word-word'],
    ['word\u2010word', 'word-word'], ['word\u2011word', 'wordword'],
    ['word\u00adword', 'wordword'], ['word-\nword', 'wordword']
  ]) assert.equal(decorate(html, pdf).length, 0, JSON.stringify([html, pdf]));
  const html = 'word  word X end', pdf = 'word word Y end';
  const decorations = decorate(html, pdf);
  assert.deepEqual([...decorations.map(({ range }) => html.slice(range.startColumn - 1, range.endColumn - 1))], ['X']);
  const withHyphen = decorate('word- word X end', 'word word Y end');
  assert.deepEqual([...withHyphen.map(({ range }) => range.startColumn)], [12]);
  for (const [html, pdf, column] of [
    ['wordword', 'word word+', 9], ['wordword', 'word+word', 5],
    ['schöpliche', 'schöpfliche', 6], ['work', 'works', 5],
    ['word', 'sword', 1], ['', 'added', 1], ['a𠀀b', 'a𠀀𠀁b', 4]
  ]) {
    const [mark] = decorate(html, pdf);
    assert.equal(decorate(html, pdf).length, 1, JSON.stringify([html, pdf]));
    assert.equal(mark.range.startColumn, column);
    assert.equal(mark.range.endColumn, column);
    assert.equal(mark.options.before?.inlineClassName, 'mew-ocr-diff-insert');
    assert.equal(mark.options.inlineClassName, undefined);
  }
});

test('selection boundaries include meaningful missing text regardless of character type', () => {
  const api = engine();
  for (const [html, pdf, start, end, expected, at, missing] of [
    ['work', 'works', 0, 4, 'works', 4, 's'],
    ['word', 'sword', 0, 4, 'sword', 0, 's'],
    ['кот', 'коты', 0, 3, 'коты', 3, 'ы'],
    ['cafe', 'cafe\u0301', 0, 4, 'cafe\u0301', 4, '\u0301'],
    ['hello world', 'hello, world', 0, 5, 'hello,', 5, ','],
    ['hello world', 'hello new world', 6, 11, 'new world', 6, 'new '],
    ['中文', '中文字', 0, 2, '中文字', 2, '字'],
    ['work', 'work★', 0, 4, 'work★', 4, '★'],
    ['hello world', 'hello, world', 0, 11, 'hello, world', 5, ','],
    ['中文', '中间文', 0, 2, '中间文', 1, '间']
  ]) {
    const locator = new api.PdfLocator(), index = new api.PdfConnections(locator, { raw: html });
    const target = new api.PdfConnections(locator, { raw: pdf, parts: [] });
    index.remember(0, html.length, target, { start: 0, end: pdf.length });
    const hit = index.range(target, start, end);
    assert.equal(pdf.slice(hit.start, hit.end), expected, JSON.stringify([html, pdf]));
    target.remember(0, pdf.length, index, { start: 0, end: html.length });
    const reverse = target.range(index, start, end, true);
    assert.equal(pdf.slice(reverse.start, reverse.end), expected, 'reverse selections use the same boundary rule');
    const clicked = index.range(target, at, at, false, undefined, true);
    assert.equal(pdf.slice(clicked.start, clicked.end), missing, 'direct marker clicks retain every character type');
  }
});

test('source markers locate local diff changes at word boundaries, inside words and beside repeated characters', () => {
  const api = engine();
  for (const [html, pdf, at, missing] of [
    ['work', 'works', 4, 's'], ['word', 'sword', 0, 's'],
    ['Louis-Philippees den', 'Louis-Philippes\nden', 14, 's\n'],
    ['schöpliche', 'schöpfliche', 5, 'f'], ['a𠀀b', 'a𠀀𠀁b', 3, '𠀁']
  ]) {
    const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: pdf, parts: [] }), pdfDocument = {};
    const locator = new api.PdfLocator({}, { getVisiblePages: () => [{ number: 1, index: target }] });
    const index = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: html, starts: [...Array(html.length).keys()],
      ends: Array.from({ length: html.length }, (_, i) => i + 1),
      normalized: api.normalized(html), });
    target.normalized = api.normalized(pdf);
    index.remember(0, html.length, target, { start: 0, end: pdf.length });
    const end = html.includes('Philippees') ? at + 3 : at;
    const hit = index.range(target, at, end, false, undefined, true);
    assert.equal(pdf.slice(hit.start, hit.end), missing);
    const [location] = locator.findLocations(pdfDocument, [{ index, marked: true, start: at, end, text: html.slice(at, end), before: html.slice(0, at), after: html.slice(end) }]);
    assert.equal(location.targets[0].difference.html, html.slice(at, end));
    assert.equal(location.targets[0].difference.pdf, missing);
    const { focusHit } = locator.locateLayer(target, [], location.targets);
    assert.equal(pdf.slice(focusHit.start, focusHit.end), missing);
    assert.equal(index.range(target, 1, 1), null, 'ordinary carets do not select PDF characters');
  }
});

test('concurrent page extraction is shared across locators and failures can retry', async () => {
  const api = engine();
  let calls = 0;
  const page = { getTextContent: async () => { calls++; return { items: [] }; } };
  const pdf = { numPages: 1, getPage: async () => page };
  const environment = { isCurrent: () => true, waitForIdle: async () => {} };
  await Promise.all([new api.PdfLocator({}, environment).indexDocument(pdf),
    new api.PdfLocator({}, environment).indexDocument(pdf), api.readPageText(page)]);
  assert.equal(calls, 1);
  let attempts = 0;
  const broken = { getTextContent: async () => {
    if (++attempts === 1) throw new Error('temporary failure');
    return { items: [] };
  } };
  await assert.rejects(api.readPageText(broken), /temporary failure/);
  await api.readPageText(broken);
  assert.equal(attempts, 2);
});

test('equal text stays unchanged and batch preview preserves all untouched text', () => {
  const api = engine();
  assert.equal(api.textDiff('same 𠀀', 'same 𠀀', true).parts[0].changed, false);
  const source = 'a𠀀bcdef';
  assert.equal(api.applyTextEdits(source, [{ start: 7, end: 8, text: 'Z' },
    { start: 1, end: 3, text: '&amp;' }, { start: 4, end: 4, text: 'X' }]), 'a&amp;bXcdeZ');
  assert.throws(() => api.applyTextEdits(source, [{ start: 1, end: 4, text: '' },
    { start: 3, end: 5, text: '' }]), /重叠/);
});

test('PDF replacement batches identical patterns and retains different text or formatting targets', () => {
  for (const format of [false, true]) {
    const api = engine(), providers = new Map();
    let source = format ? '<p>Word</p><p>Word</p><p>Word</p><p>Other</p>'
      : '<p>WRONG</p><p>WRONG</p><p>WRONG</p><p>OTHER</p>', version = 1, applications = 0, undoStops = 0;
    const documentModel = new FixtureDocument({ model: { getValue: () => source, getVersionId: () => version,
      getPositionAt: at => ({ lineNumber: 1, column: at + 1 }), getOffsetAt: position => position.column - 1 } }), model = documentModel.model;
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    // These candidates already have confirmed mappings from scanning.
    api.PdfLocator = class { constructor() { return locator; } };
    const index = locator.editorSourceIndex(documentModel);
    const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: format ? index.raw : index.raw.replace('WRONG', 'RIGHT𠀀').replace('WRONG', 'RIGHT𠀀')
      .replace('WRONG', 'DIFFERENT').replace('OTHER', 'RIGHT𠀀'), parts: [] });
    const starts = [...index.raw.matchAll(format ? /Word|Other/g : /WRONG|OTHER/g)].map(match => match.index);
    const items = starts.map((start, at) => {
      const end = start + (format ? at === 3 ? 5 : 4 : 5);
      const font = { italic: at === 2, bold: at !== 2 };
      if (format) target.parts.push({ start, end, font });
      return { id: String(at), sourceStart: start, sourceEnd: end,
        ...(format ? { text: index.raw.slice(start, end), font, htmlFont: index.formats[start] }
          : { comparison: { html: index.raw.slice(start, end), pdf: at === 2 ? 'DIFFERENT' : 'RIGHT𠀀' } }),
        options: [{ id: format ? 'format' : 'pdf', edits: format ? index.fontEdits(start, end, font)
          : index.textEdits(start, end, at === 2 ? 'DIFFERENT' : 'RIGHT𠀀') }] };
    });
    index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
    const editor = { document: documentModel, getModel: () => model, getOption: () => false, pushUndoStop() { undoStops++; },
      executeEdits(origin, edits) {
        applications++;
        for (const edit of [...edits].reverse()) source = source.slice(0, edit.range.startColumn - 1) + edit.text + source.slice(edit.range.endColumn - 1);
        version++; documentModel.update(documentModel.content); return true;
      } };
    let highlighted;
    reviewProvider(api, providers, { showReviewPointer(targetEditor, matches) {
      assert.equal(targetEditor, editor); highlighted = matches;
    } });
    providers.get('pdf-ocr').onSelect(items[1], { editor }, items);
    assert.deepEqual(Array.from(highlighted, item => item.id), ['0', '1'],
      'one popup highlights every matching pattern and excludes other corrections or styles');
    api.PdfConnections.prototype.candidates = () => { throw new Error('incremental replacement must preserve existing candidates'); };
    const result = providers.get('pdf-ocr').apply({ editor, model, source, version, item: items[1], items, position: 1,
      choices: new Map(items.map(item => [item.id, item.options[0].id])), context: { model, index, targets: [target] } }, false);
    assert.equal(source, format ? '<p><b>Word</b></p><p><b>Word</b></p><p>Word</p><p>Other</p>'
      : '<p>RIGHT𠀀</p><p>RIGHT𠀀</p><p>WRONG</p><p>OTHER</p>');
    assert.deepEqual(Array.from(result.items, item => item.comparison?.pdf || item.text),
      format ? ['Word', 'Other'] : ['DIFFERENT', 'RIGHT𠀀']);
    assert.equal(result.items[0].comparison, items[2].comparison, 'original comparison and grouping survive');
    assert.equal(result.items[0].pdfSource.index, result.context.index, 'candidate uses the current source mapping');
    assert.equal(result.position, 0, 'matching candidates before the current item are also removed');
    assert.equal(applications, 1);
    assert.equal(undoStops, 2, 'the entire batch uses one undo group');
    const next = result.items[0].options[0].edits[0];
    assert.equal(source.slice(next.start, next.end), next.expected, 'remaining edits use the current source');
    assert.equal(result.context.index.source, source);
    for (const candidate of result.items) for (const option of candidate.options) api.validateEdits(source, option.edits);
    const nextResult = providers.get('pdf-ocr').apply({ editor, model, source, version, item: result.items[result.position], items: result.items,
      position: result.position, choices: result.choices, context: result.context }, false);
    for (const candidate of nextResult.items) for (const option of candidate.options) api.validateEdits(source, option.edits);
    assert.equal(nextResult.context.index.source, source, 'consecutive replacements keep candidates on the current source');
  }
});

test('compact review keeps distant differences without computing a second diff', () => {
  const api = engine(), providers = new Map();
  let calls = 0;
  const diff = api.textDiff;
  api.textDiff = (...args) => { calls++; return diff(...args); };
  reviewProvider(api, providers);
  const prefix = 'prefix '.repeat(12), middle = ' unchanged '.repeat(20), suffix = ' suffix'.repeat(12);
  const item = { id: 'one', options: [{ id: 'pdf', edits: [] }],
    comparison: { html: prefix + 'WRONG' + middle + 'BAD' + suffix,
      pdf: prefix + 'RIGHT' + middle + 'GOOD' + suffix } };
  const content = providers.get('pdf-ocr').content({ items: [item], choices: new Map([['one', 'pdf']]) }, item);
  const html = content.comparison[0].parts.map(part => part.text).join('');
  const pdf = content.comparison[1].parts.map(part => part.text).join('');
  assert.ok(html.includes('WRONG' + middle + 'BAD'));
  assert.ok(pdf.includes('RIGHT' + middle + 'GOOD'));
  assert.ok(html.startsWith('…') && html.endsWith('…'));
  assert.equal(calls, 1);
  const value = item.comparison;
  assert.equal(api.comparisonRows(value), content.comparison, 'compact rows reuse the prepared result');
  const full = api.comparisonRows(value, false), missing = api.comparisonRows(value, true, true);
  assert.equal(api.comparisonRows(value, false), full);
  assert.equal(api.comparisonRows(value, true, true), missing);
  assert.equal(full[0].parts.map(part => part.text).join(''), value.html);
  assert.ok(missing.every(row => row.parts.every(part => !part.changed)));
  assert.equal(calls, 1, 'different row views share the original comparison');
  value.pdf = value.html;
  const updated = api.comparisonRows(value);
  assert.notEqual(updated, content.comparison, 'changed input invalidates prepared rows');
  assert.ok(updated.every(row => row.parts.every(part => !part.changed)));
  assert.notEqual(api.comparisonRows(value, false), full, 'input changes invalidate every row view');
});

test('local textDiff serves review candidates and popup comparisons', () => {
  const api = engine(), providers = new Map();
  reviewProvider(api, providers);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = '<p>中文𠀀 wrong end</p>';
  const index = locator.editorSourceIndex(new FixtureDocument({ model: { getValue: () => source, getVersionId: () => 1 } }));
  const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: index.raw.replace('wrong', 'right') });
  index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const localItems = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
  assert.ok(localItems.length);
  const item = { options: [{ id: 'pdf', edits: [] }], comparison: { html: index.raw, pdf: target.raw } };
  const provider = providers.get('pdf-ocr');
  const localRows = provider.content({ items: [item], choices: new Map() }, item).comparison;
  assert.ok(localRows.every(row => row.parts.some(part => part.changed)));
  for (const connection of index.byTarget.get(target)) delete connection.editorDiff;
  const refreshedItems = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
  for (const items of [localItems, refreshedItems])
    assert.equal(api.applyTextEdits(source, items.flatMap(item => item.options[0].edits)), source.replace('wrong', 'right'));
  const refreshedRows = provider.content({ items: [item], choices: new Map() }, item).comparison;
  for (const rows of [localRows, refreshedRows]) {
    assert.equal(rows[0].parts.map(part => part.text).join(''), index.raw);
    assert.equal(rows[1].parts.map(part => part.text).join(''), target.raw);
    assert.ok(rows.every(row => row.parts.some(part => part.changed)));
  }
});

test('text candidates, font candidates and decorations reuse one traversal and refresh font metadata', () => {
  const api = engine(), provider = reviewProvider(api);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = new api.PdfConnections(locator, 'Alpha beta gamma');
  const target = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { raw: 'Alpha beta GAMMA', fontVersion: 0, parts: [
    { start: 0, end: 6, font: { bold: false, italic: false } },
    { start: 6, end: 10, font: { bold: true, italic: false } },
    { start: 10, end: 16, font: { bold: false, italic: false } }
  ] });
  const connection = index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
  let reads = 0;
  connection.editorDiff = { parts: connectionParts(api, [['Alpha beta ', 'Alpha beta '], ['gamma', 'GAMMA']])
    .map(part => new Proxy(part, { get(object, key) { reads++; return Reflect.get(object, key); } })) };
  let fontReads = 0;
  const fontRuns = target.fontRuns.bind(target);
  target.fontRuns = (...args) => { fontReads++; return fontRuns(...args); };
  const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
  const traversed = reads;
  const { ranges } = connection.editorDiff;
  const fonts = reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target]] });
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [[connection, target]] }), true, true, undefined, documentModel);
  assert.equal(reads, traversed, 'review and highlight consumers share the classified spans');
  assert.deepEqual(Array.from(items, item => item.comparison.pdf), ['GAMMA']);
  assert.deepEqual(Array.from(fonts, item => item.text), ['beta']);
  assert.equal(marks.filter(mark => mark.options.description === 'PDF OCR text difference').length, 1);
  assert.equal(marks.filter(mark => mark.options.description === 'PDF font difference').length, 1);
  assert.deepEqual(reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target]] }), fonts, 'merging output does not mutate cached font data');
  assert.deepEqual(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] }), items, 'candidate generation reuses the same data');
  assert.equal(reads, traversed, 'repeated consumers do not revisit diff parts');
  assert.equal(fontReads, 1, 'font runs are read once across all consumers');
  target.parts[1].font.bold = false;
  target.fontVersion++;
  assert.equal(reviewCandidates(index, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[connection, target]] }).length, 0);
  assert.equal(reads, traversed, 'new font metadata reuses prepared text spans');
  assert.equal(connection.editorDiff.ranges, ranges, 'font refresh preserves mapped ranges');
  assert.equal(reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] })[0].comparison.pdf, 'GAMMA');
  assert.equal(fontReads, 2, 'updated font data is shared by subsequent text review');
});

test('transient mapping eviction preserves every prepared passage and recent selections', () => {
  const locator = new (engine().PdfLocator)({}, { document: { createElement: () => ({}) } });
  const index = new pdfApi.PdfConnections(locator, 'a'.repeat(400)), target = new pdfApi.PdfConnections(locator, index.raw);
  for (let start = 0; start < 360; start++)
    index.remember(start, start + 1, target, { start, end: start + 1 }, null, start < 160);
  const retained = index.byTarget.get(target);
  assert.equal(retained.filter(item => item.prepared).length, 160, 'required mappings are never evicted');
  assert.equal(retained.filter(item => !item.prepared).length, 128, 'selection history has a fixed bound');
  assert.equal(index.range(target, 0, 1).start, 0);
  assert.equal(index.range(target, 359, 360).start, 359);
  assert.equal(index.range(target, 160, 161), null);
});

test('all prepared highlights remain visible together after selection history fills', () => {
  const locator = new (engine().PdfLocator)({}, { document: { createElement: () => ({}) } });
  const index = new pdfApi.PdfConnections(locator, 'a '.repeat(400)), target = new pdfApi.PdfConnections(locator, 'b '.repeat(400));
  for (let i = 0; i < 160; i++) {
    const start = i * 2, hit = { start, end: start + 1 };
    index.remember(start, start + 1, target, hit);
    index.remember(start, start + 1, target, hit, null, true);
  }
  for (let i = 160; i < 400; i++)
    index.remember(i * 2, i * 2 + 1, target, { start: i * 2, end: i * 2 + 1 });
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const marks = sourceDecorations(index, reviewCandidates(index, { fonts: true, edits: false, text: true, targets: [], connections: [target].filter(Boolean).flatMap(target => index.connections.get(target)?.ranges || []) }), true, true, undefined, documentModel);
  const columns = new Set(marks.map(mark => mark.range.startColumn));
  for (let i = 0; i < 160; i++) assert.ok(columns.has(i * 2 + 1), `prepared highlight ${i} remains visible`);
  assert.equal(marks.length, 288);
});

test('passage pruning matches pairwise containment and ignores cache recency order', () => {
  const locator = new (engine().PdfLocator)({}, { document: { createElement: () => ({}) } });
  let seed = 23;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let round = 0; round < 80; round++) {
    const index = new pdfApi.PdfConnections(locator, 'a'.repeat(500)), pdf = {};
    const pages = Array.from({ length: 8 }, () => new pdfApi.PdfConnections(locator, 'Page'));
    for (const page of pages) {
      index.scopes.set(page, { prepared: true, scope: null });
      index.byTarget.set(page, Array.from({ length: 20 }, () => {
        const start = random(400); return { start, end: start + random(100) + 1 };
      }));
    }
    const all = pages.flatMap(page => index.byTarget.get(page).map(item => ({ page, item })));
    const expected = pages.map(page => index.byTarget.get(page).filter(item => !all.some(other => other.page !== page
      && other.item.start <= item.start && other.item.end >= item.end
      && other.item.end - other.item.start > item.end - item.start)));
    index?.connect(pages, pdf);
    const ranges = items => items.map(({ start, end }) => [start, end]);
    pages.forEach((page, i) => assert.deepEqual(ranges(index.byTarget.get(page)), ranges(expected[i])));
    const preparation = index.prepared;
    index?.connect([...pages].reverse(), pdf);
    assert.ok(index.prepared === preparation, 'LRU recency changes do not invalidate prepared mappings');
  }
});

test('OCR page reads publish font styles into the same aligned spans without a separate font pass', async () => {
  const api = engine(), objects = new Map();
  let pageReads = 0, textReads = 0, operatorReads = 0, release, notifications = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const items = ['Regular', 'Styled', 'RIGHT'].map((str, i) => ({ str, fontName: i === 1 ? 'style' : 'regular',
    transform: [1, 0, 0, 1, i * 80, 100], width: 70, height: 12 }));
  const page = { commonObjs: objects,
    async getTextContent() { textReads++; return { items }; },
    async getOperatorList() {
      operatorReads++;
      await gate;
      objects.set('regular', { name: 'Times', bold: false, italic: false });
      objects.set('style', { name: 'Times-BoldItalic', bold: true, italic: true });
      return { fnArray: [37, 38, 44, 37, 44], argsArray: [['regular', 12], [3], [], ['style', 12], []] };
    }
  };
  const pdf = { numPages: 1, async getPage() { pageReads++; return page; } };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {}, onIndexed: () => notifications++ });
  const target = await locator.indexDocument(pdf);
  const source = new api.PdfConnections(locator, '<p>Regular Styled WRONG</p>');
  const connection = source.remember(0, source.raw.length, target, { start: 0, end: target.raw.length });
  const before = api.differences(source, target, connection);
  assert.ok(before.text.length > 0, 'text comparison works while PDF font metadata is pending');
  assert.equal(before.fonts.length, 0, 'pending font data cannot create an automatic format edit');
  assert.equal(operatorReads, 1, 'font detection already started with the OCR page read');
  const alignment = connection.editorDiff;
  release();
  await target.pages[0].fontTask;
  const after = api.differences(source, target, connection);
  assert.equal(connection.editorDiff, alignment, 'font publication reuses the confirmed text alignment');
  assert.equal(after.fonts.length, 1);
  assert.equal(source.raw.slice(after.fonts[0].sourceStart, after.fonts[0].sourceEnd), 'Styled');
  assert.equal(after.fonts[0].font.bold, true);
  assert.equal(after.fonts[0].font.italic, true);
  assert.ok(notifications >= 2, 'late font metadata publishes an index update for existing highlights');
  const content = await api.readPageText(page);
  assert.equal(target.pages[0].parts[1].font, content.fonts.get('style'));
  const spans = items.map(item => ({ textContent: item.str,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ fontFamily: 'serif' }) } } }));
  const view = { pdfPage: page, _textHighlighter: { textDivs: spans } };
  await new Promise(resolve => api.layerFonts(view, {}, resolve));
  assert.equal(api.layerFonts(view, {}, () => {})(spans[1]), target.pages[0].parts[1].font,
    'rendered OCR layers and the document index use the same detected style object');
  const changed = new api.PdfConnections(locator, '<p>Regular BADDDD RIGHT</p>');
  const mismatch = changed.remember(0, changed.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(reviewCandidates(changed, { items: [], fonts: ['italic', 'bold'], edits: true, connections: [[mismatch, target, api.textDiff(changed, target, mismatch)]] }).length, 0,
    'styled PDF text cannot be applied to a different HTML word without aligned characters');
  await locator.indexFonts(pdf);
  assert.deepEqual([pageReads, textReads, operatorReads], [1, 1, 1], 'review and native layers never reread this page');
});

test('saved font sizes and colors load without merging distinct frontend runs', async () => {
  const window = {};
  const fonts = [
    { name: 'Times-Roman', italic: false, bold: false, flags: 4, size: 11, color: 0, alpha: 255, ascender: 1.05, descender: -0.28 },
    { name: 'Times-Roman', italic: false, bold: false, flags: 4, size: 22, color: 0, alpha: 255, ascender: 1.05, descender: -0.28 },
    { name: 'Times-Roman', italic: false, bold: false, flags: 4, size: 22, color: 0xFF0000, alpha: 128, ascender: 1.05, descender: -0.28 }
  ];
  const formatted = fonts.map((font, i) => ({ start: i * 2, end: i * 2 + 1, fontIndex: i, text: 'ABC'[i] }));
  const data = new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { schema: 3, raw: 'A B C', fonts, formatted,
    pages: [{ number: 1, start: 0, end: 5, parts: formatted.map(part => ({ ...part, item: { str: part.text } })) }] });
  vm.runInNewContext(engineSource, { window, fetch: async () => ({ ok: true, json: async () => data }) });
  const index = await window.LocalOcrTextReader.readDocument({ numPages: 1, ocrTextUrl: '/cache' }, { isCurrent: () => true });
  assert.equal(index.pages[0].parts[1].font, fonts[1]);
  const runs = index.fontRuns();
  assert.equal(runs.length, 3, 'same family and bold/italic state must retain size/color boundaries');
  for (let i = 0; i < runs.length; i++) {
    for (const key of Object.keys(fonts[i])) assert.equal(runs[i][key], fonts[i][key]);
  }
  const spans = [{ textContent: 'A' }, { textContent: 'B C' }];
  const lookup = window.PdfReviewProvider.layerFonts({ _textHighlighter: { textDivs: spans } }, {}, () => {}, index.pages[0], index);
  assert.equal(lookup(spans[0]).size, 11);
  assert.equal(lookup(spans[1]).italic, null, 'a mixed span cannot inherit only its first font');
});

test('PDF cache stays primary and unavailable or invalid caches use the original text layer', async () => {
  const window = {};
  let response, requests = 0, reads = 0;
  vm.runInNewContext(engineSource, { window, fetch: async () => {
    requests++;
    if (response instanceof Error) throw response;
    return response;
  } });
  const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
  const environment = { isCurrent: () => true, waitForIdle: async () => {} };
  const makePdf = () => ({ numPages: 1, ocrTextUrl: '/cache', getPage: async () => {
    reads++;
    return { getTextContent: async () => ({ items: [
      { str: 'Original', transform: [1, 0, 0, 1, 0, 10], height: 10, width: 40 }
    ] }) };
  } });
  response = { ok: true, json: async () => (new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { schema: 3, raw: 'Cached', fonts: [], formatted: [],
    pages: [{ number: 1, start: 0, end: 6, parts: [] }] })) };
  const cached = await new api.PdfLocator({}, environment).indexDocument(makePdf());
  assert.equal(cached.raw, 'Cached');
  assert.equal(reads, 0, 'a valid backend cache never reads PDF.js text');
  for (const failure of [new Error('offline'),
    { ok: false, json: async () => ({ error: 'unavailable' }) },
    { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } },
    { ok: true, json: async () => (new pdfApi.PdfConnections(new pdfApi.PdfLocator(), { schema: 2, raw: 'Old', fonts: [], formatted: [], pages: [] })) },
    { ok: true, json: async () => ({ schema: 1, pages: [] }) }]) {
    response = failure;
    const pdf = makePdf(), locator = new api.PdfLocator({}, environment);
    const [first, second] = await Promise.all([locator.indexDocument(pdf), locator.indexDocument(pdf)]);
    assert.equal(first, second, 'fallback index work is shared');
    assert.equal(first.raw, 'Original\n');
    assert.equal(first.pages[0].parts[0].start, 0);
    assert.equal(first.pages[0].parts[0].end, 8);
    assert.equal(first.normalized.text, 'original ');
  }
  const pdf = makePdf();
  delete pdf.ocrTextUrl;
  const before = requests;
  assert.equal((await new api.PdfLocator({}, environment).indexDocument(pdf)).raw, 'Original\n');
  assert.equal(requests, before, 'no backend request without a URL');
  assert.equal(reads, 6, 'each fallback reads its page once');
});

test('text-layer fallback stops on document change and failed extraction can retry', async () => {
  const api = engine();
  let current = true, reads = 0;
  const pdf = { numPages: 2, getPage: async () => {
    reads++;
    return { getTextContent: async () => { current = false; return { items: [] }; } };
  } };
  const environment = { isCurrent: () => current, waitForIdle: async () => {} };
  assert.equal(await new api.PdfLocator({}, environment).indexDocument(pdf), null);
  assert.equal(reads, 1);
  current = true;
  let attempts = 0;
  const page = { getTextContent: async () => {
    if (++attempts === 1) throw new Error('temporary text failure');
    return { items: [] };
  } };
  const retryPdf = { numPages: 1, getPage: async () => page };
  const locator = new api.PdfLocator({}, environment);
  await assert.rejects(locator.indexDocument(retryPdf), /temporary text failure/);
  assert.ok(await locator.indexDocument(retryPdf));
  assert.equal(attempts, 2);
});



test('edge differences without OCR words are missing and anchor to the nearest word', () => {
  const api = engine();
  for (const [html, pdf, absent] of [
    ['extra same text', 'same text', true],
    ['same text extra', 'same text', true],
    ['extra same text', '  same text', true],
    ['same text extra', 'same text  ', true],
    ['extra same text', '%%% same text', true],
    ['same text extra', 'same text %%%', true],
    ['wrong same text', 'right same text', false],
    ['same text wrong', 'same text right', false],
    ['same extra text', 'same text', false]
  ]) {
    let target;
    const locator = new api.PdfLocator({}, {
      getVisiblePages: () => [{ index: target }],
      document: { createElement: () => ({}), createRange: () => ({ setStart() {}, setEnd() {},
        getClientRects: () => [{ left: 10, top: 20, bottom: 32, width: 40, height: 12 }] }) }
    });
    const index = new api.PdfConnections(locator, html);
    target = new api.PdfConnections(locator, { raw: pdf });
    target.layer = { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 800 }) };
    const first = pdf.search(/\S/), last = pdf.trimEnd().length;
    target.parts = [{ start: first, end: last, node: { length: last - first } }];
    index.byTarget.set(target, [{ start: 0, end: html.length, targetStart: 0, targetEnd: pdf.length }]);
    const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    assert.ok(items.length, html);
    for (const item of items) {
      assert.equal(!!item.missing, absent, `${html} / ${pdf}`);
      if (absent) {
        assert.equal(item.options[0].edits.length, 0);
        const anchor = index.missingRange(target, item.sourceStart, item.sourceEnd);
        assert.ok(anchor && target.fontRuns(anchor.start, anchor.end, true).length, 'missing popup has a word anchor');
        assert.equal(anchor.start, anchor.end, 'confirmed edge words are marked with a collapsed caret');
        assert.equal(anchor.start, item.sourceStart === 0 ? first : last, 'caret uses the nearest word edge');
        item.pdfSource = { index, start: item.sourceStart, end: item.sourceEnd };
        assert.equal(locator.reviewAnchors([item.pdfSource]).get(item.pdfSource)?.top, 20, 'popup receives actual anchor coordinates');
      } else assert.ok(item.options[0].edits.length, 'real OCR differences remain replaceable');
    }
  }
});

test('text replacement refreshes font differences for the existing second formatting step', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [source, pdf, italic, bold] of [
    ['<i>bc</i>', 'abc', true, false],
    ['<i>bc</i>', 'abc', false, false],
    ['<em>ab</em>', 'abc', true, false],
    ['<em>ab</em>', 'abc', false, false],
    ['<b>bc</b>', 'abc', false, true],
    ['<b>bc</b>', 'abc', false, false],
    ['<strong>ab</strong>', 'abc', false, true],
    ['<strong>ab</strong>', 'abc', false, false],
    ['<i><b>bc</b></i>', 'abc', false, true],
    ['<i>ac</i>', 'abc', false, false],
    ['bc', 'abc', true, true],
    ['<i>bc</i>', 'abc', null, null]
  ]) {
    const index = new api.PdfConnections(locator, source);
    const target = new api.PdfConnections(locator, { raw: pdf,
      parts: [{ start: 0, end: pdf.length, font: { italic, bold } }] });
    index.byTarget.set(target, [{ start: 0, end: index.raw.length, targetStart: 0, targetEnd: pdf.length }]);
    const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    const result = api.applyTextEdits(source, items.flatMap(item => item.options[0].edits));
    const refreshed = new api.PdfConnections(locator, result);
    assert.equal(refreshed.raw, pdf, 'first replacement restores the text');
    refreshed.byTarget.set(target, [{ start: 0, end: pdf.length, targetStart: 0, targetEnd: pdf.length }]);
    const formats = reviewCandidates(refreshed, { fonts: true, edits: true, text: false, targets: [target] });
    const final = new api.PdfConnections(locator, api.applyTextEdits(result, formats.flatMap(item => item.options[0].edits)));
    assert.equal(final.raw, pdf, 'format replacement retains the restored text');
    for (const key of ['italic', 'bold']) if (typeof ({ italic, bold })[key] === 'boolean')
      assert.ok(final.formats.every(style => style[key] === ({ italic, bold })[key]), `${source}: ${key}`);
  }
});


test('OCR mapped to another HTML passage cannot consume missing edge text', () => {
  const api = engine();
  for (const [html, pdf, mappedStart, mappedPdf, missing] of [
    ['extra same text another', 'another same text', 15, 0, 'extra'],
    ['another same text extra', 'same text another', 0, 10, 'extra']
  ]) {
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = new api.PdfConnections(locator, html), target = new api.PdfConnections(locator, { raw: pdf });
    const mapped = { start: mappedStart, end: mappedStart + 8, targetStart: mappedPdf, targetEnd: mappedPdf + 7 };
    const broad = { start: 0, end: html.length, targetStart: 0, targetEnd: pdf.length };
    index.byTarget.set(target, [mapped, broad]);
    const items = reviewCandidates(index, { fonts: false, edits: true, text: true, targets: [target] });
    const at = html.indexOf(missing), edge = items.filter(item => item.sourceStart < at + missing.length && item.sourceEnd > at);
    assert.equal(edge.map(item => item.comparison.html).join('').trim(), missing, 'even coincidental matching letters belong to the missing remainder');
    assert.ok(edge.every(item => item.missing), `${html}: occupied OCR leaves the edge missing`);
    assert.ok(edge.every(item => !item.options[0].edits.length), 'occupied OCR cannot be offered as a replacement');
    assert.ok(!items.some(item => item.sourceStart < mapped.end && item.sourceEnd > mapped.start),
      'the confirmed HTML passage remains mapped');
  }
});
