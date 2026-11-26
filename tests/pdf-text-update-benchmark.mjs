import { reviewCandidates } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { launchBrowser } from './support/browser.mjs';
import { engineSource } from './support/pdf-harness.mjs';

// In-memory edits only. Compare identical prepared inputs with isolated engines.
const fixtures = await Promise.all(['me08-350', 'me32-323', 'me32-524'].map(async name => ({
  name, ...JSON.parse(await readFile(new URL(`./fixtures/pdf-selection-${name}.json`, import.meta.url), 'utf8'))
})));
const variants = {
  current: engineSource.replaceAll('\r\n', '\n'),
  'full-text': engineSource.replaceAll('\r\n', '\n').replace('    return index;\n  }\n  reviewAnchor',
    '    if (created && previous) for (const target of index.targets) for (const item of index.byTarget.get(target) || []) item.editorDiff = undefined;\n    return index;\n  }\n  reviewAnchor'),
  'full-mapping': engineSource.replace('if (created && previous) index.inherit(previous);', ''),
  monaco: engineSource.replace('const local = condense || !diffComputer || !details && Number.isFinite(limit);',
    'const local = !diffComputer || !details && Number.isFinite(limit);')
    .replace('else if ((fallback = details ? localTextDiff(left, right, true, 128) : null)?.distance <= 128) result = fallback;', '')
};
variants['full-monaco'] = variants.monaco.replace('if (created && previous) index.inherit(previous);', '');
for (const [name, script] of Object.entries(variants)) if (name !== 'current')
  assert.ok(script.replaceAll('\r\n', '\n') !== variants.current, `${name} must change the engine`);
const browser = await launchBrowser();
const results = [];
try {
  for (const [variant, script] of Object.entries(variants)) {
    const page = await browser.newPage();
    await page.route('http://diff-bench.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
      if (!pathname.startsWith('/monaco/') || pathname.includes('..')) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../node_modules/monaco-editor/' + pathname.slice(8), import.meta.url)) });
    });
    await page.goto('http://diff-bench.test/');
    await page.addScriptTag({ content: script });
    await page.evaluate(async () => {
      await PdfSelectionDiff.ready;
      if (!diffComputer) throw new Error('Real Monaco engine did not load');
    });
    for (const fixture of fixtures) for (const copies of [1, 8]) for (const edit of ['text', 'format']) {
      const result = await page.evaluate(({ fixture, copies, edit }) => {
        const samples = [], signatures = [];
        for (let round = 0; round < 9; round++) {
          const pdf = {}, locator = new PdfReviewProvider.PdfLocator({}, { document, getPdf: () => pdf });
          locator.getDocumentIndex = () => null;
          // Distinguish repeated fixtures so pages cannot all align to the first copy.
          const distinguish = (text, i) => copies === 1 ? text : text.replace(/[A-Za-z]{4,}/g, word => word + String.fromCharCode(97 + i).repeat(3));
          let source = Array.from({ length: copies }, (_, i) => fixture.source.split(/(<[^>]*>)/g)
            .map(part => part.startsWith('<') ? part : distinguish(part, i)).join('')).join('\n'), version = 1;
          const documentModel = new window.MewEditorCore.DocumentModel({ model: { getValue: () => source, getVersionId: () => version } }), model = documentModel.model;
          const targets = Array.from({ length: copies }, (_, i) => {
            const raw = distinguish(fixture.raw ?? fixture.pdf, i);
            return new PdfSelectionDiff.PdfConnections(locator, {
              raw, parts: [{ start: 0, end: raw.length, font: { italic: false, bold: false } }]
            });
          });
          // Distinct target objects model separately cached pages of a larger source.
          const initial = locator.editorSourceIndex(documentModel, targets);
          initial.connect(targets, pdf);
          reviewCandidates(initial, { fonts: true, edits: true, text: true, targets: [], connections: targets.filter(Boolean).flatMap(target => initial.connections.get(target)?.preparedRanges || initial.connections.get(target)?.ranges || []) });
          const word = /[A-Za-z]{5,}/g;
          word.lastIndex = Math.floor(initial.raw.length / 2);
          const match = word.exec(initial.raw), at = initial.starts[match.index];
          source = edit === 'text' ? source.slice(0, at) + 'X' + source.slice(at + 1)
            : source.slice(0, at) + '<b>' + source.slice(at, at + 1) + '</b>' + source.slice(at + 1);
          version++; documentModel.update(documentModel.content);
          const begin = performance.now();
          const current = locator.editorSourceIndex(documentModel, targets), indexed = performance.now();
          current.connect(targets, pdf);
          const prepared = performance.now();
          const items = reviewCandidates(current, { fonts: true, edits: true, text: true, targets: [], connections: targets.filter(Boolean).flatMap(target => current.connections.get(target)?.preparedRanges || current.connections.get(target)?.ranges || []) });
          const end = performance.now();
          if (round >= 2) samples.push({ index: indexed - begin, prepare: prepared - indexed, candidates: end - prepared, total: end - begin });
          if (round === 8) signatures.push(JSON.stringify(items.map(item => ({ start: item.sourceStart, end: item.sourceEnd,
            comparison: item.comparison, font: item.font && { italic: item.font.italic, bold: item.font.bold }, options: item.options }))));
        }
        const median = key => samples.map(value => value[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
        return { ms: Object.fromEntries(['index', 'prepare', 'candidates', 'total'].map(key => [key, +median(key).toFixed(2)])), signature: signatures[0] };
      }, { fixture, copies, edit });
      const baseline = results.find(row => row.variant === 'current' && row.fixture === fixture.name && row.copies === copies && row.edit === edit);
      const { signature, ...timing } = result;
      const items = JSON.parse(signature), before = baseline && JSON.parse(baseline.signature);
      const mismatch = before && before.findIndex((item, i) => JSON.stringify(item) !== JSON.stringify(items[i]));
      results.push({ variant, fixture: fixture.name, copies, edit, ...timing, items: items.length,
        matchesCurrent: !baseline || baseline.signature === signature,
        difference: baseline && baseline.signature !== signature ? { before: before[mismatch], after: items[mismatch] } : undefined, signature });
      console.log(JSON.stringify({ ...results.at(-1), signature: undefined }));
    }
    await page.close();
  }
} finally { await browser.close(); }
if (process.env.PDF_BENCH_OUTPUT) await writeFile(process.env.PDF_BENCH_OUTPUT,
  JSON.stringify(results.map(({ signature, ...row }) => row), null, 2) + '\n');
