import assert from 'node:assert/strict';
import { launchBrowser } from './support/browser.mjs';
// Uses the reader instance which already owns the configured library.
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: {
    scale: '1.25', diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true
  } }));
  await page.goto(`${process.env.READER_URL || 'http://127.0.0.1:17000'}/?volume=6&page=292&mode=source`);
  await page.waitForFunction(() => {
    const locator = window.PdfSelection?.locator, source = locator?.index;
    const visible = locator?.environment.getVisiblePages().find(page => page.index?.raw.endsWith('20275354 „'));
    if (!source?.prepared || !visible) return false;
    const start = source.raw.indexOf('.........50 863 150', 3600);
    const hit = source.range(visible.index, start, start + 9, false, undefined, true);
    if (!hit || hit.start !== hit.end) return false;
    const div = visible.index.layer.closest('.page');
    const measured = PdfReviewProvider.highlights.measureHighlights(div, visible.index,
      [{ ...hit, difference: { html: '.........', pdf: '' } }]).boxes;
    return measured.some(box => [...div.querySelectorAll('.mew-pdf-default-highlight>div')].some(mark =>
      Math.abs(parseFloat(mark.style.left) / 100 - box.x) < .0001
      && Math.abs(parseFloat(mark.style.top) / 100 - box.y) < .0001));
  }, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => readerMonaco.editor.getSelection().isEmpty()), true);
  assert.equal(await page.locator('.replacement-review:visible').count(), 0);
  // A visible text layer can exist before selection geometry becomes measurable.
  await page.evaluate(() => {
    const viewer = PdfSelection.viewer, reveal = viewer.scrollPageIntoView.bind(viewer);
    window.selectionReveals = 0;
    viewer.scrollPageIntoView = (...args) => { selectionReveals++; return reveal(...args); };
    const highlights = PdfReviewProvider.highlights, measure = highlights.measureHighlights;
    highlights.measureHighlights = (...args) => ({ ...measure(...args), focus: null });
    const source = PdfSelection.locator.index, editor = readerMonaco.editor;
    const start = source.raw.indexOf('.........50 863 150', 3600);
    editor.setSelection(editor.document.rangeAt(start, start + 9, true));
  });
  await page.waitForFunction(() => selectionReveals > 0, null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const viewer = PdfSelection.viewer, bounds = viewer.container.getBoundingClientRect();
    return [...document.querySelectorAll('.mew-pdf-selection-highlight>div')].some(mark => {
      const box = mark.getBoundingClientRect();
      return box.height && box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
  }, null, { timeout: 10000 });
  assert.deepEqual(errors, []);
  console.log('ME06-291 / page 292: final dotted-line difference is highlighted on initial load without selection.');
} finally { await browser.close(); }

