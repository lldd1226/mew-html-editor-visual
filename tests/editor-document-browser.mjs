import { launchBrowser, startServer, stopServer } from './support/browser.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-document-'));
let server, browser;
try {
  await writeFile(path.join(fixture, 'a.html'), '<p>Original</p>');
  await writeFile(path.join(fixture, 'config.json'), JSON.stringify({ editorRoot: '.', volumes: [
    { id: '1', pages: { directory: '.', pattern: '^(a)[.]html$' }, pdf: 'missing.pdf' }
  ] }));
  server = await startServer('reader-server.js', 41875, ['-c', path.join(fixture, 'config.json')]);
  browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('http://127.0.0.1:41875/index.html?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor.getModel());
  assert.equal(await page.evaluate(() => {
    const { DocumentModel, MonacoController } = MewEditorCore;
    const host = document.createElement('div');
    const controller = new MonacoController(monaco, host);
    const documentModel = new DocumentModel({ text: 'ab', api: monaco });
    const model = documentModel.model;
    controller.setDocument(documentModel);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    try {
      check(controller.editor.document === documentModel, 'editor model has one document owner');
      // Offsets refer to the resulting text, so convert them after the edit.
      documentModel.applyEdits([{ start: 1, end: 2, text: 'LONG' }], { editor: controller.editor, selections: [{ start: 1, end: 5 }] });
      check(controller.editor.getSelection().endColumn === 6, 'selection was clamped before insertion');
      model.undo();
      check(model.getValue() === 'ab', 'offset edits undo as one operation');
      const range = new monaco.Range(1, 1, 1, 2), selection = new monaco.Selection(1, 1, 1, 2);
      documentModel.applyEdits([{ range, text: 'X', forceMoveMarkers: false }], { editor: controller.editor, selections: [selection] });
      check(model.getValue() === 'Xb', 'native edit operation');
      check(controller.editor.getSelection().equalsSelection(selection), 'native selection');
      model.undo();
      check(model.getValue() === 'ab', 'native edits undo as one operation');
      const staleEdits = documentModel.validateEdits([{ range, text: 'old' }]);
      controller.setValue('updated', true);
      check(model.getValue() === 'updated', 'full replacement');
      let rejected = false;
      try { documentModel.applyEdits(staleEdits, { editor: controller.editor }); }
      catch { rejected = true; }
      check(rejected, 'stale native edits must reject');
      model.undo();
      check(model.getValue() === 'ab', 'full replacement preserves undo');
      return true;
    } finally { controller.editor.dispose(); model.dispose(); }
  }), true, 'shared controller transaction supports offsets, native edits, selections and undo');
  await page.evaluate(() => mewWorkbench.editor.setValue('<p>Restored draft</p>'));
  await page.waitForFunction(() => Object.keys(sessionStorage).some(key => key.startsWith('mew.editor.session.v1:')
    && sessionStorage.getItem(key).includes('Restored draft')));
  await page.reload();
  await page.waitForFunction(() => mewWorkbench?.editor.getValue() === '<p>Restored draft</p>'
    && mewWorkbench.documents.get('a.html')?.dirty);
  assert.equal(await readFile(path.join(fixture, 'a.html'), 'utf8'), '<p>Original</p>', 'draft recovery does not write the source file');
  await page.evaluate(() => { window.documentBeforeSaveAs = mewWorkbench.documents.get('a.html'); });
  let releaseCreate, createStarted;
  const createGate = new Promise(resolve => { releaseCreate = resolve; });
  const started = new Promise(resolve => { createStarted = resolve; });
  await page.route('**/api/create', async route => {
    createStarted(); await createGate; await route.continue();
  });
  const saving = page.evaluate(() => mewWorkbench.saveAs());
  await page.locator('#fileNameInput').fill('copy.html');
  await page.locator('#fileDialogSubmit').click();
  await started;
  await page.evaluate(() => mewWorkbench.editor.setValue('<p>Newer draft</p>'));
  releaseCreate(); await saving;
  assert.deepEqual(await page.evaluate(() => {
    const current = mewWorkbench.documents.get('copy.html');
    if (!current) return { paths: [...mewWorkbench.documents.keys()], status: document.querySelector('#status').textContent,
      value: mewWorkbench.editor.getValue(), uri: mewWorkbench.editor.getModel()?.uri.path };
    return { changedOwner: current !== documentBeforeSaveAs, released: documentBeforeSaveAs.model === null,
      dirty: current.dirty, saved: current.savedContent, content: current.content,
      bound: mewWorkbench.editor.getModel() === current.model, uri: current.model.uri.path };
  }), { changedOwner: true, released: true, dirty: true, saved: '<p>Restored draft</p>', content: '<p>Newer draft</p>',
    bound: true, uri: '/copy.html' }, 'save-as transfers the view to the new document and retains edits made during the write');
  assert.equal(await readFile(path.join(fixture, 'copy.html'), 'utf8'), '<p>Restored draft</p>');
  await page.evaluate(() => mewWorkbench.save());
  assert.equal(await readFile(path.join(fixture, 'copy.html'), 'utf8'), '<p>Newer draft</p>');
  await page.evaluate(() => mewWorkbench.openFile('a.html'));
  assert.equal(await page.evaluate(() => mewWorkbench.editor.getValue()), '<p>Original</p>', 'the old URI can be reopened after model disposal');
  assert.deepEqual(errors, []);
  console.log('PASS: native edits/selections/undo/stale rejection, draft recovery, save-as during editing and URI disposal/reopening.');
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
