import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

for (const split of [false, true]) test(`${split ? 'split windows' : 'combined window'}: native blue selection paints double-clicks and drag jumps on the first frame`, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'mew-selection-interactions-'));
  let server, browser;
  try {
    await mkdir(path.join(fixture, '1'));
    await writeFile(path.join(fixture, '1/ME01-001.html'), '<p>Alpha Wording and another Wording finish this sentence.</p>');
    await writeFile(path.join(fixture, 'config.json'), JSON.stringify({ volumes: [{ id: '1', pdf: 'missing.pdf',
      pages: { directory: '1', pattern: '^ME01-([0-9]+)[.]html$' } }] }));
    server = await startServer('reader-server.js', 41884, ['-c', path.join(fixture, 'config.json')]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await context.route('**/api/reader/settings', route => route.fulfill({ json: {
      diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true, italicDetection: false, boldDetection: false
    } }));
    const reader = await context.newPage(), errors = [];
    reader.on('pageerror', error => errors.push(error.message));
    const session = `selection-${Date.now()}`;
    await reader.goto(`http://127.0.0.1:41884/?volume=1&page=1&mode=source${split ? `&view=reader&sync=${session}` : ''}`);
    await reader.waitForFunction(() => window.PdfSelection && window.ReaderUI?.getSourceEditor);
    let editor = reader;
    if (split) {
      const existing = context.pages().find(page => page !== reader && !page.isClosed());
      const opened = existing ? Promise.resolve(existing) : reader.waitForEvent('popup');
      await reader.evaluate(session => window.open(`/index.html?readerSession=${session}&file=1/ME01-001.html`, `mew-editor-${session}`), session);
      editor = await opened;
      editor.on('pageerror', error => errors.push(error.message));
    }
    await reader.waitForFunction(() => PdfSelection.editor?.getModel()?.getValue().includes('Alpha Wording'));
    await reader.evaluate(async () => {
      const editor = PdfSelection.editor, locator = PdfSelection.locator;
      const text = locator.editorSourceIndex(editor.document).raw.replaceAll('Wording', 'Vording');
      const stage = document.createElement('div');
      stage.style.cssText = 'position:fixed;bottom:20px;right:20px;width:650px;height:120px;z-index:10;background:white';
      stage.innerHTML = '<div class="pdfViewer"><div class="page" data-page-number="1" style="position:relative;width:650px;height:120px"><div class="textLayer"><span role="presentation" style="position:static;font:20px monospace;white-space:pre"></span></div></div></div>';
      document.body.append(stage);
      const div = stage.querySelector('.page'), span = div.querySelector('span');
      span.textContent = text;
      const pdfPage = { async getTextContent() { return { items: [
        { str: text, transform: [1, 0, 0, 1, 0, 100], width: 600, height: 20 }
      ] }; } };
      const pdf = { numPages: 1, async getPage() { return pdfPage; } }, view = { div, pdfPage };
      const viewer = { pdfDocument: pdf, container: stage, viewer: stage.querySelector('.pdfViewer'),
        getPageView: () => view, _getVisiblePages: () => ({ views: [{ id: 1 }] }),
        eventBus: { on() {}, off() {} }, scrollPageIntoView() {} };
      ReaderUI.getPdfViewer = () => viewer;
      ReaderUI.getPdfSourcePages = () => [1];
      window.interactionEditor = editor;
      window.interactionScan = span;
      const showReviewPointer = PdfSelection.showReviewPointer;
      PdfSelection.showReviewPointer = function (editor, items, key) {
        if (!key) window.interactionReviewItems = items;
        return showReviewPointer.call(this, editor, items, key);
      };
      PdfSelection.attachViewer(viewer);
      await locator.indexDocument(pdf, [1]);
      PdfSelection.refresh();
    });
    await editor.waitForFunction(() => !!document.querySelector('.mew-ocr-diff-text'));
    await reader.evaluate(() => {
      const editor = interactionEditor, getSelections = editor.getSelections, range = PdfSelectionDiff.PdfConnections.prototype.range;
      let readingSelection = false;
      window.synchronousSelectionQueries = 0;
      editor.getSelections = function (...args) {
        readingSelection = true;
        queueMicrotask(() => { readingSelection = false; });
        return getSelections.apply(this, args);
      };
      PdfSelectionDiff.PdfConnections.prototype.range = function (...args) {
        if (readingSelection) synchronousSelectionQueries++;
        return range.apply(this, args);
      };
    });
    const point = await editor.evaluate(split => {
      const editor = split ? mewWorkbench.editor : readerMonaco.editor, model = editor.getModel();
      const position = model.getPositionAt(model.getValue().indexOf('Wording') + 3);
      const box = editor.getDomNode().getBoundingClientRect(), point = editor.getScrolledVisiblePosition(position);
      return { x: box.left + point.left, y: box.top + point.top + point.height / 2 };
    }, split);
    await editor.mouse.click(point.x, point.y);
    await editor.mouse.down({ clickCount: 2 });
    const immediate = await reader.evaluate(() => new Promise(resolve => interactionEditor.getDomNode().ownerDocument.defaultView.requestAnimationFrame(() => {
      const editor = interactionEditor;
      const range = editor.getSelection(), start = editor.getScrolledVisiblePosition(range.getStartPosition()), end = editor.getScrolledVisiblePosition(range.getEndPosition());
      resolve({ selected: editor.getModel().getValueInRange(range),
        blueWidth: [...editor.getDomNode().querySelectorAll('.selected-text')].reduce((sum, node) => sum + node.getBoundingClientRect().width, 0),
        expectedWidth: end.left - start.left });
    })));
    assert.equal(immediate.selected, 'Wording');
    assert.ok(Math.abs(immediate.blueWidth - immediate.expectedWidth) < 2, 'the native blue selection covers the complete word on the first editor frame');
    assert.equal(await reader.evaluate(() => synchronousSelectionQueries), 0, 'PDF comparison never blocks the native selection event');
    await editor.mouse.up({ clickCount: 2 });
    const selected = () => reader.evaluate(() => {
      const editor = interactionEditor;
      return editor.getModel().getValueInRange(editor.getSelection());
    });
    assert.equal(await selected(), 'Wording', 'Monaco double-click keeps the full native word selection');
    await editor.locator('.replacement-review').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await editor.locator('.replacement-review [data-comparison]').textContent(), /Wording/);
    assert.equal(await selected(), 'Wording', 'opening the selection popup must not shrink the word');
    assert.equal(await reader.evaluate(() => interactionReviewItems.length), 2,
      'the double-click selection reuses the matching replacement group');
    if (split) {
      await reader.locator('.replacement-review').waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await reader.locator('.replacement-review [data-comparison]').textContent(),
        await editor.locator('.replacement-review [data-comparison]').textContent(), 'both popup hosts share the full selection comparison');
      assert.equal(await reader.evaluate(() => PdfSelection.locator === interactionEditor.getDomNode().ownerDocument.defaultView.PdfReviewProvider.locator),
        true, 'the split editor uses the reader locator');
    }
    await reader.evaluate(() => ReplacementReview.close(false, false));
    await editor.evaluate(() => ReplacementReview.close(false, false));
    const drag = await reader.evaluate(() => {
      const editor = interactionEditor, model = editor.getModel(), source = model.getValue();
      editor.setPosition(model.getPositionAt(0)); editor.focus();
      const start = source.indexOf('Wording'), end = source.indexOf('finish') - 1, box = editor.getDomNode().getBoundingClientRect();
      const points = [start, end].map(offset => {
        const point = editor.getScrolledVisiblePosition(model.getPositionAt(offset));
        return { x: box.left + point.left, y: box.top + point.top + point.height / 2 };
      });
      const setSelection = editor.setSelection;
      window.selectionWritesDuringDrag = 0;
      window.nativeDragActive = true;
      editor.setSelection = function (...args) {
        if (nativeDragActive) selectionWritesDuringDrag++;
        return setSelection.apply(this, args);
      };
      return { points, text: source.slice(start, end) };
    });
    await editor.mouse.move(drag.points[0].x, drag.points[0].y);
    await editor.mouse.down();
    await editor.mouse.move(drag.points[1].x, drag.points[1].y, { steps: 1 });
    const jumped = await reader.evaluate(() => new Promise(resolve => interactionEditor.getDomNode().ownerDocument.defaultView.requestAnimationFrame(() => {
      const editor = interactionEditor, range = editor.getSelection();
      const start = editor.getScrolledVisiblePosition(range.getStartPosition()), end = editor.getScrolledVisiblePosition(range.getEndPosition());
      resolve({ text: editor.getModel().getValueInRange(range), writes: selectionWritesDuringDrag,
        blueWidth: [...editor.getDomNode().querySelectorAll('.selected-text')].reduce((sum, node) => sum + node.getBoundingClientRect().width, 0),
        expectedWidth: end.left - start.left });
    })));
    assert.equal(jumped.text, drag.text, 'a single mouse move selects the complete passage immediately');
    assert.equal(jumped.writes, 0, 'review code never rewrites the native drag selection');
    assert.ok(Math.abs(jumped.blueWidth - jumped.expectedWidth) < 2, 'the native blue selection reaches the new endpoint on its first frame');
    await reader.evaluate(() => { nativeDragActive = false; });
    await editor.mouse.up();
    await editor.waitForFunction(() => document.querySelector('.replacement-review [data-comparison]')?.textContent.includes('another'));
    await reader.evaluate(() => ReplacementReview.close(false, false));
    await editor.evaluate(() => ReplacementReview.close(false, false));
    const pdfPoint = await reader.evaluate(() => {
      const node = interactionScan.firstChild, start = node.textContent.indexOf('Vording'), range = document.createRange();
      range.setStart(node, start + 2); range.setEnd(node, start + 3);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await reader.mouse.click(pdfPoint.x, pdfPoint.y);
    await reader.mouse.down({ clickCount: 2 });
    await reader.mouse.up({ clickCount: 2 });
    const reverseImmediate = await reader.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const editor = interactionEditor;
      resolve({ native: document.getSelection().toString(), source: editor.getModel().getValueInRange(editor.getSelection()) });
    })));
    assert.equal(reverseImmediate.native.trim(), 'Vording');
    assert.equal(reverseImmediate.source, reverseImmediate.native.replace('Vording', 'Wording'));
    const nativeWord = await reader.evaluate(() => document.getSelection().toString());
    assert.equal(nativeWord.trim(), 'Vording');
    assert.equal(await selected(), nativeWord.replace('Vording', 'Wording'), 'PDF double-click maps the complete native range back to the source');
    const saved = editor.waitForResponse(response => ['POST', 'PUT'].includes(response.request().method())
      && /\/api\/(save|reader\/page\/)/.test(response.url()));
    await editor.locator('.replacement-review [data-save]').click();
    assert.equal((await saved).ok(), true);
    await editor.waitForFunction(split => (split ? mewWorkbench.editor : readerMonaco.editor).getValue().includes('Alpha Vording'), split);
    assert.equal(await readFile(path.join(fixture, '1/ME01-001.html'), 'utf8'),
      '<p>Alpha Vording and another Vording finish this sentence.</p>', 'the source window saves the shared double-click replacement group');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await stopServer(server);
    await rm(fixture, { recursive: true, force: true });
  }
});
