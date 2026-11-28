import assert from 'node:assert/strict';
import { launchBrowser } from './support/browser.mjs';

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/api/reader/settings', route => route.fulfill({ json: {
    scale: '1.25', diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true
  } }));
  for (const number of [397, 400]) {
    await page.goto(`${process.env.READER_URL || 'http://127.0.0.1:17000'}/?volume=6&page=${number}&mode=source`);
    await page.waitForFunction(() => {
      const source = window.PdfSelection?.locator?.index, item = source?.getDifferences().items.find(item => item.missing);
      return item && PdfSelection.locator.environment.getVisiblePages().some(({ index }) =>
        index?.layer?.isConnected && source.missingRange(index, item.sourceStart, item.sourceEnd));
    }, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const geometry = await page.evaluate(async () => {
      const locator = PdfSelection.locator, source = locator.index;
      const item = source.getDifferences().items.find(item => item.missing);
      const visible = locator.environment.getVisiblePages().find(({ index }) => source.missingRange(index, item.sourceStart, item.sourceEnd));
      const hit = source.missingRange(visible.index, item.sourceStart, item.sourceEnd);
      item.pdfSource = source.entry(item.sourceStart, item.sourceEnd, true);
      const anchor = locator.reviewAnchors([item.pdfSource]).get(item.pdfSource), bounds = visible.index.layer.getBoundingClientRect();
      const part = visible.index.fontRuns(hit.start - 1, hit.start - 1, true)[0];
      const range = document.createRange(); range.setStart(part.node, hit.start - part.start); range.collapse(true);
      const expected = range.getBoundingClientRect();
      const div = visible.index.layer.closest('.page'), pageBounds = div.getBoundingClientRect();
      const measured = PdfReviewProvider.highlights.measureHighlights(div, visible.index, [hit], hit);
      const content = await PdfSelection.viewer.getPageView(visible.number - 1).pdfPage.getTextContent();
      const last = content.items.find(item => item.str?.endsWith('sondern als'));
      return { anchor, right: bounds.right, left: bounds.left, expected: expected.left,
        highlight: pageBounds.left + measured.boxes[0].x * div.clientWidth + div.clientLeft + 2,
        renderedWidth: part.node.parentElement.closest('span[role="presentation"]').getBoundingClientRect().width,
        pdfWidth: last && last.width * PdfSelection.viewer.getPageView(visible.number - 1).viewport.scale };
    });
    assert.ok(geometry.anchor.left >= geometry.left && geometry.anchor.left <= geometry.right, 'missing anchor stays on the page');
    assert.ok(Math.abs(geometry.anchor.left - geometry.expected) < 1, 'popup uses the last paired word edge');
    assert.ok(Math.abs(geometry.highlight - geometry.expected) < 1, 'highlight uses the same edge');
    if (number === 400) assert.ok(Math.abs(geometry.renderedWidth - geometry.pdfWidth) < 1, `text-layer width matches PDF geometry: ${JSON.stringify(geometry)}`);
    if (number !== 400) continue;
    const before = await page.evaluate(() => readerMonaco.editor.getValue());
    let previous = 'als';
    try {
      for (const word of ['ALSW', 'a', '', 'als', 'alsX', 'als']) {
        await page.evaluate(({ previous, word }) => {
          const editor = readerMonaco.editor, model = editor.getModel();
          const offset = model.getValue().lastIndexOf('sondern ') + 'sondern '.length;
          if (offset < 0) throw new Error('last word not found');
          editor.executeEdits('regression', [{ range: editor.document.rangeAt(offset, offset + previous.length), text: word }]);
        }, { previous, word });
        await page.waitForFunction(() => PdfSelection.locator.index.source === readerMonaco.editor.getValue(), null, { timeout: 10000 });
        await page.waitForTimeout(500);
        const result = await page.evaluate(() => {
          const source = PdfSelection.locator.index, items = source.getDifferences().items;
          return { missing: items.filter(item => item.missing).map(item => item.comparison.html),
            differences: items.filter(item => item.comparison).map(item => item.comparison),
            error: PdfSelection.status.error };
        });
        assert.equal(result.error, null);
        assert.ok(result.missing.some(text => text.includes('1 (1891) sind') && text.includes('Arbeitskraft, die')), `footnotes stay missing after ${JSON.stringify(word)}: ${JSON.stringify(result)}`);
        assert.ok(!result.differences.some(item => item.pdf && item.html.includes('(1891)')), 'footnotes never map to letters in als');
        const expected = { ALSW: ['ALSW', 'als'], a: ['', 'ls'], '': ['', 'als'], alsX: ['X', ''] }[word];
        if (expected) assert.ok(result.differences.some(item => item.html === expected[0] && item.pdf === expected[1]), `edited word updates: ${JSON.stringify(result)}`);
        previous = word;
      }
    } finally { await page.evaluate(before => readerMonaco.editor.setValue(before), before); }
    console.log('ME06-397/400: missing popup/highlight geometry and repeated last-word edits passed.');
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
