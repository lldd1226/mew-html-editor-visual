import assert from 'node:assert/strict';
import { launchBrowser } from './support/browser.mjs';

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  await page.addInitScript(preview => localStorage.setItem('mew-review-preview', String(preview)), process.env.PREVIEW === '1');
  const errors = [];
  page.on('pageerror', error => { errors.push(error.stack); console.error(error.stack); });
  page.context().on('page', p => p.on('pageerror', error => { errors.push(error.stack); console.error(error.stack); }));
  await page.context().route('**/api/reader/settings', route => route.fulfill({ json: {
    splitView: process.env.SINGLE_WINDOW !== '1', scale: '1.25', diffHighlight: true, sourceDiffHighlight: true,
    selectionHighlight: true, italicDetection: true, boldDetection: false
  } }));
  await page.goto(`${process.env.READER_URL || 'http://127.0.0.1:17000'}/?volume=6&page=579&mode=source`);
  await page.waitForFunction(() => window.PdfSelection?.locator.index?.prepared?.differences
    && document.querySelector('.mew-pdf-default-highlight > div'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.reviewEvents = [];
    addEventListener('pdf-selection-difference', event => reviewEvents.push({
      side: event.detail.side, notices: event.detail.notices.map(n => ({ missing: n.missing,
        html: n.html, pdf: n.pdf, version: n.source?.index.version, start: n.source?.start, end: n.source?.end }))
    }));
  });
  const snapshot = label => page.evaluate(label => {
    const locator = PdfSelection.locator, editor = PdfSelection.editor, index = locator.index;
    return { label, version: editor.getModel().getVersionId(), indexVersion: index.version,
      ownsEnvironment: index.environment === locator.environment,
      indexHasTargets: typeof index.environment.getTargets === 'function',
      sameSource: index.source === editor.getValue(), status: PdfSelection.status,
      items: index.prepared?.differences?.items.map(i => ({ id: i.id, missing: i.missing, comparison: i.comparison,
        sourceVersion: i.pdfSource?.index.version, range: i.range })),
      popup: [...document.querySelectorAll('.replacement-review')].map(p => ({ hidden: p.hidden,
        text: p.textContent, visibility: p.style.visibility })),
      pdfMarks: document.querySelectorAll('.mew-pdf-default-highlight > div').length,
      allPdfMarks: document.querySelectorAll('.mew-pdf-selection-highlight > div').length,
      missingPdf: locator.environment.getVisiblePages().flatMap(({ index: page }) => {
        const div = page?.layer?.closest('.page');
        return div ? (PdfReviewProvider.highlights.getHighlight(div, true)?.notices || []).filter(n => n.missing)
          .map(n => ({ box: n.box, start: n.source?.start, end: n.source?.end, version: n.source?.index.version })) : [];
      }),
      events: reviewEvents };
  }, label);
  console.log(JSON.stringify(await snapshot('initial')));
  await page.evaluate(() => {
    const editor = PdfSelection.editor, index = PdfSelection.locator.index;
    const word = index.raw.indexOf('handle'), item = index.prepared.differences.items.find(i =>
      !i.font && !i.missing && i.sourceStart >= word && i.sourceEnd <= word + 6);
    if (!item) throw new Error('handle correction not found');
    editor.revealRangeInCenter(editor.document.rangeAt(item.sourceStart, item.sourceEnd, true));
  });
  const sourcePage = page.context().pages().find(p => p !== page) || page;
  console.log('locator ownership', await sourcePage.evaluate(() => ({
    shared: PdfReviewProvider.locator === (opener?.PdfReviewProvider?.locator || PdfReviewProvider.locator)
  })));
  await sourcePage.locator('.mew-ocr-diff-insert').first().click();
  const popup = sourcePage.locator('.replacement-review:visible');
  await popup.waitFor({ timeout: 10000 });
  // Exercise the real apply-and-advance flow without writing the user's HTML.
  await page.evaluate(() => { PdfSelection.editor.document.write = async () => ({ mtime: PdfSelection.editor.document.mtime }); });
  await popup.locator('[data-save]').click();
  await page.waitForTimeout(1500);
  console.log('SOURCE POPUP', await sourcePage.locator('.replacement-review').textContent());
  if (process.env.CLOSE_DELAY) await page.waitForTimeout(Number(process.env.CLOSE_DELAY));
  console.log(JSON.stringify(await snapshot('after replace and advance')));
  await popup.locator('[data-close]').evaluate(button => button.click());
  await page.waitForTimeout(1500);
  const closed = await snapshot('closed');
  console.log(JSON.stringify(closed));
  const click = await page.evaluate(() => {
    const editor = PdfSelection.editor, index = PdfSelection.locator.index;
    const at = index.raw.indexOf('Siehe Band 5');
    if (at < 0) throw new Error('missing footnote source disappeared');
    const range = editor.document.rangeAt(at, at + 5, true);
    editor.revealRangeInCenter(range);
    editor.render(true);
    const position = { lineNumber: range.startLineNumber, column: range.startColumn + 3 };
    const point = editor.getScrolledVisiblePosition(position), rect = editor.getDomNode().getBoundingClientRect();
    return { x: rect.left + point.left + 1, y: rect.top + point.top + point.height / 2 };
  });
  await sourcePage.mouse.click(click.x, click.y);
  await page.waitForTimeout(1200);
  const reopened = await snapshot('clicked missing HTML');
  console.log(JSON.stringify(reopened));
  assert.ok(closed.missingPdf.length > 0, 'closing the next popup retains the missing PDF highlight');
  const openPopups = await Promise.all(page.context().pages().map(p => p.locator('.replacement-review:visible').count()));
  assert.ok(openPopups.reduce((a, b) => a + b, 0) > 0, 'clicking missing HTML opens review after replacement and close');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
