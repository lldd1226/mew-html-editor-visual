import { reviewCandidates } from './support/pdf-harness.mjs';
import { DocumentModel as FixtureDocument } from './support/pdf-harness.mjs';
import { sourceDecorations } from './support/pdf-harness.mjs';
// Extracted from tmp/pdf-perf-benchmark.mjs and tmp/pdfdiff-comparison-cost.mjs.
// Synthetic scaling measurements; real OCR and browser rendering have separate benchmarks.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { engine, connectionParts } from './support/pdf-harness.mjs';

const iterations = Number(process.env.BENCH_ITERATIONS || 30);
const sizes = (process.env.BENCH_SIZES || '40,400,2000,3000').split(',').map(Number);
assert.ok(Number.isInteger(iterations) && iterations >= 5, 'BENCH_ITERATIONS must be an integer >= 5');
assert.ok(sizes.every(size => Number.isInteger(size) && size > 0), 'BENCH_SIZES must contain positive integers');
const api = engine(), rows = [];
const locator = () => new api.PdfLocator({}, { document: { createElement: () => ({}) } });
function measure(workload, size, run, check) {
  const samples = [];
  let result;
  for (let iteration = -3; iteration < iterations; iteration++) {
    const start = performance.now();
    result = run();
    const elapsed = performance.now() - start;
    check(result); // Correctness checks stay outside the timed region.
    if (iteration >= 0) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  rows.push({ workload, size, count: result.length,
    p50Ms: +samples[Math.floor(samples.length * 0.5)].toFixed(3),
    p95Ms: +samples[Math.ceil(samples.length * 0.95) - 1].toFixed(3),
    maxMs: +samples.at(-1).toFixed(3) });
}
for (const size of sizes) {
  const owner = locator(), source = new api.PdfConnections(owner, 'a\n'.repeat(size));
  const target = new api.PdfConnections(owner, { raw: 'b\n'.repeat(size) });
  const parts = connectionParts(api, Array.from({ length: size }, () => [['a', 'b'], ['\n', '\n']]).flat());
  source.byTarget.set(target, [{ start: 0, end: source.raw.length,
    targetStart: 0, targetEnd: target.raw.length, editorDiff: { parts } }]);
  measure('review candidates', size, () => reviewCandidates(source, { fonts: false, edits: true, text: true, targets: [target] }), items => {
    assert.equal(items.length, size);
    items.forEach((item, i) => {
      assert.equal(item.sourceStart, i * 2);
      assert.equal(item.sourceEnd, i * 2 + 1);
      assert.equal(item.comparison.html, 'a'); assert.equal(item.comparison.pdf, 'b');
    });
  });

  const fragmented = new api.PdfConnections(owner, '<span>a</span>'.repeat(size));
  const pdf = new api.PdfConnections(owner, { raw: 'c'.repeat(size),
    parts: [{ start: 0, end: size, font: { bold: false, italic: false } }] });
  const connection = { start: 0, end: size, targetStart: 0, targetEnd: size,
    editorDiff: { parts: [new api.diffIndex(fragmented.raw, pdf.raw)] } };
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  measure('fragmented decorations', size, () => sourceDecorations(fragmented, reviewCandidates(fragmented, { fonts: true, edits: false, text: true, targets: [], connections: [[connection, pdf]] }), true, true, undefined, documentModel), marks => {
    assert.equal(marks.length, size);
    marks.forEach((mark, i) => {
      assert.equal(mark.range.startColumn, fragmented.starts[i] + 1);
      assert.equal(mark.range.endColumn, fragmented.ends[i] + 1);
      assert.equal(mark.options.description, 'PDF OCR text difference');
    });
  });
}
for (const size of [1, 12, 48]) {
  const owner = locator(), raw = 'abcd efgh ijkl mnop qrst uvwx yz.\n'.repeat(200);
  const source = new api.PdfConnections(owner, raw), pdf = {};
  const pages = Array.from({ length: size }, () => new api.PdfConnections(owner, { raw }));
  for (const page of pages) source.remember(0, raw.length, page, { start: 0, end: raw.length });
  source?.connect(pages, pdf);
  const expected = source.livePairs;
  assert.ok(expected.length, 'cached preparation needs real retained connections');
  measure('cached preparation x100', size, () => {
    for (let i = 0; i < 100; i++) source?.connect(pages, pdf);
    return source.livePairs;
  }, pairs => assert.deepEqual(pairs, expected));
}
console.table(rows);
const report = { node: process.version, platform: process.platform, cpu: cpus()[0]?.model, iterations, warmup: 3, rows };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
