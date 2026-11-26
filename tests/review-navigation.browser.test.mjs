import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-review-navigation-'));
let server, browser;
try {
  await writeFile(path.join(fixture, 'a.html'), '<p>review navigation</p>');
  server = await startServer('server.js', 41891, ['-r', fixture]);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto('http://127.0.0.1:41891/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor && window.ReplacementReview);
  await page.evaluate(async () => {
    const keep = { id: 'keep', edits: [] };
    const items = ['text-a', 'font', 'text-b'].map((id, index) => ({ id, font: index === 1 ? { italic: true } : undefined,
      options: [keep], queueRange: index ? undefined : [0, 2] }));
    ReplacementReview.register({ id: 'mixed-navigation', label: 'Mixed navigation', provide: () => ({ items, selection: items[0] }),
      content: (_, item) => ({ message: item?.id || '', range: null, options: [], apply: false }) });
    await ReplacementReview.open('mixed-navigation', mewWorkbench.editor);
  });

  const popup = page.locator('.replacement-review');
  assert.equal(await popup.locator('[data-position]').textContent(), '1–3 / 3');
  await popup.locator('[data-next]').click();
  assert.equal(await popup.locator('[data-status]').textContent(), 'font', 'next stops at the font candidate inside the selected range');
  assert.equal(await popup.locator('[data-position]').textContent(), '2 / 3');
  await popup.locator('[data-prev]').click();
  assert.equal(await popup.locator('[data-status]').textContent(), 'text-a', 'previous returns to the selected batch');
} finally {
  await browser?.close();
  if (server) await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
