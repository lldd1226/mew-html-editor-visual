import { reviewCandidates } from './support/pdf-harness.mjs';
import { DocumentModel as FixtureDocument } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { engine } from './support/pdf-harness.mjs';

const cases = [
  ['text before connection', source => source.replace('Lead.', 'A longer lead.'), true],
  ['format before connection', source => source.replace('Lead.', '<b>Lead.</b>'), true],
  ['inherited format', source => source.replace('<p><i>', '<p style="font-weight:bold"><i>'), false],
  ['local format', source => source.replace('<i>Alpha</i>', '<b>Alpha</b>'), false],
  ['format boundaries', source => source.replace('<i>Alpha</i>', '<i>Al</i><i>pha</i>'), false],
  ['footnote classification', source => source.replace('#F1', '#other'), false],
  ['text inside connection', source => source.replace('beta', 'better'), false],
  ['PDF font version', source => source.replace('Lead.', 'New lead.'), false, 'version'],
  ['PDF font parts', source => source.replace('Lead.', 'New lead.'), false, 'parts']
];

for (const scope of ['shared', 'copied']) for (const [name, edit, reuse, pdfUpdate] of cases) {
  test(`incremental fonts match fresh comparison: ${name}, ${scope} scope`, () => {
    const api = engine(), pdf = {};
    let source = '<p>Lead.</p><p><i>Alpha</i> beta <a href="#F1">1</a> gamma.</p><p>Tail.</p>', version = 1;
    const documentModel = new FixtureDocument({ model: { getValue: () => source, getVersionId: () => version } }), model = documentModel.model;
    const targets = [];
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf, getTargets: () => targets });
    locator.getDocumentIndex = () => null;
    const previous = locator.editorSourceIndex(documentModel), start = previous.raw.indexOf('Alpha'), end = previous.raw.indexOf('\n', start);
    const target = new api.PdfConnections(locator, { raw: previous.raw, fontVersion: 0, parts: [
      { start: 0, end: start + 5, font: { bold: true, italic: false } },
      { start: start + 5, end: previous.raw.length, font: { bold: false, italic: false } }
    ] });
    targets.push(target);
    const connection = previous.remember(start, end, target, { start, end });
    previous.compare(connection);
    const state = previous.connections.get(target), original = state.ranges, snapshot = JSON.stringify(connection.editorDiff);
    Object.assign(state, { prepared: true, scope: { start, end },
      preparedRanges: scope === 'shared' ? original : [connection.copy(previous, 0)] });
    let fontReads = 0;
    const fontRuns = target.fontRuns.bind(target);
    target.fontRuns = (...args) => { fontReads++; return fontRuns(...args); };
    if (pdfUpdate === 'version') { target.parts[0].font.italic = true; target.fontVersion++; }
    if (pdfUpdate === 'parts') target.parts = target.parts.map(part => ({ ...part, font: { bold: false, italic: true } }));
    source = edit(source); version++; documentModel.update(documentModel.content);
    const current = locator.editorSourceIndex(documentModel), pairs = [target].filter(Boolean).flatMap(target => current.connections.get(target)?.preparedRanges || current.connections.get(target)?.ranges || []);
    assert.ok(pairs.length, 'the confirmed connection survives the edit');
    const summarize = (index, pairs) => JSON.stringify(reviewCandidates(index, { fonts: true, edits: true, text: true, targets: [], connections: pairs }).map(item => ({
      start: item.sourceStart, end: item.sourceEnd, text: item.text, comparison: item.comparison,
      font: item.font && { bold: item.font.bold, italic: item.font.italic }, options: item.options
    })));
    const actual = summarize(current, pairs);
    assert.equal(fontReads === 0, reuse, 'only unchanged connections reuse font comparisons');
    if (reuse) {
      assert.equal(JSON.stringify(connection.editorDiff), snapshot, 'reuse does not mutate the old snapshot');
      for (const kept of pairs) assert.equal(kept.editorDiff.fontItems, connection.editorDiff.fontItems, 'relative font spans survive edits outside the connection');
      for (const item of reviewCandidates(current, { items: [], fonts: true, edits: false, connections: pairs }))
        assert.equal(item.htmlFont, current.formats[item.sourceStart], 'candidates reference the current HTML tags');
    }
    const fresh = new api.PdfConnections(locator, source);
    const freshPairs = pairs.map(kept => Object.defineProperty({ ...kept, editorDiff: undefined }, 'target', { value: target }));
    assert.equal(actual, summarize(fresh, freshPairs), 'candidates and applicable edits match a full recomputation');
  });
}
