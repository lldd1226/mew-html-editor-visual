import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

for (const root of ['public', 'mew-html-reader-vscode']) {
  const source = await readFile(new URL(`../${root}/pdfdiff/pdf-selection.js`, import.meta.url), 'utf8');
  const start = source.indexOf('      const x = page && (event.clientX - page.left) / page.width;');
  const end = source.indexOf('      if (notice)', start);
  assert.ok(start >= 0 && end > start);
  const hitTest = new vm.Script(`(() => { ${source.slice(start, end)} return notice?.id; })()`);
  test(`${root}: caret padding stays in screen pixels and resolves nearby markers`, () => {
    for (const width of [400, 800]) {
      const box = (x, y, w, h, caret = false) => ({ x: x / width, y: y / width, w: w / width, h: h / width, caret });
      const caret = { id: 'caret', box: box(100, 100, 4, 20, true) };
      const hit = (x, y, notices = [caret]) => hitTest.runInNewContext({
        page: { left: 0, top: 0, width, height: width }, event: { clientX: x, clientY: y }, painted: { notices }
      });
      for (const [x, y] of [[92, 110], [112, 110], [102, 97], [102, 123]])
        assert.equal(hit(x, y), 'caret');
      for (const [x, y] of [[91, 110], [113, 110], [102, 96], [102, 124]])
        assert.equal(hit(x, y), undefined);
      const text = { id: 'text', box: box(108, 100, 12, 20) };
      assert.equal(hit(110, 110, [caret, text]), 'text', 'click inside adjacent text beats expanded caret padding');
      assert.equal(hit(102, 110, [text, caret]), 'caret');
      const nextLine = { id: 'next-line', box: box(100, 122, 4, 20, true) };
      assert.equal(hit(102, 122, [caret, nextLine]), 'next-line', 'overlapping vertical padding prefers the actual line');
      assert.equal(hit(110, 98, [text]), undefined, 'ordinary text highlights retain their vertical bounds');
    }
  });
}
