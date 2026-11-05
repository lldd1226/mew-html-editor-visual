import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-page-labels-'));
let server, browser;
try {
  const labels = ['i', 'ii', 'iv', 'A', '17a', '1', '3'];
  for (const label of labels) await writeFile(path.join(fixture, `${label}.html`), `<html><body><p>Page ${label}</p></body></html>`);
  execFileSync('python', ['-c', 'import fitz,sys; d=fitz.open(); [d.new_page() for _ in range(7)]; d.set_page_labels([dict(startpage=i,prefix=x) for i,x in enumerate(["i","ii","iv","A","17a","1","3"])]); d.save(sys.argv[1])', path.join(fixture,'scan.pdf')]);
  const config = path.join(fixture, 'config.json');
  await writeFile(config, JSON.stringify({volumes:[{id:'uuid-volume',pdf:'scan.pdf', pages:{directory:'.',pattern:'^(?<page>i|ii|iv|A|17a|1|3)[.]html$',list:labels}}]}));
  server = await startServer('reader-server.js', 17059, ['-c', config]);
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:17059/?mode=source&page=iv');
  const waitPage = async label => {
    await page.waitForFunction(label => document.querySelector('#pageContext')?.textContent.includes(`第 ${label} 页`) && document.querySelector('#pageInput')?.value === label, label);
  };
  await waitPage('iv');
  await page.locator('#nextPageBtn').click();
  await waitPage('A');
  await page.locator('#pageInput').fill('17a');
  await page.locator('#pageInput').press('Enter');
  await waitPage('17a');
  await page.reload();
  await waitPage('17a');
  await page.locator('#pageInput').fill('001');
  await page.locator('#pageInput').press('Enter');
  await waitPage('1');
  await page.locator('#pageInput').fill('2');
  await page.locator('#pageInput').press('Enter');
  await page.waitForFunction(() => document.querySelector('#pageContext')?.textContent.includes('第 1 页') && document.querySelector('#pageInput')?.value === '2');
  console.log('String page labels: URL, input, next page, PDF labels, reload, numeric normalization and previous-page fallback passed.');
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive:true, force:true });
}
