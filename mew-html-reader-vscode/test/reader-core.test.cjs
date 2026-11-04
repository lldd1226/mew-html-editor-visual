const test = require("node:test");
const assert = require("node:assert/strict");
const { formatPattern, pageFromName, pageFromPdfLabel, adjacentPage, pageAtOrBefore, normalizedVolumes } = require("../reader-core.cjs");

test("patterns and labels follow reader.html semantics", () => {
  assert.equal(formatPattern("ME{volume:02}-{page:03}.html", 7, 4), "ME04-007.html");
  assert.equal(pageFromName("ME04-007.html", "^ME04-(?<page>\\d+)\\.html$"), 7);
  assert.equal(pageFromPdfLabel("17a"), "17a");
  assert.equal(pageFromPdfLabel("iv"), "iv");
});

test("adjacent navigation uses actual configured pages and does not wrap", () => {
  assert.equal(adjacentPage([3, 4, 8], 4, 1), 8);
  assert.equal(adjacentPage([3, 4, 8], 3, -1), null);
  assert.equal(adjacentPage([3, 4, 8], 8, 1), null);
  assert.equal(pageAtOrBefore([3, 4, 8], 7), 4);
  assert.equal(pageAtOrBefore([3, 4, 8], 2), null);
});

test("single-volume JSON is normalized", () => {
  const [volume] = normalizedVolumes({ title: "Band 4", htmlRoot: "pages", pdf: "book.pdf", pagePattern: "(\\d+)" });
  assert.equal(volume.title, "Band 4");
  assert.equal(volume.directory, "pages");
  assert.equal(volume.pdf, "book.pdf");
});


test("native review edits reject stale expected text and overlapping ranges", () => {
  const { validateReviewEdits } = require('../reader-core.cjs');
  assert.throws(() => validateReviewEdits('abc', [{start:0,end:2,text:''},{start:1,end:3,text:''}]));
  assert.throws(() => validateReviewEdits('abc', [{start:0,end:1,text:'x',expected:'z'}]));
  assert.deepEqual(validateReviewEdits('abc', [{start:0,end:1,text:'x',expected:'a'}]), [{start:0,end:1,text:'x',expected:'a'}]);
});


test("review snapshots preserve reversed selection and page boundaries", () => {
  const { reviewSourceSnapshot } = require('../reader-core.cjs');
  const start = {line: 1, character: 2}, end = {line: 3, character: 4};
  const snapshot = reviewSourceSnapshot({uri:{toString:()=> 'file:///a'},getText:()=> 'text',version:7,isDirty:true},
    {page:3,volume:{pages:[3,8]}}, [{start,end,anchor:end,active:start}]);
  assert.equal(snapshot.pageEnd,8);
  assert.equal(snapshot.version,7);
  assert.deepEqual(snapshot.selections[0], {startLineNumber:2,startColumn:3,endLineNumber:4,endColumn:5,
    selectionStartLineNumber:4,selectionStartColumn:5,positionLineNumber:2,positionColumn:3});
});

test("decoration grouping normalizes hover messages and clears absent classes", () => {
  const { reviewDecorationGroups } = require('../reader-core.cjs');
  const range = {startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:2};
  const groups = reviewDecorationGroups([{className:'a',range,hoverMessage:{value:'first'}},
    {className:'a',range,hoverMessage:['second',{value:'third'}]}, {className:'b',range}, {range}]);
  assert.deepEqual(groups.get('a').map(mark=>mark.hover), [['first'],['second','third']]);
  assert.deepEqual(groups.get('b')[0].hover, []);
  assert.equal(reviewDecorationGroups([]).size,0);
});


test("native source snapshots preserve CRLF offsets and send decorations without mutating text", async () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const window = {}, sent = [];
  vm.runInNewContext(fs.readFileSync(require.resolve("../editor-core.js"), "utf8"), { window });
  const editor = new window.MewEditorCore.VSCodeController((type, data) => sent.push(structuredClone({ type, data })), async (type, data) => { sent.push(structuredClone({ type, data })); return true; });
  const snapshot = { uri: "file:///test.html", version: 7, text: "a\r\nb\nc", readOnly: false,
    selections: [{ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 }] };
  editor.receive(snapshot);
  const model = editor.getModel();
  assert.equal(model.getOffsetAt({ lineNumber: 2, column: 1 }), 3);
  assert.equal(model.getPositionAt(3).lineNumber, 2);
  assert.equal(model.getValueInRange(editor.getSelection()), "b");
  editor.setSelection(editor.getSelection());
  assert.deepEqual(sent.at(-1).data.selections, snapshot.selections);
  editor.receive({ ...snapshot, layout: { splitView: true } });
  const hover = [{ value: 'HTML: b\n\nPDF: B' }];
  editor.showReviewHover(editor.getSelection(), hover, true);
  assert.equal(sent.at(-1).type, 'reviewHover');
  assert.deepEqual(sent.at(-1).data.range, snapshot.selections[0]);
  assert.deepEqual(sent.at(-1).data.hover, hover);
  assert.equal(sent.at(-1).data.focus, true);
  await editor.applyReviewEdits([{ start: 3, end: 4, text: "B" }], snapshot.text);
  assert.equal(sent.at(-1).type, "reviewApply");
  assert.equal(model.getValue(), snapshot.text);
  editor.receive({ ...snapshot, version: 8, text: "a\r\nB\nc" });
  assert.equal(editor.getModel(), model);
  assert.equal(model.getVersionId(), 8);
  const collection = editor.createDecorationsCollection();
  collection.set([{ range: editor.getSelection(), options: { inlineClassName: "mew-ocr-diff-text" } }]);
  assert.equal(sent.at(-1).type, "reviewDecorations");
  assert.equal(sent.at(-1).data.decorations[0].className, "mew-ocr-diff-text");
  collection.clear();
  assert.equal(sent.at(-1).data.decorations.length, 0);
});

test("native document commits retain host ownership and reject a stale model before IPC", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), window = {}, sent = [];
  const document = { body: { ownerDocument: { defaultView: {} } } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../editor-core.js"), "utf8"), { window, document });
  const editor = new window.MewEditorCore.VSCodeController(() => {}, async (type, data) => {
    sent.push(structuredClone({ type, data })); return true;
  });
  editor.receive({ uri: 'file:///first.html', version: 3, text: 'Alpha word.', readOnly: false });
  const owner = editor.document, snapshot = owner.snapshot;
  assert.equal(await owner.applyEdits([{ start: 6, end: 10, text: 'WORD', expected: 'word' }], { editor }), true);
  assert.equal(sent[0].type, 'reviewApply');
  assert.equal(sent[0].data.source, 'Alpha word.');
  assert.deepEqual(sent[0].data.edits, [{ start: 6, end: 10, text: 'WORD' }]);
  assert.equal(editor.getModel().getValue(), snapshot.source, 'only the native document host publishes committed text');
  editor.receive({ uri: 'file:///second.html', version: 3, text: snapshot.source, readOnly: false });
  assert.throws(() => owner.applyEdits([{ start: 6, end: 10, text: 'WORD' }], { editor }), /编辑器内容已变化/);
  assert.equal(sent.length, 1);
});

 test("string page labels match exactly and retain configured navigation order", () => {
  const [volume] = normalizedVolumes({pdf:"a.pdf",pagePattern:"^(.+)[.]html$",pages:["i","ii","iv","A","001",3]});
  assert.deepEqual(volume.explicitPages, ["i","ii","iv","A",1,3]);
  assert.equal(pageFromName("iv.html", "^(.+)[.]html$"), "iv");
  assert.equal(pageFromName("001.html", "^(.+)[.]html$"), 1);
  assert.equal(pageAtOrBefore(volume.explicitPages, "iv"), "iv");
  assert.equal(pageAtOrBefore(volume.explicitPages, "iii"), null);
  assert.equal(pageAtOrBefore(volume.explicitPages, "002"), 1);
  assert.equal(adjacentPage(volume.explicitPages, "iv", 1), "A");
  assert.equal(pageFromPdfLabel(""), null);
 });

test("native preview validates versioned edits before applying them to detached text", async () => {
  const fs = require('node:fs'), vm = require('node:vm'), window = {}, sent = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../editor-core.js'), 'utf8'), { window });
  const editor = new window.MewEditorCore.VSCodeController(() => {}, async (type, data) => { sent.push({ type, data }); return true; });
  editor.receive({ uri: 'file:///first.html', version: 3, text: 'word' });
  const edits = editor.document.validateEdits([{ start: 0, end: 4, text: 'WORD', expected: 'word' }]);
  await editor.previewReview({ before: 'word', after: 'word', edits });
  assert.equal(sent[0].type, 'reviewPreview');
  assert.equal(sent[0].data.after, 'WORD');
  assert.equal(editor.getValue(), 'word');
  editor.receive({ uri: 'file:///first.html', version: 4, text: 'newer' });
  assert.throws(() => editor.previewReview({ before: 'word', after: 'word', edits }), /编辑器内容已变化/);
  assert.equal(sent.length, 1);
});
