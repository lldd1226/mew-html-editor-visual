import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';
const server = await startServer('reader-server.js', 17065);
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: {
    scale: '1', diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true
  } }));
  await page.goto('http://127.0.0.1:17065/?volume=32&page=323&mode=source');
  await page.waitForFunction(() => {
    const editor = window.readerMonaco?.editor, locator = window.PdfSelection?.locator;
    if (!editor?.getModel() || !locator) return false;
    const index = locator.editorSourceIndex(editor.document), at = index.raw.indexOf('etc.1)') + 4;
    return editor.getModel().getAllDecorations().some(mark => mark.options.description === 'PDF OCR text difference'
      && editor.getModel().getValueInRange(mark.range) === '1'
      && editor.getModel().getOffsetAt(mark.range.getStartPosition()) === index.starts[at]);
  }, null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('.mew-pdf-default-highlight>div'));
  const result = await page.evaluate(() => {
    const editor = readerMonaco.editor, model = editor.getModel(), locator = PdfSelection.locator;
    const index = locator.editorSourceIndex(editor.document), at = index.raw.indexOf('etc.1)') + 4;
    const page = locator.environment.getVisiblePages().find(page => page.index?.raw.includes('Varlin'));
    const hit = index.range(page.index, at, at + 1, false, undefined, true);
    const measured = PdfReviewProvider.highlights.measureHighlights(page.index.layer.closest('.page'), page.index, [hit], hit);
    const painted = [...document.querySelectorAll('.mew-pdf-default-highlight>div')].map(node => node.getBoundingClientRect());
    editor.setSelection(editor.document.rangeAt(at, at + 1, true));
    return { caret: hit.start === hit.end, first: /Varlin\s+etc\.\s*$/.test(page.index.raw.slice(0, hit.start)),
      boxes: measured.boxes, painted: painted.map(({x,y,width,height})=>({x,y,width,height})) };
  });
  assert.ok(result.caret && result.first, 'footnote deletion maps to the first etc.');
  assert.ok(result.boxes.length && result.painted.length, 'PDF default overlays and deletion geometry are present');
  await page.waitForFunction(() => PdfSelection.status.matches > 0);
  assert.deepEqual(errors, []);
  console.log('ME32-323: source footnote deletion marked on load; PDF caret and selection highlight present.');
} finally { await browser?.close(); await stopServer(server); }



