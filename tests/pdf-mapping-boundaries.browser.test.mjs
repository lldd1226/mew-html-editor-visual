import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchBrowser } from './support/browser.mjs';

for (const folder of ['public', 'mew-html-reader-vscode']) {
  test(`${folder}: shared mappings feed source marks and selected replacements`, { timeout: 20000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('http://mapping.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') return route.fulfill({ contentType: 'text/html', body:
          '<script>window.PdfSelectionOptions={nativeEditor:true}</script><script type="module" src="/pdfdiff/pdf-review-provider.js"></script>' });
        if (!pathname.endsWith('.js')) return route.fulfill({ body: '' });
        // The popup is a web UI in both cases; native source access keeps its own adapter.
        const base = pathname.endsWith('replacement-review.js') ? 'public' : folder;
        const body = await readFile(new URL(`../${base}${pathname}`, import.meta.url), 'utf8');
        return route.fulfill({ contentType: 'text/javascript', body });
      });
      await page.goto('http://mapping.test/');
      await page.waitForFunction(() => window.PdfReviewProvider);
      const result = await page.evaluate(async () => {
        const api = await PdfReviewReady, pdf = {}, original = '<p>Lead &amp; <i>WRoot</i> and <i>WRoot</i> tail.</p>';
        const model = { getValue: () => original, getVersionId: () => 1,
          getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }), getOffsetAt: position => position.column - 1 };
        const documentModel = new MewEditorCore.DocumentModel({ model });
        let target;
        const locator = new api.PdfLocator({}, { document, getPdf: () => pdf, getTargets: () => [target],
          getVisiblePages: () => [{ number: 1, index: target }] });
        const index = locator.editorSourceIndex(documentModel), raw = index.raw.replaceAll('WRoot', 'VRoot');
        target = new PdfSelectionDiff.PdfConnections(locator, { raw,
          parts: [{ start: 0, end: raw.length, font: { italic: false, bold: false } }] });
        index.remember(0, index.raw.length, target, { start: 0, end: raw.length });
        const shared = index.getDifferences([target]);
        const data = locator.cacheReview({ index, shared, items: shared.items });
        const marks = api.sourceDecorations(index, data.items, true, true, undefined, documentModel);
        const editor = { document: documentModel, getModel: () => model };
        window.PdfSelection = { locator, editor, selectionEnabled: true };
        window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
        const start = index.raw.indexOf('WRoot'), notice = { html: 'WRoot', pdf: 'VRoot', source: { index, start, end: start + 5 } };
        const selected = locator.reviewItems({ request: { notice } }).selection;
        const group = locator.reviewLists.get(selected), location = locator.findLocations(pdf, [selected.pdfSource], true)[0];
        return { parsedIndex: documentModel.parse() === documentModel.parse(),
          rawHasOptions: shared.items.some(item => 'options' in item), count: group.items.length,
          marks: marks.length, mapped: location.targets.map(item => item.text).join(''),
          replaced: documentModel.applyEdits(group.edits).source };
      });
      assert.equal(result.parsedIndex, true);
      assert.equal(result.rawHasOptions, false);
      assert.equal(result.count, 2);
      assert.ok(result.marks >= 2);
      assert.equal(result.mapped, 'VRoot');
      assert.equal(result.replaced, '<p>Lead &amp; <i>VRoot</i> and <i>VRoot</i> tail.</p>');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
