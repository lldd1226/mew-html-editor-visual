import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const window = {};
vm.runInNewContext(await readFile(new URL('../public/editor-core.js', import.meta.url), 'utf8'), { window });
const Model = window.MewEditorCore.DocumentModel;
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const file of ['../public/editor-core.js', '../mew-html-reader-vscode/editor-core.js']) {
  const host = {};
  vm.runInNewContext(await readFile(new URL(file, import.meta.url), 'utf8'), { window: host });
  const Document = host.MewEditorCore.DocumentModel;
  test(`${file}: native model versions own immutable snapshots and shared HTML index data`, () => {
    let source = '<p>Alpha <i>word</i>.</p>', version = 1, reads = 0;
    const documentModel = new Document({ model: { getValue: () => { reads++; return source; }, getVersionId: () => version } }), model = documentModel.model;
    const document = { createElement: () => ({}) };
    const before = documentModel.snapshot, index = documentModel.parse(document);
    assert.equal(documentModel.snapshot, before);
    assert.equal(documentModel.index, index);
    assert.equal(reads, 1, 'one source read per model version');
    assert.equal(index.formats[index.raw.indexOf('word')].italic, true);
    source = '<p>New text.</p>'; version++; documentModel.update(documentModel.content);
    const after = documentModel.snapshot;
    assert.notEqual(after, before);
    assert.equal(before.source, '<p>Alpha <i>word</i>.</p>');
    assert.equal(documentModel.parse(document).raw, 'New text.\n');
    assert.equal(index.raw, 'Alpha word.\n', 'old queues retain their original coordinates');
  });
  test(`${file}: commit rejects stale, read-only and overlapping edits before opening undo boundaries`, async () => {
    let source = 'abcdef', version = 1, readOnly = false, undo = 0, calls = 0, result = true;
    const documentModel = new Document({ model: { getValue: () => source, getVersionId: () => version,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
    const editor = { document: documentModel, getModel: () => model, getOption: () => readOnly, pushUndoStop: () => undo++,
      applyReviewEdits(edits, expected) {
        calls++; assert.equal(expected, source); assert.equal(edits[0].start, 1); return result;
      },
      executeEdits(origin, edits) { calls++; assert.equal(origin, 'review-replacement'); assert.equal(edits[0].range.startColumn, 2); return result; } };
    let snapshot = documentModel.snapshot; const edits = documentModel.validateEdits([{ start: 1, end: 2, text: 'X', expected: 'b' }]);
    source = 'abXdef'; version++; documentModel.update(documentModel.content);
    assert.throws(() => documentModel.applyEdits(edits, { editor: editor }), /编辑器内容已变化/);
    source = snapshot.source; version++; documentModel.update(documentModel.content);
    assert.throws(() => documentModel.applyEdits(edits, { editor: editor }), /编辑器内容已变化/);
    version = snapshot.version; documentModel.update(); snapshot = documentModel.snapshot; readOnly = true;
    assert.throws(() => documentModel.applyEdits(edits, { editor: editor }), /只读/);
    readOnly = false;
    assert.throws(() => documentModel.applyEdits([...edits, { start: 1, end: 3, text: '' }], { editor: editor }), /重叠/);
    assert.equal(calls, 0); assert.equal(undo, 0);
    assert.equal(documentModel.applyEdits(edits, { editor: editor }), true);
    assert.equal(undo, 2); assert.equal(calls, 1);
    result = Promise.resolve(false);
    await assert.rejects(documentModel.applyEdits(edits, { editor: editor }), /未能应用替换/);
    assert.equal(source, snapshot.source, 'the document interface never mutates the editor model itself');
  });
  test(`${file}: native ranges retain marker options and share offset validation`, () => {
    const source = 'abcdef';
    const documentModel = new Document({ model: { getValue: () => source, getVersionId: () => 1,
      validateRange: range => ({ ...range, endColumn: Math.min(7, range.endColumn) }),
      getOffsetAt: position => position.column - 1,
      getPositionAt() { throw new Error('unexpected offset-to-range conversion'); } } }), model = documentModel.model;
    const range = { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 3 };
    let calls = 0;
    const editor = { document: documentModel, getModel: () => model, getOption: () => false,
      applyReviewEdits(edits) { calls++; assert.equal(edits[0].start, 1); return true; },
      executeEdits(origin, edits) { calls++; assert.equal(edits[0].range, range);
        assert.equal(edits[0].forceMoveMarkers, false); return true; } };
    const snapshot = documentModel.snapshot, edit = { range, text: 'X', expected: 'b', forceMoveMarkers: false };
    assert.throws(() => documentModel.applyEdits([{ ...edit, expected: 'old' }], { editor: editor }), /原文已变化/);
    assert.throws(() => documentModel.applyEdits([edit, { start: 1, end: 3, text: '' }], { editor: editor }), /重叠/);
    assert.throws(() => documentModel.applyEdits([{ ...edit, range: { ...range, endColumn: 9 } }], { editor: editor }), /无效/);
    assert.equal(calls, 0);
    assert.equal(documentModel.applyEdits([edit], { editor: editor }), true);
    assert.equal(calls, 1);
  });
}

test('loading retains disk text and version for the next save', async () => {
  const d = await Model.load({ read: async () => ({ text: 'disk\r\n', mtime: 7 }) });
  assert.equal(d.content, 'disk\r\n');
  assert.equal(d.savedContent, d.content);
  assert.equal(d.mtime, 7);
  assert.equal(d.dirty, false);
});

test('editor normalization preserves line endings and dirty follows saved text', () => {
  const d = new Model({ text: 'a\r\n' });
  assert.equal(d.textFromEditor('a\n'), 'a\r\n');
  d.update('ab');
  assert.equal(d.dirty, true);
  assert.equal(d.revision, 1);
  assert.equal(d.textFromEditor('a\n'), 'a\r\n');
  d.update(d.textFromEditor('a\n'));
  assert.equal(d.dirty, false);
  assert.equal(d.revision, 2);
  d.update(d.content);
  assert.equal(d.revision, 2, 'identical editor updates retain the revision');
});

test('queued saves use the latest acknowledged mtime and preserve newer edits', async () => {
  const gate = defer(), started = defer(), writes = [];
  const d = new Model({ text: 'a', mtime: 1, write: async snapshot => {
    writes.push(snapshot); started.resolve();
    if (writes.length === 1) await gate.promise;
    return { mtime: writes.length + 1 };
  } });
  d.update('b'); const first = d.save(); await started.promise;
  d.update('c'); const second = d.save(); d.update('d');
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(writes.map(s => [s.text, s.mtime]), [['b', 1], ['c', 2]]);
  assert.equal(d.savedContent, 'c'); assert.equal(d.content, 'd'); assert.equal(d.dirty, true);
  await d.saveUntilClean(); assert.equal(d.savedContent, 'd'); assert.equal(d.dirty, false);
});

test('saveUntilClean drains edits made during a save, failed requests can retry', async () => {
  const gate = defer(), started = defer(); let count = 0;
  const d = new Model({ text: 'a', write: async () => {
    count++; if (count === 1) { started.resolve(); await gate.promise; }
    if (count === 3) throw new Error('409 conflict');
    return { mtime: count };
  } });
  d.update('b'); const saving = d.saveUntilClean(); await started.promise;
  d.update('c'); gate.resolve(); await saving;
  assert.equal(count, 2); assert.equal(d.dirty, false);
  d.update('d'); await assert.rejects(d.save(), /409/);
  assert.equal(d.savedContent, 'c'); assert.equal(d.dirty, true);
  await d.save(); assert.equal(d.dirty, false);
});

test('disk refresh preserves local edits and conflict version; clean reload advances revision', async () => {
  let disk = { text: 'external', mtime: 2 };
  const d = new Model({ text: 'a', mtime: 1, read: async () => disk });
  d.update('local');
  assert.equal(await d.refresh(), 'conflict');
  assert.equal(d.content, 'local'); assert.equal(d.mtime, 1); assert.equal(d.reloadRevision, 0);
  d.update('a'); assert.equal(await d.refresh(), 'updated');
  assert.equal(d.content, 'external'); assert.equal(d.reloadRevision, 1);
  d.update('same'); disk = { text: 'same', mtime: 3 };
  assert.equal(await d.refresh(), 'saved'); assert.equal(d.dirty, false);
  disk = { text: 'same', mtime: 4 }; d.update('new local');
  assert.equal(await d.refresh(), 'unchanged'); assert.equal(d.dirty, true); assert.equal(d.mtime, 4);
});

test('editing during a pending read is retained; read-only writes reject', async () => {
  const gate = defer(), started = defer();
  const d = new Model({ text: 'a', read: async () => { started.resolve(); return gate.promise; } });
  const refreshing = d.refresh(); await started.promise;
  d.update('local'); gate.resolve({ text: 'disk', mtime: 2 });
  assert.equal(await refreshing, 'conflict'); assert.equal(d.content, 'local');
  const remote = new Model({ text: 'remote', editable: false }); remote.update('edit');
  await assert.rejects(remote.saveUntilClean(), /read-only/);
});

test('a save queued behind a reload cannot overwrite the newly read disk content', async () => {
  const gate = defer(), started = defer(); let writes = 0;
  const d = new Model({ text: 'old', mtime: 1,
    read: async () => { started.resolve(); return gate.promise; },
    write: async () => { writes++; return { mtime: 3 }; }
  });
  const refreshing = d.refresh(); await started.promise;
  const saving = d.save();
  gate.resolve({ text: 'external', mtime: 2 });
  await refreshing; await assert.rejects(saving, /reloaded/);
  assert.equal(d.content, 'external'); assert.equal(writes, 0);
  await d.save(); assert.equal(writes, 1);
});
