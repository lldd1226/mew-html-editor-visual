import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-selection-'));
await writeFile(path.join(fixture, 'a.html'), '<p>Alpha extraordinary selection follows the mouse immediately.</p>\n'.repeat(2000));
let server, browser;
try {
  server = await startServer('server.js', 41889, ['-r', fixture]);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:41889/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor.getModel());
  await page.waitForSelector('#tagBar [data-i="0"]');
  await page.evaluate(async () => {
    await document.fonts.ready;
    mewWorkbench.editor.setPosition({ lineNumber: 10, column: 4 });
    mewWorkbench.editor.focus();
    await new Promise(requestAnimationFrame);
  });
  const point = column => page.evaluate(column => {
    const editor = mewWorkbench.editor, box = editor.getDomNode().getBoundingClientRect();
    const position = editor.getScrolledVisiblePosition({ lineNumber: 10, column });
    return { x: box.left + position.left, y: box.top + position.top + position.height / 2 };
  }, column);
  const check = async (column, label) => {
    const state = await page.evaluate(async () => {
      // Observe the next rendered frame, without waiting for a caret transition to finish.
      await new Promise(requestAnimationFrame);
      const editor = mewWorkbench.editor, selection = editor.getSelection();
      const cursor = editor.getDomNode().querySelector('.cursors-layer .cursor');
      const box = editor.getDomNode().getBoundingClientRect(), caret = cursor.getBoundingClientRect();
      const expected = editor.getScrolledVisiblePosition(selection.getPosition());
      return { column: selection.positionColumn, error: Math.abs(caret.left - box.left - expected.left),
        text: editor.getModel().getValueInRange(selection), transition: getComputedStyle(cursor).transitionDuration };
    });
    assert.equal(state.column, column, `${label}: selection reaches the mouse`);
    assert.ok(state.error < 2, `${label}: visible caret trails by ${state.error.toFixed(1)}px (${state.transition})`);
    return state;
  };
  const start = await point(4);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const column of [9, 19, 31, 16, 5]) {
    const target = await point(column);
    await page.mouse.move(target.x, target.y);
    await check(column, `drag to column ${column}`);
  }
  await page.mouse.up();
  const word = await point(14);
  await page.mouse.dblclick(word.x, word.y);
  assert.equal((await check(23, 'double click')).text, 'extraordinary');
  assert.deepEqual(errors, []);
  console.log('Real Monaco: forward/backward dragging and double-click word selection reach the visible caret on the next frame (2,000 lines).');
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
