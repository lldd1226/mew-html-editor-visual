import assert from 'node:assert/strict';
import test from 'node:test';
import { selectionFixture } from './support/pdf-selection-group-fixture.mjs';

for (const markup of [false, true]) for (const [name, query, replacement, texts] of [
  ['word start', 'WRoot', 'VRoot', ['WRooting', 'WRooter', 'preWRooting']],
  ['word end', 'RootW', 'RootV', ['aaRootW', 'bbRootW', 'RootWtail']],
  ['single-character selection', 'W', 'V', ['aaW', 'Wbb', 'xWx']],
  ['two patterns', 'W aa Z', 'V aa Y', ['preW aa Z', 'W aa Ztail', 'otherW aa Zend']],
  ['non-BMP context', '𠀀W', '𠀀V', ['aa𠀀W', '𠀀Wtail', 'other𠀀W']]
]) {
  test(`${name}: selected context batches across other word parts${markup ? ' and inline tags' : ''}`, async () => {
    const cases = texts.map(text => ({ text, pdf: text.replace(query, replacement) }));
    cases.push({ text: `correct${query}`, pdf: `correct${query}` },
      { text: `different${query}`, pdf: `different${query.replace('W', 'Q')}` });
    if (name === 'two patterns') cases.push({ text: `extra${query}`, pdf: `extra${replacement.replace('aa', 'ab')}` });
    const fixture = selectionFixture(cases, { markup: markup ? text => text.replaceAll('W', '<i>W</i>') : undefined });
    const { provider, locator, index, base } = fixture;
    assert.ok(base.items.length, 'the comparison is prepared before selection');
    index.candidates = index.formatDifferences = index.compare = () => { throw new Error('selection rebuilt the document diff'); };
    const { item, data, state } = fixture.select(query, replacement);
    assert.ok(item);
    assert.equal(provider.matchingItems, undefined, 'the forwarding API is removed');
    assert.equal(data.items, base.items, 'selection keeps the original queue and its order');
    for (const field of ['entries', 'edits', 'plans']) assert.equal(data[field], base[field], `selection reuses ${field}`);
    const group = locator.reviewLists.get(item);
    assert.deepEqual(Array.from(group.items, value => value.sourceStart), texts.map((text, at) => fixture.starts[at] + text.indexOf(query)));
    provider.onSelect(item, fixture.context, data.items);
    assert.equal(fixture.highlighted, group.items, 'highlighting uses the exact replacement group');
    const content = provider.content(state, item);
    const preview = fixture.documentModel.applyEdits(content.edits).source;
    provider.onSelect(item, fixture.context, data.items, true);
    assert.equal(fixture.highlighted, group.items, 'preview keeps the same highlighted group');
    await provider.apply(state, false).apply();
    assert.equal(fixture.source, preview, 'the preview and committed replacement are identical');
    const expected = cases.map(({ text }, at) => {
      let value = markup ? text.replaceAll('W', '<i>W</i>') : text;
      if (at < texts.length) value = value.replace(markup ? query.replaceAll('W', '<i>W</i>') : query,
        markup ? replacement.replaceAll('V', '<i>V</i>') : replacement);
      return `<p>${value}</p>`;
    }).join('');
    assert.equal(fixture.source, expected, 'only identical selected text and internal patterns are replaced');
    assert.equal(fixture.undoStops, 2, 'the whole group is one undo operation');
  });
}

test('a selection cutting into one cached diff only replaces the selected characters', async () => {
  const fixture = selectionFixture([{ text: 'aaabcd', pdf: 'aaWXYZ' }, { text: 'abcdtail', pdf: 'WXYZtail' },
    { text: 'abcdcorrect', pdf: 'abcdcorrect' }, { text: 'abcddifferent', pdf: 'QRSTdifferent' }]);
  const { item, state } = fixture.select('bc', 'XY');
  assert.ok(item);
  assert.equal(fixture.locator.reviewLists.get(item).items.length, 2);
  fixture.provider.onSelect(item, fixture.context, state.items);
  assert.equal(fixture.highlighted.length, 2);
  await fixture.provider.apply(state, false).apply();
  assert.equal(fixture.source, '<p>aaaXYd</p><p>aXYdtail</p><p>abcdcorrect</p><p>abcddifferent</p>');
});

test('ordinary faults still require the same whole-word context', () => {
  const fixture = selectionFixture([{ text: 'teWrm', pdf: 'teVrm' }, { text: 'teWrm', pdf: 'teVrm' },
    { text: 'otWrm', pdf: 'otVrm' }, { text: 'teWrd', pdf: 'teVrd' }]);
  const [item] = fixture.base.items;
  fixture.provider.onSelect(item, fixture.context, fixture.base.items);
  assert.equal(fixture.highlighted.length, 2);
});

test('selection results reuse the queue without changing ordinary review or another session', () => {
  const fixture = selectionFixture([{ text: 'preW xx Z', pdf: 'preV xx Y' }]);
  const { data, item, state } = fixture.select('W xx Z', 'V xx Y');
  assert.equal(fixture.locator.currentItem, undefined);
  assert.equal('reviewNotice' in fixture.locator, false);
  assert.notEqual(data, fixture.locator.review);
  assert.equal(state.item, item);
  fixture.index.textEdits = () => { throw new Error('selection edits were rebuilt'); };
  assert.equal(fixture.locator.reviewItems({ request: { notice: item.comparison } }), data);
  assert.equal(data.selection, item);
  const ordinary = fixture.locator.reviewItems({ request: null });
  assert.equal(ordinary.items, data.items);
  assert.equal(ordinary.selection, undefined);
  assert.equal(state.item, item, 'an ordinary read does not change the session candidate');
  assert.equal(data.selection, item, 'the selected result remains stable');
});

test('source edits invalidate selected results before the next queue is read', async () => {
  const fixture = selectionFixture([{ text: 'preW xx Z', pdf: 'preV xx Y' }]);
  const { state } = fixture.select('W xx Z', 'V xx Y');
  await fixture.provider.apply(state, false).apply();
  const next = fixture.locator.reviewItems();
  assert.equal('reviewNotice' in fixture.locator, false);
  assert.equal(next.selection, undefined);
});

test('switching documents clears selection even when returning to a cached source index', () => {
  const fixture = selectionFixture([{ text: 'preW xx Z', pdf: 'preV xx Y' }]);
  const { state } = fixture.select('W xx Z', 'V xx Y');
  const other = new fixture.window.MewEditorCore.DocumentModel({ model: {
    getValue: () => '<p>another document</p>', getVersionId: () => 1
  } });
  fixture.locator.editorSourceIndex(other);
  assert.equal('reviewNotice' in fixture.locator, false);
  assert.equal(fixture.locator.reviewItems().selection, undefined);
  fixture.locator.editorSourceIndex(fixture.documentModel);
  assert.equal(fixture.locator.index, fixture.index);
  assert.equal(fixture.locator.reviewItems().selection, undefined);
});

test('an older asynchronous queue request cannot restore a previous selection', async () => {
  const fixture = selectionFixture([{ text: 'preW xx Z', pdf: 'preV xx Y' }]);
  let finish;
  fixture.locator.indexFonts = () => new Promise(resolve => { finish = resolve; });
  const pending = fixture.locator.reviewItems({ ...fixture.context, request: null });
  const { item } = fixture.select('W xx Z', 'V xx Y');
  finish(fixture.target);
  assert.equal((await pending).selection, undefined);
  assert.equal(fixture.locator.review.selection, undefined, 'ordinary cache holds no active selection');
  assert.equal(fixture.locator.reviewItems({ request: { notice: item.comparison } }).selection, item);
});

test('an asynchronous selection notice cannot reopen review after the native selection changes', async () => {
  const fixture = selectionFixture([{ text: 'preW xx Z', pdf: 'preV xx Y' }]);
  const { item } = fixture.select('W xx Z', 'V xx Y');
  let opened = 0;
  fixture.window.ReplacementReview.openForSelection = () => { opened++; };
  const pending = fixture.listeners.get('pdf-selection-difference')({ detail: {
    editor: fixture.editor, model: fixture.model, pdf: fixture.target.pdf, notices: [item.comparison], side: 'pdf'
  } });
  fixture.select('W', 'V');
  await pending;
  assert.equal(opened, 0, 'a stale notice must not overwrite the current native selection');
});

test('selecting a later occurrence keeps original ordinals and ordered batch entries', async () => {
  const fixture = selectionFixture([{ text: 'lead Q', pdf: 'lead R' },
    { text: 'preW xx Z', pdf: 'preV xx Y' }, { text: 'W xx Ztail', pdf: 'V xx Ytail' },
    { text: 'tail S', pdf: 'tail T' }]);
  const { data, item, state } = fixture.select('W xx Z', 'V xx Y', 2);
  assert.equal(data.items, fixture.base.items);
  const covered = data.items.flatMap((value, at) => !value.font && value.sourceStart >= item.sourceStart
    && value.sourceEnd <= item.sourceEnd ? [at] : []);
  assert.deepEqual(Array.from(item.queueRange), [covered[0], covered.at(-1)]);
  const group = fixture.locator.reviewLists.get(item);
  assert.deepEqual(Array.from(group.items, value => value.sourceStart), [fixture.starts[1] + 3, fixture.starts[2]]);
  // Navigating beyond the selection must apply the ordinary fault at that ordinal.
  state.position = data.items.length - 1;
  state.item = data.items[state.position];
  await fixture.provider.apply(state, false).apply();
  assert.equal(fixture.source, '<p>lead Q</p><p>preW xx Z</p><p>W xx Ztail</p><p>tail T</p>');
});

test('native Hover includes a selected multi-diff passage outside the original queue', async () => {
  const { readFile } = await import('node:fs/promises'), { runInNewContext } = await import('node:vm');
  const fixture = selectionFixture([{ text: 'preW xx Z', pdf: 'preV xx Y' }, { text: 'W xx Ztail', pdf: 'V xx Ytail' }]);
  const { item, data } = fixture.select('W xx Z', 'V xx Y');
  fixture.model.uri = { toString: () => 'fixture.html' };
  fixture.editor.getId = () => 'fixture';
  let hover;
  fixture.editor.showReviewHover = (range, value) => { hover = value; };
  const source = await readFile(new URL('../mew-html-reader-vscode/pdfdiff/replacement-review.js', import.meta.url), 'utf8');
  const scope = {};
  runInNewContext(source.slice(source.indexOf('  function hoverContent('), source.indexOf('  function comparison(')), scope);
  scope.showHover(fixture.provider, fixture.context, item, data.items);
  assert.equal(hover.length, 1);
  assert.ok(hover[0].value.includes('W xx Z'));
  const command = hover[0].value.match(/command:[^?]+\?([^)]*)/)[1];
  assert.deepEqual(JSON.parse(decodeURIComponent(command))[0].selection,
    { html: 'W xx Z', pdf: 'V xx Y', start: item.sourceStart, end: item.sourceEnd });
});

test('identical diff counts and readings at different offsets do not join the selection group', async () => {
  const fixture = selectionFixture([{ text: 'xxaba', pdf: 'xxXba' }, { text: 'abatail', pdf: 'Xbatail' },
    { text: 'otheraba', pdf: 'otherabX' }]);
  const { item, state } = fixture.select('aba', 'Xba');
  fixture.provider.onSelect(item, fixture.context, state.items);
  assert.equal(fixture.highlighted.length, 2);
  await fixture.provider.apply(state, false).apply();
  assert.equal(fixture.source, '<p>xxXba</p><p>Xbatail</p><p>otheraba</p>');
});

for (const edge of ['start', 'end']) test(`an insertion on the selected ${edge} boundary batches across different words`, async () => {
  const replacement = edge === 'start' ? 'XRoot' : 'RootX';
  const cases = ['Rooting', 'preRoot'].map(text => ({ text, pdf: text.replace('Root', replacement) }));
  cases.push({ text: 'correctRoot', pdf: 'correctRoot' },
    { text: 'otherRoot', pdf: edge === 'start' ? 'otherYRoot' : 'otherRootY' });
  const fixture = selectionFixture(cases), { item, state } = fixture.select('Root', replacement);
  fixture.provider.onSelect(item, fixture.context, state.items);
  assert.equal(fixture.highlighted.length, 2);
  assert.equal(fixture.provider.content(state, item).edits.length, 2);
  await fixture.provider.apply(state, false).apply();
  assert.equal(fixture.source, cases.map(({ text }, at) => `<p>${at < 2 ? text.replace('Root', replacement) : text}</p>`).join(''));
});

test('indexed queries preserve collapsed insertions alongside overlapping missing text', () => {
  const fixture = selectionFixture([{ text: 'abcdef', pdf: 'abcdef' }]);
  const text = [{ sourceStart: 2, sourceEnd: 5 }, { sourceStart: 2, sourceEnd: 2 }, { sourceStart: 6, sourceEnd: 8 }];
  fixture.index.prepared.differences = null;
  fixture.index.candidates = () => text;
  fixture.index.getDifferences();
  assert.deepEqual(Array.from(fixture.index.differencesIn(3, 4)), [text[0]]);
  assert.deepEqual(Array.from(fixture.index.differencesIn(2, 2)), [text[1]]);
  assert.deepEqual(Array.from(fixture.index.differencesIn(2, 5)), [text[0], text[1]]);
  assert.deepEqual(Array.from(fixture.index.differencesIn(5, 6)), []);
});

test('a cold PDF selection maps its scope without preparing replacement edits', () => {
  const fixture = selectionFixture([{ text: 'ready', pdf: 'ready' }]);
  const { PdfConnections } = fixture.window.PdfSelectionDiff;
  const source = new PdfConnections(fixture.locator, '<p>case h</p>');
  const target = new PdfConnections(fixture.locator, { raw: source.raw.replace('h', 'H') });
  source.remember(0, source.raw.length, target, { start: 0, end: target.raw.length });
  source.textEdits = () => { throw new Error('mapping prepared replacement edits'); };
  const start = target.raw.indexOf('H'), result = source.locateSource([{ index: target, start, end: start + 1 }]);
  assert.equal(result.difference.html, 'h');
  assert.equal(result.difference.pdf, 'H');
});


test('mouse selection jumps to the full current range synchronously in both shared copies', async () => {
  const { readFile } = await import('node:fs/promises'), { runInNewContext } = await import('node:vm');
  for (const folder of ['public', 'mew-html-reader-vscode']) {
    const source = await readFile(new URL(`../${folder}/pdfdiff/pdf-selection.js`, import.meta.url), 'utf8');
    const handlers = {}, published = [], index = { starts: Array.from({ length: 1001 }, (_, i) => i), ends: Array.from({ length: 1001 }, (_, i) => i + 1),
      entry: (start, end) => ({ start, end }) };
    let start = 0, end = 1;
    const editor = { onDidChangeCursorSelection: callback => { handlers.selection = callback; },
      getModel: () => ({ getOffsetAt: position => position }),
      getSelections: () => [{ getStartPosition: () => start, getEndPosition: () => end }], hasTextFocus: () => true };
    const state = { window: { PdfSelectionDiff: selectionFixture([{ text: 'a', pdf: 'a' }]).window.PdfSelectionDiff },
      document: {}, editors: new WeakSet(), cleanup: [], syncingPdf: false, readTimer: null, selectionHighlight: true, viewer: null,
      performance: { now: () => 0 }, clearTimeout() {}, setTimeout() { throw new Error('selection must not wait for a timer'); },
      review: { highlights: { selectionRange: () => null }, locator: { index, editorSourceIndex() { return index; } } },
      select: entries => published.push(entries), currentEditor: () => editor };
    const begin = source.indexOf('  function attachEditor('), finish = source.indexOf('\n  function ', begin + 10);
    assert.ok(begin >= 0 && finish > begin);
    runInNewContext(source.slice(begin, finish), state);
    state.attachEditor(editor);
    for ([start, end] of [[0, 900], [500, 501], [20, 850]]) {
      handlers.selection({ source: 'mouse' });
      assert.deepEqual(Array.from(published.at(-1), entry => [entry.start, entry.end]), [[start, end]]);
    }
  }
});
