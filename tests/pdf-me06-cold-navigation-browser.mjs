import assert from 'node:assert/strict';
import { launchBrowser } from './support/browser.mjs';

const browser = await launchBrowser();
try {
  for (const scale of ['1.25', 'page-width']) for (const cold of [397, 400, 402]) {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    await page.route('**/api/reader/settings', route => route.fulfill({ json: {
      scale, diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true
    } }));
    await page.goto(`${process.env.READER_URL || 'http://127.0.0.1:17000'}/?volume=6&page=${cold}&mode=source`);
    for (const number of [cold, 400, 397, 402, 400, cold]) {
      if (new URL(page.url()).searchParams.get('page') !== String(number)) {
        await page.locator('#pageInput').fill(String(number));
        await page.locator('#pageInput').press('Enter');
      }
      await page.waitForFunction(number => {
        if (new URL(location.href).searchParams.get('page') !== String(number)) return false;
        const locator = window.PdfSelection?.locator, source = locator?.index;
        return source?.source === window.readerMonaco?.editor.getValue() && source?.prepared?.full
          && locator.environment.getVisiblePages().some(({ number, index }) => ReaderUI.getPdfSourcePages().includes(number)
            && index?.layer?.isConnected && PdfReviewProvider.highlights.getHighlight(index.layer.closest('.page'),true)?.notices?.some(notice=>notice.missing) && source.prepared.full.pages.some(page => page.number === number && source.prepared.full.raw.slice(page.start,page.end) === index.raw));
      }, number, { timeout: 60000 });
      const result = await page.evaluate(async () => {
        const locator = PdfSelection.locator, source = locator.index;
        const visible = locator.environment.getVisiblePages().find(({ number, index }) => ReaderUI.getPdfSourcePages().includes(number) && index?.layer);
        const view = PdfSelection.viewer.getPageView(visible.number - 1), content = await view.pdfPage.getTextContent();
        // PDF.js clears this attribute in setDocument(); the stable parent must keep geometry valid.
        PdfSelection.viewer.viewer.removeAttribute('lang');
        const spans = view._textHighlighter.textDivs;
        const items = content.items.filter(item => item.str?.length);
        const missing = source.getDifferences().items.find(item => item.missing && source.missingRange(visible.index,item.sourceStart,item.sourceEnd));
        const hit = missing && source.missingRange(visible.index,missing.sourceStart,missing.sourceEnd);
        const part = hit && visible.index.fontRuns(hit.start-1,hit.start-1,true)[0];
        const span = part ? part.node.parentElement.closest('span[role="presentation"]') : spans.findLast(span=>span.textContent.trim().length>15);
        const item = items.find(item=>item.str===span.textContent);
        if(missing) missing.pdfSource ||= source.entry(missing.sourceStart,missing.sourceEnd,true);
        const anchor = missing && locator.reviewAnchors([missing.pdfSource]).get(missing.pdfSource);
        const painted = PdfReviewProvider.highlights.getHighlight(view.div,true);
        const current = hit && PdfReviewProvider.highlights.measureHighlights(view.div,visible.index,[hit],hit);
        const overlays = painted?.notices?.filter(n=>n.missing).map(n=>n.box);
        return { lang: PdfSelection.viewer.container.lang, span: span.textContent,anchor,overlays,current:current?.boxes,
          width: span.getBoundingClientRect().width, expected: item.width * view.viewport.scale,
          scaleX: span.style.getPropertyValue('--scale-x'), font: getComputedStyle(span).font };

      });
      const label = `${scale}: cold ${cold} -> ${number}`;
      assert.equal(result.lang,'und',label);
      assert.ok(result.anchor,label);
      assert.ok(Math.abs(result.width-result.expected)<1,`${label}: PDF width ${result.expected}, DOM width ${result.width}`);
      assert.ok(result.current?.length && result.overlays?.some(box=>Math.abs(box.x-result.current[0].x)<.0001 && Math.abs(box.y-result.current[0].y)<.0001),`${label}: painted caret matches live geometry`);
    }
    console.log(`${scale}: cold ${cold}, navigation and viewer language reset passed.`);
    await page.close();
  }
} finally { await browser.close(); }
