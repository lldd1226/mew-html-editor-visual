import assert from 'node:assert/strict';
import { launchBrowser } from './support/browser.mjs';

// Uses the configured reader library; does not edit or save source documents.
const browser = await launchBrowser();
try {
  for (const splitView of [false, true]) {
    const checked = new Set();
    for (const number of [397, 400, 402]) for (const kind of ['text', 'font', 'missing']) {
      const context = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/api/reader/settings', route => route.fulfill({ json: {
        splitView, scale: '1.25', diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true,
        italicDetection: true, boldDetection: false
      } }));
      await page.goto(`${process.env.READER_URL || 'http://127.0.0.1:17000'}/?volume=6&page=${number}&mode=source`);
      await page.waitForFunction(() => window.PdfSelection?.locator.index?.prepared && document.querySelector('.mew-pdf-default-highlight > div'), null, { timeout: 60000 });
      await page.waitForFunction(() => PdfSelection.locator.environment.getVisiblePages().some(({index}) => {
        const div = index?.layer?.closest('.page');
        return div && PdfReviewProvider.highlights.getHighlight(div, true)?.notices?.length;
      }), null, { timeout: 10000 });
      await page.waitForTimeout(500);
      const target = await page.evaluate(kind => {
        window.receivedNotices = [];
        addEventListener('pdf-selection-difference', event => receivedNotices.push(event.detail));
        for (const { index } of PdfSelection.locator.environment.getVisiblePages()) {
          const div = index?.layer?.closest('.page'), painted = div && PdfReviewProvider.highlights.getHighlight(div, true);
          const notice = painted?.notices?.find(n => n.box && (kind === 'missing' ? n.missing : kind === 'font' ? !n.missing && n.html === undefined : !n.missing && n.html !== undefined));
          if (!notice) continue;
          const rect = div.getBoundingClientRect(), box = notice.box;
          const x = rect.left + (box.x + box.w / 2) * rect.width, y = rect.top + (box.y + box.h / 2) * rect.height;
          const container = PdfSelection.viewer.container, bounds = container.getBoundingClientRect();
          container.scrollTop += y - (bounds.top + bounds.height / 2);
          const moved = div.getBoundingClientRect();
          return { x, y: moved.top + (box.y + box.h / 2) * moved.height };
        }
      }, kind);
      if (!target) { console.log(`ME06 ${number}: no ${kind} marker`); await context.close(); continue; }
      await page.mouse.click(target.x, target.y);
      try { await page.locator('.replacement-review:visible').waitFor({ timeout: 5000 }); }
      catch (error) {
        console.error(number, kind, splitView, await page.evaluate(({x,y}) => ({
          focus: document.hasFocus(), selection: document.getSelection()?.toString(),
          hit: document.elementFromPoint(x,y)?.outerHTML.slice(0,200),
          events: receivedNotices.map(n => ({side:n.side, notices:n.notices.map(v=>({html:v.html,pdf:v.pdf,source:!!v.source}))}))
        }), target));
        throw error;
      }
      assert.equal(await page.evaluate(() => receivedNotices[0]?.side), 'pdf');
      assert.deepEqual(errors, []);
      checked.add(kind);
      console.log(`ME06 ${number} (${splitView ? 'split' : 'combined'}): default ${kind} marker opens review`);
      await context.close();
    }
    assert.deepEqual([...checked].sort(), ['font', 'missing', 'text']);
  }
} finally { await browser.close(); }
