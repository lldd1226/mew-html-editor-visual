import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser } from './support/browser.mjs';
import { engineSource, highlightSource } from './support/pdf-harness.mjs';

test('missing popup and highlight share the paired edge despite intervening OCR noise', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="layer" style="position:relative;width:600px;height:200px;font:20px monospace"><span>word</span><span>noise</span><span>tail</span></div>');
    await page.addScriptTag({ content: engineSource + '\n' + highlightSource });
    const result = await page.evaluate(() => {
      const layer = document.getElementById('layer'), nodes = [...layer.children].map(span => span.firstChild);
      let target;
      const locator = new PdfReviewProvider.PdfLocator({}, { document, getVisiblePages: () => [{ index: target }] });
      const source = new window.PdfSelectionDiff.PdfConnections(locator, 'word missing tail');
      target = new PdfSelectionDiff.PdfConnections(locator, { raw: 'word noise tail', layer,
        parts: [{ start: 0, end: 4, node: nodes[0] }, { start: 5, end: 10, node: nodes[1] }, { start: 11, end: 15, node: nodes[2] }] });
      // Use the same full-document mapping for the rendered page and navigation.
      const full = new PdfSelectionDiff.PdfConnections(locator, { raw: target.raw, parts: target.parts,
        pages: [{ number: 1, start: 0, end: 15 }] });
      layer.className = 'page'; layer.dataset.pageNumber = '1';
      source.prepared = { full };
      source.connections.set(full, { preparedRanges: [
        { start: 0, end: 4, targetStart: 0, targetEnd: 4, target: full },
        { start: 13, end: 17, targetStart: 11, targetEnd: 15, target: full }
      ] });
      const hit = source.missingRange(target, 5, 12), navigation = source.missingRange(full, 5, 12);
      const item = { missing: true, pdfSource: { index: source, start: 5, end: 12 } };
      const anchor = locator.reviewAnchor(item, source);
      const measured = ReviewHighlights.create({ document }).measureHighlights(layer, target, [hit], hit);
      const range = document.createRange(); range.setStart(nodes[0], 4); range.collapse(true);
      const edge = range.getBoundingClientRect(), bounds = layer.getBoundingClientRect();
      return { hit, navigation, anchor, boxes: measured.boxes, expected: edge.left,
        highlight: bounds.left + measured.boxes[0].x * bounds.width + 2 };
    });
    assert.deepEqual(result.hit, { start: 4, end: 4, endBias: true });
    assert.deepEqual(result.navigation, result.hit);
    assert.equal(result.boxes.length, 1);
    assert.equal(result.boxes[0].caret, true);
    assert.ok(Math.abs(result.anchor.left - result.expected) < 1);
    assert.ok(Math.abs(result.highlight - result.expected) < 1);
  } finally { await browser.close(); }
});
