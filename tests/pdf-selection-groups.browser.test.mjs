import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

test('Monaco popup groups selected word edges, keeps single characters within their word and visits every queue candidate', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'mew-selection-groups-'));
  let server, browser;
  try {
    await writeFile(path.join(fixture, 'a.html'), '<p>selection fixture</p>');
    server = await startServer('server.js', 41883, ['-r', fixture]);
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:41883/?file=a.html');
    await page.waitForFunction(() => window.mewWorkbench?.editor?.getValue().includes('selection fixture'));
    await page.evaluate(() => window.PdfReviewReady);
    for (const [query, replacement, words, selectedCount] of [
      ['WRoot', 'VRoot', ['WRooting', 'WRooter'], 2],
      ['RootW', 'RootV', ['aaRootW', 'bbRootW'], 2],
      ['W', 'V', ['aaW', 'Wbb'], 1],
      ['W xx Z', 'V xx Y', ['prefixW xx Z', 'W xx Zsuffix'], 2]
    ]) {
      const initial = await page.evaluate(({ query, replacement, words, selectedCount }) => {
        ReplacementReview.close(false, false);
        document.getElementById('fixture-scan')?.remove();
        const editor = mewWorkbench.editor;
        const cases = [{ text: 'lead Q', pdf: 'lead R' }, ...words.map(text => ({ text, pdf: text.replace(query, replacement) })),
          { text: `correct${query}`, pdf: `correct${query}` },
          { text: `different${query}`, pdf: `different${query.replace('W', 'Q')}` }, { text: 'tail S', pdf: 'tail T' }];
        const markup = text => text.replaceAll('W', '<i>W</i>');
        const original = cases.map(({ text }) => `<p>${markup(text)}</p>`).join('\n');
        const expected = cases.map(({ text }, at) => `<p>${at > 0 && at <= selectedCount
          ? markup(text).replace(markup(query), replacement.replaceAll('V', '<i>V</i>')) : markup(text)}</p>`).join('\n');
        editor.setValue(original);
        editor.document.update(editor.document.content);
        const pdf = {}, scan = document.createElement('div');
        scan.id = 'fixture-scan'; scan.className = 'page'; scan.dataset.pageNumber = '1';
        scan.style.cssText = 'position:fixed;right:10px;top:80px;width:420px;height:620px;background:white;border:1px solid black;z-index:1;';
        const layer = document.createElement('div');
        layer.style.cssText = 'position:relative;white-space:pre-wrap;font:18px/28px monospace;';
        layer.className = 'textLayer'; scan.append(layer); document.body.append(scan);
        let target;
        const locator = new PdfReviewProvider.PdfLocator({}, { document, getPdf: () => pdf, getTargets: () => [target],
          getVisiblePages: () => [{ number: 1, index: target }] });
        const index = locator.editorSourceIndex(editor.document), starts = [];
        let offset = 0, pdfText = index.raw;
        for (const { text } of cases) { const start = index.raw.indexOf(text, offset); starts.push(start); offset = start + text.length; }
        for (let at = cases.length - 1; at >= 0; at--)
          pdfText = pdfText.slice(0, starts[at]) + cases[at].pdf + pdfText.slice(starts[at] + cases[at].text.length);
        layer.textContent = pdfText;
        target = new PdfSelectionDiff.PdfConnections(locator, { raw: pdfText, layer,
          parts: [{ node: layer.firstChild, start: 0, end: pdfText.length }] });
        index.remember(0, index.raw.length, target, { start: 0, end: target.raw.length });
        locator.indexDocument = locator.indexFonts = async () => target;
        const viewer = { pdfDocument: pdf, container: scan, getPageView: () => ({ div: scan }) };
        const marks = ReviewHighlights.create({ document, classes: { pointer: 'fixture-selected-context' } });
        window.ReaderUI = { getPdfViewer: () => viewer };
        window.PdfSelection = { locator, editor, interactionId: 0, selectionEnabled: true, savePreference() {}, refresh() {},
          clearReviewPointer() { marks.clearHighlights(true); },
          showReviewPointer(owner, items) {
            const entries = locator.reviewLists.get(items)?.entries || items.map(item => item.pdfSource);
            const hits = entries.map(entry => entry.index.range(target, entry.start, entry.end)).filter(Boolean);
            const result = marks.measureHighlights(scan, target, hits, hits[0]);
            marks.paintHighlight(scan, result.boxes, 'rgba(255,196,0,.5)', true);
            window.fixtureHighlighted = items;
          } };
        const base = locator.reviewItems(), start = starts[1] + cases[1].text.indexOf(query);
        const notice = { html: query, pdf: replacement, source: { index, start, end: start + query.length } };
        const data = locator.reviewItems({ request: { notice } }), item = data.selection;
        const request = { notice, editor, model: editor.getModel(), pdf, side: 'pdf' };
        window.fixtureReview = { editor, locator, index, original, expected, data, item, request,
          open: () => { editor.setSelection(editor.document.rangeAt(start, start + query.length, true));
            return ReplacementReview.openForSelection('pdf-ocr', editor, item.id, request); } };
        const previous = { candidates: index.candidates };
        for (const method of Object.keys(previous)) index[method] = () => { throw new Error(`selection recomputed ${method}`); };
        fixtureReview.restore = () => Object.assign(index, previous);
        editor.setSelection(editor.document.rangeAt(start, start + query.length, true));
        return { count: base.items.length, range: Array.from(item.queueRange), expected, selectedCount };
      }, { query, replacement, words, selectedCount });
      // Let the provider's PDF/font identity poll observe this new fixture before opening review.
      await page.waitForTimeout(550);
      if (query === 'W') {
        await page.evaluate(() => ReplacementReview.open('pdf-ocr', fixtureReview.editor,
          fixtureReview.data.items[fixtureReview.item.queueRange[0]].id, 0, { ...fixtureReview.request,
            candidateId: fixtureReview.data.items[fixtureReview.item.queueRange[0]].id }));
        assert.equal(await page.evaluate(() => fixtureHighlighted.length), 1, 'an ordinary fault starts with the whole-word group');
      }
      await page.evaluate(() => fixtureReview.open());
      const popup = page.locator('.replacement-review'), [first, last] = initial.range;
      assert.equal(await popup.locator('[data-position]').textContent(), `${first === last ? first + 1 : `${first + 1}–${last + 1}`} / ${initial.count}`);
      assert.equal(await page.evaluate(() => fixtureHighlighted.length), initial.selectedCount, query);
      assert.ok(await page.locator('.fixture-selected-context > div').count() >= initial.selectedCount,
        'every selected PDF text range is painted');
      await popup.locator('[data-next]').click();
      const afterNext = first === last ? `${first + 2}` : `${first + 1}–${last + 1}`;
      assert.equal(await popup.locator('[data-position]').textContent(), `${afterNext} / ${initial.count}`,
        'next advances within the character batch');
      await page.evaluate(() => { ReplacementReview.close(false, false); return fixtureReview.open(); });
      await popup.locator('[data-prev]').click();
      assert.equal(await popup.locator('[data-position]').textContent(), `${first} / ${initial.count}`, 'previous starts before the first diff in the selection');
      await page.evaluate(() => { ReplacementReview.close(false, false); return fixtureReview.open(); });
      if (await popup.locator('[data-apply]').getAttribute('aria-pressed') !== 'true') await popup.locator('[data-apply]').click();
      await page.waitForFunction(count => document.querySelectorAll('.monaco-editor .mew-review-current').length >= count,
        initial.selectedCount, { timeout: 5000 }).catch(async error => {
        console.log(JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('[data-status]').textContent,
          preview: localStorage.getItem('mew-review-preview'), editor: fixtureReview.editor.getDomNode().getBoundingClientRect().toJSON(),
          marks: fixtureReview.editor.getModel().getAllDecorations().filter(mark => mark.options.inlineClassName?.includes('mew-review')).map(mark => ({ range: mark.range, name: mark.options.inlineClassName })),
          matchingNodes: [...document.querySelectorAll('[class*="mew-review-"]')].map(node => node.className) }))));
        throw error;
      });
      assert.equal(await page.evaluate(() => fixtureReview.editor.getValue()), await page.evaluate(() => fixtureReview.original), 'preview leaves source untouched');
      await page.evaluate(() => fixtureReview.restore());
      await popup.locator('[data-save]').click();
      await page.waitForFunction(() => fixtureReview.editor.getValue() === fixtureReview.expected, null, { timeout: 5000 }).catch(async error => {
        console.log(JSON.stringify(await page.evaluate(() => ({ actual: fixtureReview.editor.getValue(), expected: fixtureReview.expected,
          status: document.querySelector('[data-status]').textContent, selected: document.querySelector('[data-position]').textContent }))));
        throw error;
      });
      await page.waitForFunction(() => document.querySelector('[data-save]')?.disabled === false);
      assert.equal(await readFile(path.join(fixture, 'a.html'), 'utf8'), initial.expected, 'one click replaces and saves only the selected group');
      await page.evaluate(() => { ReplacementReview.close(); fixtureReview.editor.trigger('test', 'undo'); });
      await page.waitForFunction(() => fixtureReview.editor.getValue() === fixtureReview.original);
    }
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser?.close();
    if (server) await stopServer(server);
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()));
    await rm(fixture, { recursive: true, force: true });
  }
});
