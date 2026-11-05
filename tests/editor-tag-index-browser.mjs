import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-tag-index-'));
const cores = await Promise.all(['../public/editor-core.js', '../mew-html-reader-vscode/editor-core.js']
  .map(file => readFile(new URL(file, import.meta.url), 'utf8')));
const baseline = process.argv[2] ? await readFile(process.argv[2], 'utf8') : null;
const baselineTags = process.argv[3] ? await readFile(process.argv[3], 'utf8') : null;
let server, browser;
try {
  await writeFile(path.join(fixture, 'a.html'), '<p>Tag index fixture</p>');
  server = await startServer('server.js', 41883, ['-r', fixture]);
  browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:41883/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor.getModel() && window.MewTagPanel);
  const result = await page.evaluate(({ cores, baseline, baselineTags }) => {
    const currentCore = window.MewEditorCore, { TagEditor, tags, attrs } = MewTagPanel;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const cases = [
      '<p>Plain text</p>', '<p><b>bold <i>both</i></b></p>',
      '<p align="CENTER">center</p><p align=right>right</p>',
      '<p style="font-weight:700;font-style:italic">styled <span style="font-weight:normal">normal</span></p>',
      '<p><strong>strong</strong> <em>em</em></p>', '<p>A &amp; B &#160; &#x1f600;</p>',
      '<p>CRLF</p>\r\n<p>next</p>', '<p>A<br>B<hr/><img src="x">C</p>',
      '<head><title>Title <b>literal</b></title><style>b{color:red}</style></head><p>Body</p>',
      '<script>const text="<b>literal</b>";</script><p>Body</p>',
      '<textarea><b>literal</b></textarea><title><i>literal</i></title>',
      '<p><!-- <b>comment</b> -->visible</p>', '<p>before<!-- <b>unfinished</b>',
      '<p><b>wrong</i></p>', '<b><i>crossed</b></i>', '<div><p>unclosed',
      '<!DOCTYPE html><html><body><p>Page</p></body></html>',
      '<!BAD <b>decl</b>><p>Body</p>', '<p data-x=">">quoted</p>',
      '<p><a href="x"><sup>1</sup></a> note</p>', '<p/><custom-tag>custom</custom-tag>'
    ];
    const pairData = values => JSON.stringify(values.map(pair =>
      [pair.name, pair.closeName ?? null, pair.start, pair.openEnd, pair.closeStart, pair.end, pair.open, pair.id]));
    const tagData = tag => tag && [tag.name, tag.open ?? tag.opening, tag.start ?? tag.openStart, tag.openEnd,
      tag.rawStart, tag.rawEnd, tag.closeEnd, tag.closing, tag.italic, tag.bold,
      'openStart' in tag ? tag.closeStart : tag.fontCloseStart];
    const formatData = index => JSON.stringify([index.raw, index.starts, index.ends,
      index.formats.map(frame => [frame.name, frame.italic, frame.bold, tagData(frame.definition), frame.tags.map(tagData)])]);
    let pairCases = 0, baselineCases = 0, editCases = 0;
    const reference = [], referencePairs = [];
    if (baselineTags) {
      window.eval(baselineTags);
      for (const text of cases) referencePairs.push(pairData(new MewTagPanel.TagEditor({ getValue: () => text }).detected.pairs));
      window.MewTagPanel = { ...window.MewTagPanel, TagEditor };
    }
    try {
      if (baseline) {
        window.eval(baseline);
        const ReferenceDocument = MewEditorCore.DocumentModel;
        for (const text of cases) {
          const model = monaco.editor.createModel(text, 'html');
          try {
            const documentModel = new ReferenceDocument({ text, model });
            reference.push(formatData(documentModel.parse ? documentModel.parse(document) : documentModel.index(document)));
          } finally { model.dispose(); }
        }
      }
      for (const [implementation, source] of cores.entries()) {
        window.eval(source);
        const Document = MewEditorCore.DocumentModel;
        for (const [at, text] of cases.entries()) {
          const model = monaco.editor.createModel(text, 'html');
          try {
            const owner = new Document({ text, model }), index = owner.parse(document);
            const standalone = new TagEditor({ getValue: () => model.getValue() });
            const shared = new TagEditor({ getValue: () => model.getValue(), document: owner });
            check(pairData(shared.document.parse().tags.pairs) === pairData(standalone.document.parse().tags.pairs), `Pair parity: core ${implementation}, case ${at}`);
            if (baselineTags) check(pairData(index.tags.pairs) === referencePairs[at], `Detect baseline parity: core ${implementation}, case ${at}`);
            if (index.tags) {
              check(shared.document.parse().tags === index.tags, `Shared tag data not reused: ${at}`);
              for (const frame of index.formats) {
                const pair = frame.definition && index.tags.byStart.get(frame.definition.start);
                if (pair) check(pair === frame.definition, `Definition duplicated: ${at}`);
              }
            }
            check(owner.parse(document) === owner.index, `Index not retained: ${at}`);
            if (baseline) {
              check(formatData(index) === reference[at], `Formatting baseline parity: core ${implementation}, case ${at}`);
              baselineCases++;
            }
            pairCases++;
          } finally { model.dispose(); }
        }
      }
    } finally { window.MewEditorCore = currentCore; }

    const bold = tags.find(tag => tag.id === 'b');
    const operations = [
      { text: '<p>Before <b>word</b> after.</p>', words: ['word'], expected: '<p>Before word after.</p>', selected: ['word'] },
      { text: '<p><b>one <b>two</b></b></p>', words: ['one', 'two'], expected: '<p>one two</p>', selected: ['one', 'two'] },
      { text: '<p>one two</p>', words: ['one', 'two'], expected: '<p><b>one</b> <b>two</b></p>', selected: ['', ''] },
      { text: '<p>one</p>', caret: 2, item: attrs.find(attr => attr.id === 'idAttr'), expected: '<p id="">one</p>', selected: [''] }
    ];
    for (const mode of ['standalone', 'owned-lazy', 'owned-shared']) for (const operation of operations) {
      const host = document.createElement('div');
      host.style.cssText = 'height:200px;width:600px'; document.body.append(host);
      const model = monaco.editor.createModel(operation.text, 'html');
      const editor = monaco.editor.create(host, { model, minimap: { enabled: false } });
      try {
        if (mode !== 'standalone') {
          editor.document = new currentCore.DocumentModel({ model, text: operation.text });
          if (mode === 'owned-shared') editor.document.parse(document);
        }
        const panel = new TagEditor(editor);
        const ranges = operation.words?.map(word => [operation.text.indexOf(word), operation.text.indexOf(word) + word.length])
          || [[operation.caret, operation.caret]];
        editor.setSelections(ranges.map(([start, end]) => monaco.Selection.fromPositions(model.getPositionAt(start), model.getPositionAt(end))));
        panel.applyTag(operation.item || bold);
        check(model.getValue() === operation.expected, `Edit output: ${mode}, ${operation.text}`);
        check(JSON.stringify(editor.getSelections().map(range => model.getValueInRange(range))) === JSON.stringify(operation.selected), `Selections: ${mode}`);
        model.undo(); check(model.getValue() === operation.text, `Single undo: ${mode}`);
        model.redo(); check(model.getValue() === operation.expected, `Redo: ${mode}`);
        editor.updateOptions({ readOnly: true });
        let rejected = false;
        try { panel.applyTag(bold); } catch { rejected = true; }
        check(rejected && model.getValue() === operation.expected, `Read-only edit: ${mode}`);
        editCases++;
      } finally { editor.dispose(); model.dispose(); host.remove(); }
    }
    return { pairCases, baselineCases, editCases };
  }, { cores, baseline, baselineTags });
  assert.deepEqual(errors, []);
  console.log(`PASS: ${result.pairCases} shared/standalone pair cases, ${result.baselineCases} formatting baseline cases, ${result.editCases} native editing/undo/read-only cases.`);
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
