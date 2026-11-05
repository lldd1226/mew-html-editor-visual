import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-default-click-'));
let server, browser;
try {
  const before = 'The opening passage supplies enough unique words to establish a reliable comparison. ';
  const after = ' The closing passage also contains unique words so the text is mapped reliably.';
  await writeFile(path.join(fixture, 'a.html'), '<p>' + before + 'WRONG' + after + '</p>');
  server = await startServer('server.js', 41881, ['-r', fixture]);
  browser = await launchBrowser();
  for (const counterpart of ['RIGHT', '']) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.error(message.text()); });
  await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true, selectionHighlight: true, italicDetection: false, boldDetection: false } }));
  await page.goto('http://127.0.0.1:41881/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor.getValue().includes('WRONG') && window.PdfReviewProvider);
  await page.evaluate(raw => {
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;right:0;top:500px;width:700px;height:300px;background:white;z-index:100';
    stage.innerHTML = '<div class="pdfViewer"><div class="page" data-page-number="1" style="position:relative;width:700px;height:300px"><div class="textLayer" style="font:16px monospace;white-space:pre-wrap"><span></span></div></div></div>';
    stage.querySelector('span').textContent = raw;
    // PDF.js changes this class on pointerdown, before the click's pointerup.
    const layer = stage.querySelector('.textLayer');
    layer.addEventListener('pointerdown', () => layer.classList.add('selecting'));
    document.addEventListener('pointerup', () => layer.classList.remove('selecting'));
    document.body.append(stage);
    const div = stage.querySelector('.page');
    window.mockViewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
      _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }),
      eventBus: { on() {}, off() {} },
      pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() {
        return { items: [{ str: raw, transform: [1, 0, 0, 1, 0, 200], width: 700, height: 20 }] };
      } }; } } };
    window.ReaderUI = { getPdfViewer: () => mockViewer };
    window.clickNotices = [];
    addEventListener('pdf-selection-difference', event => clickNotices.push(event.detail));
  }, before + counterpart + after);
  await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
  await page.waitForFunction(() => window.PdfSelection);
  const marker = page.locator('.mew-pdf-default-highlight > div').first();
  try { await marker.waitFor({ state: 'visible', timeout: 5000 }); }
  catch (error) {
    console.error(await page.evaluate(() => ({ status: PdfSelection.status, editor: !!PdfSelection.editor, source: PdfSelection.locator.index?.raw, items: PdfSelection.locator.review?.items?.length, text: mewWorkbench.editor.document?.snapshot, errors: document.querySelectorAll('.mew-ocr-diff-text').length })));
    throw error;
  }
  assert.equal(await page.locator('.replacement-review:visible').count(), 0);
  assert.equal(await page.evaluate(() => mewWorkbench.editor.getSelection().isEmpty()), true);
  const box = await marker.boundingBox();
  await page.mouse.move(counterpart ? box.x + box.width / 2 : box.x - 6, box.y + box.height / 2);
  await page.mouse.down();
  assert.equal(await marker.isVisible(), true, 'PDF.js selection class must retain the default marker until pointerup');
  await page.mouse.up();
  try { await page.locator('.replacement-review:visible').waitFor({ timeout: 3000 }); }
  catch (error) {
    console.error(await page.evaluate(() => ({ notices: clickNotices.map(n => ({ side: n.side, notices: n.notices.map(v => ({html: v.html, pdf: v.pdf, source: v.source && [v.source.start, v.source.end]})) })), status: PdfSelection.status })));
    throw error;
  }
  assert.deepEqual(await page.locator('.replacement-review [data-comparison] mark').allTextContents(), ['WRONG', counterpart]);
  for (const edge of counterpart ? ['center'] : ['right', 'top', 'bottom']) {
  await page.evaluate(() => {
    ReplacementReview.close();
    mewWorkbench.editor.setPosition({ lineNumber: 1, column: 1 });
    PdfSelection.clearReviewPointer(); PdfSelection.clear();
  });
  await marker.waitFor({ state: 'visible', timeout: 3000 });
  const again = await marker.boundingBox();
  await page.mouse.click(edge === 'right' ? again.x + again.width + 6 : again.x + again.width / 2,
    edge === 'top' ? again.y - 2 : edge === 'bottom' ? again.y + again.height + 2 : again.y + again.height / 2);
  await page.locator('.replacement-review:visible').waitFor({ timeout: 3000 });
  }
  assert.deepEqual(errors, []);
  console.log(`Default PDF difference: ${counterpart ? 'text marker' : 'caret left/right/top/bottom padding'} opens the real review popup`);
  await page.close();
  }
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
