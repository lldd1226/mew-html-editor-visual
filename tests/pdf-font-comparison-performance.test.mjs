import { DocumentModel as FixtureDocument } from './support/pdf-harness.mjs';
import { sourceDecorations } from './support/pdf-harness.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { engine } from './support/pdf-harness.mjs';

test('unknown PDF styles do not scan HTML formats while text differences remain visible', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = new api.PdfConnections(locator, '<p><b>Wrong word</b></p>');
  const target = new api.PdfConnections(locator, { raw: 'Right word', parts: [
    { start: 0, end: 10, font: { italic: null, bold: null } }
  ] });
  const connection = source.remember(0, source.raw.length, target, { start: 0, end: target.raw.length });
  let reads = 0;
  source.formats = new Proxy(source.formats, { get(values, key) {
    if (/^\d+$/.test(String(key))) reads++;
    return Reflect.get(values, key);
  } });
  const documentModel = new FixtureDocument({ model: { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) } }), model = documentModel.model;
  const marks = sourceDecorations(source, source.candidates(null, true, false, true, [], [[connection, target]]), true, true, undefined, documentModel);
  assert.ok(marks.some(mark => mark.options.description === 'PDF OCR text difference'));
  assert.equal(reads, 0, 'unknown PDF styles cannot establish a format mismatch');
  target.parts[0].font.bold = false;
  assert.ok(source.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]).length);
  assert.ok(reads > 0, 'known styles still compare against HTML formatting');
});
