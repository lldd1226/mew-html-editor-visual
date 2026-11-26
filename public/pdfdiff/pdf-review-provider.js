'use strict';
// Source/PDF mapping and candidate generation.
const nativeEditor = !!window.PdfSelectionOptions?.nativeEditor;
const pages = new WeakMap(), fontKeys = ['italic', 'bold'], reviewIds = ['pdf-ocr', 'pdf-font', 'pdf-bold'];
const wordBefore = /(?<=([\p{L}\p{M}\p{N}_'’-]+))/uy, wordAfter = /^[\p{L}\p{M}\p{N}_'’-]+/u;
function sourceDecorations(index, items = [], fonts = true, text = true, hover, documentModel, highlighted = true) {
  return items.flatMap(item => {
    if (!(item.font ? fonts : text)) return [];
    const font = !item.comparison, html = item.comparison?.html.trim();
    const start = !font && !html && /^\s/u.test(item.comparison.pdf) ? item.sourceEnd : item.sourceStart;
    const edits = !font && !item.selection && start === item.sourceStart && (html || item.comparison.pdf.trim()) && item.options?.[0]?.edits;
    const segments = edits?.length ? edits : index.sourceSegments(start, item.sourceEnd, font);
    const collapsed = !font && segments.every(segment => segment.start === segment.end);
    const options = { description: font ? 'PDF font difference' : 'PDF OCR text difference', stickiness: 1, hoverMessage: hover?.(item),
      inlineClassName: !highlighted ? '' : collapsed ? undefined : font ? 'mew-font-diff-text' : 'mew-ocr-diff-text' };
    if (collapsed) options.showIfCollapsed = true;
    if (!highlighted || collapsed) options.before = highlighted
      ? { content: '\u200b', inlineClassName: 'mew-ocr-diff-insert', inlineClassNameAffectsLetterSpacing: true } : undefined;
    return segments.map(({ start, end }) => ({ range: documentModel.rangeAt(start, end), options, reviewItem: item }));
  }).sort((a, b) => size(a.range) - size(b.range));
  function size({ startLineNumber, startColumn, endLineNumber, endColumn }) {
    return documentModel.model.getOffsetAt({ lineNumber: endLineNumber, column: endColumn })
      - documentModel.model.getOffsetAt({ lineNumber: startLineNumber, column: startColumn });
  }
}
function sourceHover(item, model, command) {
  const request = { model: model.uri?.toString(), version: model.getVersionId?.(), id: item.id };
  const link = (label, data) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify([data]))})`;
  const text = side => {
    if (item.font) return fontSummary(item.formats, side === 'html' ? 'htmlFont' : 'font');
    const value = item.comparison[side];
    return JSON.stringify(value.trim() ? value : '').replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
  };
  const pdf = command ? link('PDF:', request) : 'PDF:';
  const save = command && !item.missing ? `\n\n${link('替换&保存', { ...request, save: true })}` : '';
  return { value: (item.missing ? `${pdf} PDF OCR 缺少相关文字。` : `HTML: ${text('html')}\n\n${pdf} ${text('pdf')}`) + save,
    isTrusted: command ? { enabledCommands: [command] } : false };
}
function fontSummary(runs, field) {
  const states = [['italic', '斜体', new Set()], ['bold', '粗体', new Set()]], reasons = new Set();
  for (const value of runs) {
    const run = value[field || 'font'];
    if (field && run.reason) reasons.add(run.reason);
    for (const [key, label, values] of states) {
      if (field) values.add(run[key]);
      else if (typeof run[key] === 'boolean' && run[key] !== value.htmlFont[key])
        values.add(`${label}不一致（HTML ${value.htmlFont[key] ? '是' : '否'} / PDF ${run[key] ? '是' : '否'}${key === 'bold' && run.scanBoldRatio ? '，扫描估计' : ''}）`);
    }
  }
  return states.map(([, label, values]) => field ? `${label}：${!values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否'}` : [...values].join('；')).filter(Boolean).join('；')
    + (reasons.size ? `（${[...reasons].join('；')}）` : '');
}
function comparisonRows(value, compact = true, missing = value?.missing, full = value?.selection === true) {
  if (typeof value?.html !== 'string' || typeof value?.pdf !== 'string') return [];
  const change = full ? 'changed' : 'inconsistent', key = 1 + 2 * !!missing + 4 * !!full;
  const diff = window.PdfSelectionDiff.comparisonIndex(value);
  // Expanded rows carry live source indices and offsets; only compact rows are reusable.
  const rows = compact && (diff.rows ||= []);
  if (rows?.[key]) return rows[key];
  let parts = diff.parts;
  const first = compact ? parts.findIndex(part => part[change]) : -1;
  if (first >= 0) {
    const last = parts.findLastIndex(part => part[change]);
    const { start } = parts[first], { end } = parts[last];
    parts = parts.slice(first, last + 1);
    const context = text => ({ html: text, pdf: text, changed: false });
    if (start) parts.unshift(context((start > 45 ? '…' : '') + value.html.slice(Math.max(0, start - 45), start)));
    if (end < value.html.length) parts.push(context(value.html.slice(end, end + 45) + (value.html.length - end > 45 ? '…' : '')));
  }
  const sides = missing && !value.pdf.trim() ? ['html'] : ['html', 'pdf'], source = !compact && value.source;
  const result = sides.map(side => {
    const other = side === 'html' ? 'pdf' : 'html';
    return { label: side.toUpperCase(), parts: parts.map(part => ({
      ...part, changed: !!part[change] && !missing,
      text: part[change] && !part[side].trim() && part[other].trim() ? '' : part[side],
      source: source ? { index: source.index, start: source.start + part.start, end: source.start + part.end } : undefined
    })) };
  });
  return rows ? rows[key] = result : result;
}
function pdfFontStyle(font, fallback = '', css = {}) {
  const name = font?.name || fallback;
  // Tesseract placeholder flags do not describe the recognized text.
  if (/glyphlessfont/i.test(name)) return { name, italic: null, bold: null,
    reason: 'GlyphLessFont 占位字体未保留 OCR 粗斜体信息' };
  const italic = /italic|oblique/i.test(css.fontStyle || '')
    || (typeof font?.italic === 'boolean' ? font.italic : /italic|oblique|kursiv/i.test(name) ? true : null);
  const bold = /bold/i.test(css.fontWeight || '') || Number(css.fontWeight) >= 600 || font?.black === true
    || (typeof font?.bold === 'boolean' ? font.bold : /bold|black|heavy|demi|semibold|fett/i.test(name) ? true : null);
  return { name, italic, bold };
}
function pdfTextBaseline(item) {
  const [a, b, , , x, y] = item.transform; // Compare baselines at the same horizontal origin on tilted scans.
  return y - (a ? x * b / a : 0);
}
function pageData(page) { return pages.get(page) || pages.set(page, {}).get(page); }
// A passage ends where text crosses its gutter. A wider gap can also separate short passages.
function columnPassages(items) {
  const rows = items.filter(row => row.text && row.height).sort((a, b) => b.y - a.y);
  const gutters = new Set(rows.map(({ x, height }) => Math.floor(x - height * .5)));
  rows.push({ x: NaN, y: -Infinity, end: NaN, height: 1 });
  let gutter, score = 0;
  const countLines = values => new Set(values.map(({ y }) => Math.round(y / 3))).size;
  const beside = (side, other) => countLines(side.filter(({ y, height }) =>
    y <= other[0].y + height * 2 && y >= other.at(-1).y - height * 2));
  for (const x of gutters) {
    let left = [], right = [], top = Infinity;
    for (const row of rows) {
      const margin = row.height * .35;
      const side = row.end <= x + margin && row.x < x ? left : row.x >= x - margin && row.end > x ? right : null;
      if (side) { side.push(row); continue; }
      const count = left.length > score && right.length > score && left.some(line => line.wide) && right.some(line => line.wide)
        ? Math.min(beside(left, right), beside(right, left)) : 0;
      if (count > score) {
        const height = Math.max(left[0].height, right[0].height);
        const starts = countLines(right.filter(line => line.x < x + height * 1.25));
        const tall = count >= 6 && starts >= 3;
        const gap = tall ? 0 : right.reduce((edge, line) => Math.min(edge, line.x), Infinity)
          - left.reduce((edge, line) => Math.max(edge, line.end), -Infinity);
        const aligned = gap < height * 2.5 ? 0 : countLines(left.filter(a => a.word
          && right.some(b => b.word && Math.abs(a.y - b.y) <= height * .5)));
        if (tall || aligned >= 2 && starts >= 2 || aligned === 1 && gap >= height * 4
          && Math.max(left[0].y, right[0].y) - Math.min(left.at(-1).y, right.at(-1).y) <= height * .5) {
          gutter = { x, top, bottom: row.y };
          score = count;
        }
      }
      left = []; right = []; top = row.y;
    }
  }
  if (!gutter) return [items];
  const passages = [[], [], [], []];
  for (const row of items)
    passages[row.y >= gutter.top ? 0 : row.y <= gutter.bottom ? 3 : row.x < gutter.x ? 1 : 2].push(row);
  return passages[1].length && passages[2].length ? passages.flatMap(part => part.length ? columnPassages(part) : []) : [items];
}
function readPageText(page) {
  const data = pageData(page);
  return data.text ||= Promise.resolve().then(() => page.getTextContent()).then(content => {
    data.items = content.items.filter(item => item.str?.length);
    const items = data.items.map(item => {
      const { height, width, str, transform: [, , , , x] } = item;
      return { item, height, x, end: x + width, y: pdfTextBaseline(item),
        text: str.trim(), wide: width >= height * 4, word: /\p{L}{2}/u.test(str) };
    });
    const sorted = [...items].sort((a, b) => Math.round((b.y - a.y) / Math.max(a.height, b.height)) || a.x - b.x);
    const misaligned = sorted.some((row, i) => i && row.x < sorted[i - 1].x
      && Math.abs(row.y - sorted[i - 1].y) <= Math.max(row.height, sorted[i - 1].height) * .75);
    const rows = misaligned ? items : sorted;
    data.columnText = () => {
      const passages = columnPassages(rows);
      return passages.length > 1 ? assemble(passages) : null;
    };
    return assemble([rows]);

    function assemble(passages) {
      let raw = '', previous, line;
      const parts = [], breaks = [];
      for (const passage of passages) for (const [i, row] of passage.entries()) {
        if (!i && parts.length) {
          if (!raw.endsWith('\n')) raw += '\n';
          breaks.push(raw.length);
          previous = line = undefined;
        }
        const { item, y, height: size } = row;
        if (previous && !raw.endsWith('\n')) {
          const height = Math.max(size, previous.height);
          if (Math.abs(y - previous.y) > height * (misaligned ? .75 : .5)) raw += '\n';
          else if (row.x - previous.x - previous.item.width > height * .08) raw += ' ';
        }
        if (size && row.word) {
          const gap = line && y - line.y, height = Math.max(line?.height ?? 0, size);
          const start = gap < -height * 1.8 ? raw.lastIndexOf('\n') + 1 : 0;
          if (start > (breaks.at(-1) ?? 0)) breaks.push(start);
          if (!line || Math.abs(gap) > height * .6 || size > line.height) line = row;
        }
        parts.push({ start: raw.length, end: raw.length + item.str.length, item });
        raw += item.str + (item.hasEOL ? '\n' : '');
        previous = row;
      }
      return { ...content, raw, parts, breaks, horizontal: passages.length > 1 };
    }
  }).catch(error => { delete data.text; throw error; });
}
function readPageFonts(page) {
  const data = pageData(page);
  return data.fonts ||= readPageText(page).then(async ({ parts }) => {
    const ops = window.pdfjsLib?.OPS || { save: 10, restore: 11, setFont: 37, setTextRenderingMode: 38,
      showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47 };
    const textOps = new Set([ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText]);
    const invisibleFonts = new Set(), stack = [];
    let fontId = null, mode = 0, failed = false;
    try {
      const list = await page.getOperatorList?.();
      for (const [i, fn] of (list?.fnArray || []).entries()) {
        if (fn === ops.save) stack.push([fontId, mode]);
        else if (fn === ops.restore && stack.length) [fontId, mode] = stack.pop();
        else if (fn === ops.setFont) fontId = list.argsArray[i][0];
        else if (fn === ops.setTextRenderingMode) mode = list.argsArray[i][0];
        else if ((mode & 3) === 3 && textOps.has(fn)) invisibleFonts.add(fontId);
      }
    } catch { failed = true; }
    const fonts = new Map(), textFonts = [];
    let letters = 0, boldLetters = 0, italic = true;
    for (const [id, runs] of Map.groupBy(parts, part => part.item.fontName)) {
      const style = pdfFontStyle(id && page.commonObjs?.has(id) ? page.commonObjs.get(id) : null, id || '');
      if (failed) Object.assign(style, { bold: null, italic: null, reason: '字体读取失败' });
      // Invisible OCR retains declarations, not scan-derived style evidence.
      else if (invisibleFonts.has(id)) Object.assign(style,
        { declaredBold: style.bold, declaredItalic: style.italic, reason: style.reason || 'OCR 字体' });
      fonts.set(id, style);
      const count = runs.reduce((sum, { item }) => sum + item.str.replace(/\s/g, '').length, 0);
      if (!count) continue;
      letters += count;
      if (style.bold === true) boldLetters += count;
      italic &&= style.italic === true;
      textFonts.push(style);
    }
    const reasons = { bold: boldLetters / letters >= .8 && (boldLetters < letters ? '大部分文字声明为粗体' : '均为粗体'),
      italic: italic && '均为斜体' };
    for (const font of textFonts) for (const key of ['bold', 'italic']) {
      if (!reasons[key] || font[key] !== true) continue;
      if (key === 'bold') font.declaredBold = true;
      font[key] = null;
      font.reason = font.reason ? `${font.reason}：${reasons[key]}` : reasons[key];
    }
    return fonts;
  }).catch(error => { delete data.fonts; throw error; });
}
function layerFonts(view, layer, refresh) {
  const page = view?.pdfPage, cached = page && pageData(page);
  if (page?.getTextContent && !cached.layer) {
    cached.layer = {};
    readPageText(page).then(async text => {
      Object.assign(cached.layer, { fonts: await readPageFonts(page), text });
      refresh();
    }).catch(() => { delete cached.layer; });
  }
  const data = cached?.layer, items = data?.text ? cached.items : [];
  const spans = Array.from(view?._textHighlighter?.textDivs || layer.querySelectorAll('span[role="presentation"]'))
    .filter(span => span.textContent);
  const names = spans.length === items.length && spans.every((span, i) => span.textContent === items[i].str)
    ? new Map(spans.map((span, i) => [span, items[i]])) : new Map();
  return Object.assign(element => data?.fonts?.get(names.get(element)?.fontName), { items: names, text: data?.text });
}

class PdfLocator {
  documents = new WeakMap();
  comparisons = new WeakMap();
  reviewLists = new WeakMap();
  textEnabled = true;
  fontStyles = [...fontKeys];
  constructor(options = {}, environment = {}) {
    Object.assign(this, { environment, options, pdf: environment.getPdf?.() || {}, document: environment.document || window.document });
  }
  get model() { return this.editorDocument?.model; }
  overlapsDifference({ sourceStart, sourceEnd }, start, end) {
    return sourceStart === sourceEnd ? sourceStart >= start && sourceStart <= end : sourceStart < end && sourceEnd > start;
  }
  prepareReview(context = {}) {
    if (selection()?.selectionEnabled === false) return null;
    const pdf = viewer()?.pdfDocument, editor = selection()?.editor, model = editor?.getModel();
    if (!pdf || !model || context.signal?.aborted || context.pdf && context.pdf !== pdf
      || context.editor && context.editor !== editor || context.model && context.model !== model) return null;
    if (context.version !== undefined ? context.version !== model.getVersionId()
      : context.source !== undefined && context.source !== model.getValue()) return null;
    Object.assign(context, { pdf, editor, model, documentModel: editor.document, snapshot: editor.document.snapshot });
    return this.editorSourceIndex(context.documentModel);
  }
  reviewItems(context = {}) {
    const { source, priority } = context;
    if (source === undefined ? selection()?.selectionEnabled === false : !this.prepareReview(context)) return { items: [] };
    if (source === undefined) this.editorSourceIndex(context.editor?.document);
    const { index, pdf, currentReview: review } = this, previous = review?.index;
    if (!context.onProgress || !priority || previous === index || previous?.prepared?.pdf !== pdf || !previous?.fontsCurrent)
      return this.completeReview(context);
    const { changedRange, lowerBound } = window.PdfSelectionDiff, items = [];
    const raw = index.change?.before === previous.raw ? index.change : changedRange(previous.raw, index.raw);
    const { oldEnd, newEnd } = changedRange(previous.source, index.source);
    const delta = raw.newEnd - raw.oldEnd, sourceDelta = newEnd - oldEnd, suffix = previous.raw !== index.raw ? raw.oldEnd : 0;
    const from = Math.max(suffix, lowerBound(previous.ends, priority.offset - sourceDelta + 1));
    for (let at = lowerBound(review.items, from, item => item.reviewStart ?? item.sourceStart);
      at < review.items.length && items.length < 5; at++) {
      const item = review.items[at], { sourceStart: start, sourceEnd: end, reviewStart } = item;
      // Ordinary text edits are in source order, and a font option has at most one edit.
      const { range, edits, ...option } = item.options[0];
      if (start < suffix || previous.starts[start] < oldEnd || edits[0]?.start < oldEnd
        || start === end && start === raw.oldEnd && delta > 0) continue;
      items.push({ ...item, id: undefined, sourceStart: start + delta, sourceEnd: end + delta,
        reviewStart: reviewStart === undefined ? undefined : reviewStart + delta,
        pdfSource: undefined, range: undefined, previewDecorations: undefined,
        options: [{ ...option, edits: edits.map(edit => ({ ...edit, start: edit.start + sourceDelta, end: edit.end + sourceDelta })) }] });
    }
    if (!items.length) return this.completeReview(context);
    const partial = this.cacheReview({ index, items, partial: true });
    return Promise.resolve(context.onProgress(partial)).then(accepted => accepted !== false && this.prepareReview(context)
      ? this.completeReview(context) : { items: [] });
  }
  get currentReview() {
    const { review } = this;
    if (review && review.model === this.model && review.enabled === this.textEnabled
      && review.fontKey === this.fontStyles.join(',')) return review;
  }
  completeReview(context = {}, notice = context.request?.candidateId ? null : context.request?.notice) {
    const { index, model } = this, { source } = context, span = notice?.source;
    if (source !== undefined && span?.index !== index) {
      const version = context.version ?? model.getVersionId?.(), pages = this.environment.getSourcePages?.();
      const prepared = this.fontStyles.length ? this.indexFonts(this.pdf, index, context.signal, pages) : this.indexDocument(this.pdf, pages);
      return prepared.then(full => full && source === model.getValue() && this.prepareReview({ ...context, source: undefined, version }) && this.index === index
        ? this.completeReview({}, notice) : { items: [] });
    }
    const shared = index.getDifferences(), review = this.currentReview;
    const data = this.review = review?.shared === shared ? review : this.cacheReview(
      { model, enabled: this.textEnabled, fontKey: this.fontStyles.join(','), shared, partial: false }, { text: this.textEnabled });
    const selected = this.reviewLists.get(notice);
    if (selected?.items === data.items && selected.index === index) return selected;
    if (!this.textEnabled || span?.index !== index || index.raw.slice(span.start, span.end) !== notice.html) return data;
    const { html, missing } = notice, { lowerBound, comparisonIndex } = window.PdfSelectionDiff;
    const changes = missing ? [] : comparisonIndex(notice).parts.filter(part => part.changed);
    if (!missing && !changes.length) return data;
    let first, last;
    for (const [at, item] of data.items.entries()) {
      if ((item.reviewStart ?? item.sourceStart) > span.end) break;
      if (item.font || !this.overlapsDifference(item, span.start, span.end)) continue;
      if (item.missing && !missing) return data;
      first ??= at;
      last = at;
    }
    const position = first ?? lowerBound(data.items, span.start, item => item.sourceStart);
    const selectedItem = { sourceStart: span.start, sourceEnd: span.start + html.length, selection: true,
      queueRange: [position, last ?? position], comparison: notice, missing };
    const selectedItems = [selectedItem], { items } = shared, firstChange = changes[0];
    const group = first === last && [...html].length === 1 && this.reviewLists.get(data.items[first]);
    if (firstChange && last !== undefined) for (const anchor of group?.items ?? items) {
      if (anchor.missing) continue;
      const text = anchor.comparison.html, needle = firstChange.html;
      for (let offset = text.indexOf(needle); offset >= 0; offset = needle ? text.indexOf(needle, offset + 1) : -1) {
        const start = anchor.sourceStart + offset - firstChange.start, end = start + html.length;
        if (start < 0 || start === span.start || !index.raw.startsWith(html, start)) continue;
        let matched = 0;
        for (let at = lowerBound(items, start, item => item.sourceEnd); matched >= 0 && items[at]?.sourceStart <= end; at++) {
          const item = items[at];
          if (!this.overlapsDifference(item, start, end)) continue;
          if (item.missing) {
            matched = -1;
            break;
          }
          const key = item.comparison.selection === true ? 'changed' : 'inconsistent';
          for (const part of comparisonIndex(item.comparison).parts) {
            if (!part[key]) continue;
            const from = item.sourceStart + part.start - start, width = part.html.length;
            const left = Math.max(0, -from), right = Math.min(html.length - from, width);
            if (left > right) continue;
            let pdf = part.pdf;
            if (left || right < width) pdf = width === pdf.length ? pdf.slice(left, right) : null;
            const expected = changes[matched++];
            if (expected?.start !== from + left || expected.end !== from + right
              || expected.pdf !== pdf || expected.html !== part.html.slice(left, right)) {
              matched = -1;
              break;
            }
          }
        }
        if (matched === changes.length) selectedItems.push({ ...selectedItem, queueRange: undefined, sourceStart: start, sourceEnd: end,
          comparison: { ...notice, source: { index, start, end } } });
      }
    }
    this.cacheReview({ items: selectedItems.sort((a, b) => a.sourceStart - b.sourceStart) }, { selected: true });
    return this.reviewLists.set(notice, { ...data, selection: selectedItem }).get(notice);
  }
  pattern(value, index = this.index) {
    // Unknown or foreign source context may only match the candidate itself.
    if (value.missing || !index || !Number.isInteger(value.sourceStart) || !Number.isInteger(value.sourceEnd)
      || value.sourceStart < 0 || value.sourceEnd < value.sourceStart || value.sourceEnd > index.raw.length
      || value.pdfSource && value.pdfSource.index !== index) return value;
    wordBefore.lastIndex = value.sourceStart;
    const prefix = wordBefore.exec(index.raw.slice(0, value.sourceStart))?.[1] || '';
    const suffix = wordAfter.exec(index.raw.slice(value.sourceEnd))?.[0] || '';
    const before = value.sourceStart - prefix.length, after = value.sourceEnd + suffix.length;
    if (!value.font && value.options?.[0]) {
      const start = index.starts[before] ?? index.source.length;
      value.options[0].range = { start, end: after > before ? index.ends[after - 1] : start };
    }
    if ([...index.raw.slice(before, after)].length < 2 && [...(prefix + (value.comparison?.pdf ?? value.text ?? '') + suffix)].length < 2) return value;
    const change = value.font ? [value.text, ...fontKeys.flatMap(key => [value.htmlFont[key], value.font[key]])]
      : [value.comparison?.html, value.comparison?.pdf];
    const contextual = value.selection && window.PdfSelectionDiff.comparisonIndex(value.comparison).parts.some(part => !part.changed && part.html.length);
    return JSON.stringify([!!value.font, !!value.selection, change, ...(contextual ? [] : [prefix, suffix])]);
  }
  cacheReview(data, { fonts = data.shared ? this.fontStyles : false, edits: makeEdits = true, text = true,
    targets, connections, selected = false } = {}) {
    const index = data.index ??= data.shared?.index ?? this.index;
    const { lowerBound, comparisonIndex } = window.PdfSelectionDiff;
    const items = data.items || (!targets && !connections && data.shared?.items);
    connections ??= targets ? index.targetConnections(targets) : data.shared?.connections ?? index.pairs;
    const keys = fonts === true ? fontKeys : fonts || [], disabled = fontKeys.filter(key => !keys.includes(key));
    const fontConnections = index.formats && keys.length && !data.partial && !selected ? connections : [];
    const candidates = text ? items || index.candidates(targets, connections) : [];
    const absent = fontConnections.length ? candidates.filter(item => item.missing).sort((a, b) => a.sourceStart - b.sourceStart) : [];
    const byRange = new Map();
    for (const connection of fontConnections) if (index.compare(connection))
      for (const item of connection.fontItems) {
        const sourceStart = connection.start + item.start, sourceEnd = connection.start + item.end;
        const id = `font:${sourceStart}:${sourceEnd}`;
        if (byRange.has(id)) continue;
        const htmlFont = index.formats[sourceStart];
        if (disabled.length && !keys.some(key => typeof item.font[key] === 'boolean' && item.font[key] !== htmlFont[key])) continue;
        const font = { ...item.font };
        for (const key of disabled) font[key] = null;
        byRange.set(id, { sourceStart, sourceEnd, font, htmlFont });
      }
    // Merge adjacent format changes, or bridge punctuation with the same mismatch.
    const formats = [];
    let missingAt = 0, missingEnd = -Infinity, previous, nearby;
    for (const item of [...byRange.values()].sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      while (absent[missingAt]?.sourceStart <= item.sourceStart) missingEnd = Math.max(missingEnd, absent[missingAt++].sourceEnd);
      if (missingEnd > item.sourceStart || absent[missingAt]?.sourceStart < item.sourceEnd) continue;
      const gap = previous && index.raw.slice(previous.sourceEnd, item.sourceStart);
      const joins = previous && item.sourceStart >= previous.sourceEnd && !/[\r\n]/.test(gap)
        && previous.htmlFont.tags === item.htmlFont.tags
        && fontKeys.every(key => previous.font[key] === item.font[key] && previous.htmlFont[key] === item.htmlFont[key])
        && (!gap.trim() || !(/\s/u.test(gap) && /[\p{L}\p{N}]/u.test(gap)) && fontKeys.some(key =>
          typeof previous.font[key] === 'boolean'
          && index.formats.slice(previous.sourceEnd, item.sourceStart).every((style, i) =>
            /\s/u.test(gap[i]) || (style && style[key] !== previous.font[key]))));
      if (joins) previous.sourceEnd = item.sourceEnd;
      else {
        formats.push(previous = item);
        nearby = candidates[lowerBound(candidates, item.sourceStart, range => range.sourceEnd)];
      }
      (previous.formats ||= []).push({ font: item.font, htmlFont: item.htmlFont });
      previous.reviewStart = nearby?.sourceStart <= previous.sourceEnd ? nearby.sourceStart : previous.sourceStart;
    }
    const groups = new Map(), copy = data.shared && !data.partial;
    data.items = candidates.concat(formats);
    if (formats.length) data.items.sort((a, b) =>
      (a.reviewStart ?? a.sourceStart) - (b.reviewStart ?? b.sourceStart) || Number(!!a.font) - Number(!!b.font));
    data.entries = []; data.edits = []; data.plans = [];
    for (const [at, item] of data.items.entries()) {
      const value = copy ? data.items[at] = { ...item } : item;
      value.id ||= `${value.font ? 'font:' : ''}${value.sourceStart}:${value.sourceEnd}`;
      if (value.font) value.text = index.raw.slice(value.sourceStart, value.sourceEnd);
      value.pdfSource ||= index.candidateEntry(value);
      const splitGlyph = index.starts?.[value.sourceStart] < index.ends?.[value.sourceStart - 1]
        || index.starts?.[value.sourceEnd] < index.ends?.[value.sourceEnd - 1];
      const [option] = value.options ||= value.font
        ? [{ id: 'format', edits: makeEdits ? index.fontEdits(value.sourceStart, value.sourceEnd, value.font) : [] }]
        : [{ id: 'pdf', label: '替换', edits: !makeEdits || value.missing || !value.selection && splitGlyph ? []
          : !value.selection ? index.textEdits(value.sourceStart, value.sourceEnd, value.comparison?.pdf)
            : comparisonIndex(value.comparison).parts.flatMap(part => part.changed
              ? index.textEdits(value.sourceStart + part.start, value.sourceStart + part.end, part.pdf) : []) }];
      if (value.font && option) Object.assign(option, { title: `替换格式：${value.text}（${fontSummary(value.formats)}）`,
        range: { start: index.starts[value.sourceStart], end: index.ends[value.sourceEnd - 1] } });
      if (this.editorDocument && (value.font || value.missing || value.selection && value.comparison.html.trim()))
        value.range ||= this.editorDocument.rangeAt(value.sourceStart, value.sourceEnd, true);
      data.entries.push(value.pdfSource);
      data.edits.push(...option.edits);
      if (!value.missing) data.plans.push(option);
      let group = data;
      if (!selected) {
        const key = data.partial ? value : this.pattern(value, index);
        group = groups.get(key);
        if (!group) {
          groups.set(key, group = { index, items: [], entries: [], edits: [] });
          this.reviewLists.set(group.items, group);
        }
        group.items.push(value); group.entries.push(value.pdfSource); group.edits.push(...option.edits);
      }
      this.reviewLists.set(value, group);
    }
    this.reviewLists.set(data.items, data);
    return data;
  }
  editorSourceIndex(documentModel = this.editorDocument) {
    const pdf = this.environment.getPdf?.() || this.pdf;
    const numbers = this.environment.getSourcePages?.(), sourcePageKey = numbers ? `pages:${numbers.join(',')}` : '';
    Object.assign(this, { editorDocument: documentModel, pdf });
    const pairs = this.comparisons.get(this.model) || this.comparisons.set(this.model, new WeakMap()).get(this.model);
    let previous = pairs.get(pdf);
    const snapshot = documentModel.snapshot;
    if (previous?.sourcePageKey !== sourcePageKey) { previous = undefined; this.review = null; }
    if (previous?.source === snapshot.source && previous.version === snapshot.version) return this.index = previous;
    const index = this.index = new window.PdfSelectionDiff.PdfConnections(this, documentModel);
    index.sourcePageKey = sourcePageKey;
    pairs.set(pdf, index);
    if (previous) index.inherit(previous);
    return index;
  }
  findLocations(pdf, entries, visibleOnly = false, visible) {
    const scope = this.environment.getSourcePages?.(), full = this.getDocumentIndex(pdf, scope);
    visible ??= this.environment.getVisiblePages?.() || [];
    const pageIndexes = visible.map(page => page.index);
    const hasLayoutBreaks = full?.pages?.some(page => page.breaks?.length), prepared = new Map(), locations = [];
    for (const originalEntry of entries) {
      const { index: source, start, end, marked } = originalEntry, fragments = [];
      let absentRanges;
      if (source) {
        if (!prepared.has(source)) prepared.set(source, {
          missing: source.getDifferences(pageIndexes).items.filter(item => item.missing),
          document: hasLayoutBreaks ? source.targetConnections(full).toSorted((a, b) => a.start - b.start) : []
        });
        const data = prepared.get(source);
        absentRanges = data.missing;
        const documentRanges = data.document.filter(range => range.start < end && range.end > start);
        const split = visibleOnly || marked || documentRanges.some(({ targetStart, targetEnd }, i) => {
          const next = documentRanges[i + 1];
          return next && (targetStart > next.targetStart || /\S/u.test(full.raw.slice(targetEnd, next.targetStart)));
        });
        if (split) {
          const connections = documentRanges.length ? documentRanges
            : data.visible ??= source.pairs.filter(({ target }) => target === full || pageIndexes.includes(target));
          if (connections.length && !connections.some(range => range.start <= start && range.end >= end)) {
            for (const ranges of [connections, absentRanges]) for (const range of ranges) {
              const from = Math.max(start, range.sourceStart ?? range.start), to = Math.min(end, range.sourceEnd ?? range.end);
              if (from < to) fragments.push({ ...source.entry(from, to, marked), originalEntry });
            }
          }
        }
      }
      for (const entry of fragments.length ? fragments.sort((a, b) => a.start - b.start) : [originalEntry]) {
        const absent = this.textEnabled && absentRanges?.find(({ sourceStart, sourceEnd }) =>
          entry.start === entry.end ? entry.marked && entry.start >= sourceStart && entry.start <= sourceEnd
            : entry.start < sourceEnd && entry.end > sourceStart);
        if (absent) {
          const { sourceStart: start, sourceEnd: end, comparison } = absent;
          const span = { index: source, start, end }, difference = { ...comparison, missing: true };
          const mapped = full && source.missingRange(full, start, end, comparison);
          const targets = (mapped ? full.pages : visible).flatMap(page => {
            if (mapped && (mapped.start < page.start || mapped.end > page.end || mapped.endBias && mapped.start === page.start)) return [];
            const range = mapped ? { ...mapped, start: mapped.start - page.start, end: mapped.end - page.start }
              : page.index?.raw.trim() && source.missingRange(page.index, start, end, comparison);
            return range ? [{ pageNumber: page.number, range, start, end, marked: true, source: span, difference,
              text: mapped ? full.raw.slice(mapped.start, mapped.end) : '',
              ...(mapped && { item: page.parts.find(part => part.end >= mapped.start)?.item }) }] : [];
          });
          locations.push({ entry, targets, queries: [], notice: { ...difference, source: span } });
          continue;
        }
        let hit = source || visibleOnly ? null : full?.search(entry), index = full, number;
        // An exact hit ends the search. Keep the first approximate hit while trying later pages.
        for (let at = 0; source && at <= visible.length; at++) {
          const page = visible[at], target = page ? page.index : full;
          if (!target) continue;
          const found = !page && (hit || visibleOnly) ? source.range(target, entry.start, entry.end, false, undefined, true)
            : source.locate(target, entry, false, target.connections.get(source)?.scope, true, { visiblePage: !!page });
          if (!found || hit && found.approximate) continue;
          hit = found; index = target;
          if (page) number = page.number;
          if (!hit.approximate) break;
        }
        if (!hit) {
          locations.push({ entry, targets: [], queries: source ? [] : [entry.text] });
          continue;
        }
        const caret = hit.start === hit.end, counterpart = index.raw.slice(hit.start, hit.end);
        const difference = entry.difference || (hit.approximate || entry.text !== counterpart ? { html: entry.text, pdf: counterpart } : null);
        const span = source && { index: source, start: entry.start, end: entry.end };
        const targets = (index.pages || [{ number, start: 0, end: index.raw.length, parts: index.parts }]).flatMap(page => {
          if (!(caret ? hit.start >= page.start && hit.start <= page.end : hit.start < page.end && hit.end > page.start)) return [];
          const fragment = index.entry(Math.max(hit.start, page.start), Math.min(hit.end, page.end), entry.marked, undefined, page);
          const sourceRange = entry.marked || entry.start === entry.end ? entry
            : source?.range(index, fragment.start, fragment.end, true, hit.connection);
          return [{ pageNumber: page.number, item: page.parts.find(part => part.end > fragment.start)?.item,
            difference, layer: index.layer, range: index.layer && { start: fragment.start, end: fragment.end },
            marked: entry.marked, text: fragment.text, before: fragment.before, after: fragment.after,
            ...(difference && span && { source: span }),
            ...((sourceRange || caret) && { index: source, start: sourceRange?.start ?? entry.start, end: sourceRange?.end ?? entry.end }) }];
        });
        locations.push({ entry, targets, approximate: hit.approximate, notice: entry.marked && difference && { ...difference, source: span } });
      }
    }
    if (visibleOnly || full || locations.every(hit => hit.targets.length && !hit.approximate)) return locations;
    return this.indexDocument(pdf, scope).then(index => index ? this.findLocations(pdf, entries) : locations);
  }
  reviewAnchor(item) {
    return item?.pdfSource && this.reviewAnchors([item.pdfSource]).get(item.pdfSource) || null;
  }
  reviewAnchors(entries, pdf = this.environment.getPdf?.() || this.pdf) {
    const anchors = new Map(), visible = entries.length && this.environment.getVisiblePages?.();
    if (!visible?.length) return anchors;
    const layers = new Map(visible.map(({ number, index }) => [number, index]));
    for (const { entry, targets } of this.findLocations(pdf, entries, true, visible)) {
      const original = entry.originalEntry || entry;
      if (anchors.has(original)) continue;
      for (const target of targets) {
        const index = layers.get(target.pageNumber);
        if (!index?.layer?.isConnected) continue;
        const { hits, focusHit } = index.locateLayer([], [target]);
        const div = index.layer.closest('.page') || index.layer;
        const box = highlights.measureHighlights(div, index, hits, focusHit).notices[0]?.box;
        if (!box) continue;
        const page = div.getBoundingClientRect(), sx = page.width / div.offsetWidth, sy = page.height / div.offsetHeight;
        const top = page.top + div.clientTop * sy;
        anchors.set(original, { top: top + box.y * div.clientHeight * sy, bottom: top + (box.y + box.h) * div.clientHeight * sy,
          left: page.left + div.clientLeft * sx + box.x * div.clientWidth * sx + (box.caret ? 2 : 0) });
        break;
      }
    }
    return anchors;
  }
  async indexDocument(pdf, numbers, source) {
    numbers = numbers ? [...numbers] : undefined;
    const documents = this.documents.get(pdf) || this.documents.set(pdf, new Map()).get(pdf);
    const key = numbers ? `pages:${numbers.join(',')}` : '', task = documents.get(key)?.task;
    if (task) return task;
    const { PdfConnections, normalized, significantText } = window.PdfSelectionDiff;
    if (numbers) source ??= this.environment.getSourceIndex?.();
    const index = new PdfConnections(this, { pdf, sourcePages: numbers, raw: '', pages: [], normalized: null });
    documents.set(key, index);
    return index.task = Promise.resolve().then(async () => {
      let mappedStart = 0, mapped;
      for (const number of index.sourcePages || Array.from({ length: index.pdf.numPages }, (_, i) => i + 1)) {
        if (!this.environment.isCurrent(index.pdf)) return null;
        await this.environment.waitForIdle(index.pdf);
        if (!this.environment.isCurrent(index.pdf)) return null;
        const page = await index.pdf.getPage(number), ordinary = await readPageText(page);
        if (!this.environment.isCurrent(index.pdf)) return null;
        const columns = source && pageData(page).columnText();
        let content = ordinary;
        if (columns) {
          const limit = Math.min(significantText(source.raw).length, significantText(ordinary.raw).length);
          let best = 0;
          for (const layout of [ordinary, columns]) {
            if (best >= limit) break;
            const target = new PdfConnections(source, { ...layout, sourcePages: [number] });
            source.connect(target);
            const matched = source.targetConnections(target).flatMap(connection =>
              (source.compare(connection, true)?.parts || []).flatMap(part =>
                part.changed ? [] : [[connection.start + part.start, connection.start + part.end]]));
            let score = 0, edge = 0;
            for (const [start, end] of matched.sort((a, b) => a[0] - b[0])) {
              if (end <= edge) continue;
              score += source.raw.slice(Math.max(edge, start), end).replace(/[\s\-\u00ad\u2010\u2011]/gu, '').length;
              edge = end;
            }
            if (score > best) { best = score; content = layout; }
          }
        }
        const start = index.raw.length;
        index.pages.push({ number, start, end: start + content.raw.length, horizontal: content.horizontal,
          columnText: content.horizontal ? content : undefined,
          parts: content.parts.map(part => ({ ...part, start: start + part.start, end: start + part.end })),
          breaks: content.breaks.map(at => start + at) });
        index.raw += content.raw + '\n';
        const segment = index.raw.slice(mappedStart);
        if (/[-\u2010\u2011]\s*$/.test(segment)) continue;
        mapped = normalized(segment, mapped, mappedStart);
        mappedStart = index.raw.length;
      }
      index.normalized = normalized(index.raw.slice(mappedStart), mapped, mappedStart);
      if (this.environment.isCurrent(index.pdf)) this.environment.onIndexed?.();
      return index;
    }).then(result => result || discard(), error => { discard(); throw error; });
    function discard() {
      if (documents.get(key) === index) documents.delete(key);
      return null;
    }
  }
  getDocumentIndex(pdf, numbers) { return window.PdfSelectionDiff.documentIndex(this.documents, pdf, numbers); }
  columnText(pdf, number) {
    return this.getDocumentIndex(pdf, this.environment.getSourcePages?.())?.pages.find(page => page.number === number)?.columnText;
  }
  async indexFonts(pdf, source, signal, numbers) {
    const index = await this.indexDocument(pdf, numbers, numbers && source);
    if (!index || signal?.aborted) return null;
    const prepared = source?.connect();
    const ranges = prepared?.pages.includes(index) ? source.targetConnections(index) : [];
    for (const entry of index.pages) {
      if (entry.parts.every(part => part.font)
        || source && !ranges.some(hit => hit.targetStart < entry.end && hit.targetEnd > entry.start)) continue;
      if (signal?.aborted || !this.environment.isCurrent(pdf)) return null;
      // Share in-flight work too; separate reviews can request the same page.
      await (entry.fontTask ||= (async () => {
        await this.environment.waitForIdle(pdf);
        if (!this.environment.isCurrent(pdf)) return;
        const page = await pdf.getPage(entry.number);
        if (!this.environment.isCurrent(pdf)) return;
        const fonts = await readPageFonts(page);
        if (!this.environment.isCurrent(pdf)) return;
        for (const part of entry.parts) part.font = fonts.get(part.item.fontName);
        index.fontVersion = (index.fontVersion || 0) + 1;
      })().finally(() => { entry.fontTask = null; }));
    }
    return !signal?.aborted && this.environment.isCurrent(pdf) ? index : null;
  }
}
// Shared popup and session initialization.
// PDF comparison is one review provider. Selection synchronization remains independent.
let host, locator, highlights, dismissed = null, listeningWindow = null;
function readerWindow() {
  if (window.ReaderUI?.getPdfViewer) return window;
  try { if (window.opener && !window.opener.closed && window.opener.ReaderUI?.getPdfViewer) return window.opener; } catch { }
  return null;
}
function viewer() { return readerWindow()?.ReaderUI.getPdfViewer() || window.PdfSelection?.viewer; }
function selection() { return readerWindow()?.PdfSelection || window.PdfSelection; }
// The reader and its paired editor share mappings, document caches and candidates.
function bind(target = readerWindow() || window) {
  locator = selection()?.locator || (target && target !== window ? target.PdfReviewProvider?.locator : null) || locator;
  if (!locator) {
    locator = new PdfLocator({}, {
      document, getPdf: () => viewer()?.pdfDocument,
      isCurrent: pdf => selection()?.selectionEnabled !== false && viewer()?.pdfDocument === pdf,
      waitForIdle: () => new Promise(resolve => setTimeout(resolve, 0))
    });
    try { locator.textEnabled = localStorage.getItem('mew.pdf-review.enabled') !== 'false'; } catch { }
  }
  if (target === listeningWindow) return;
  listeningWindow?.removeEventListener('pdf-selection-difference', onDifference);
  const wasLocal = listeningWindow === window, isLocal = target === window;
  if (wasLocal || isLocal) {
    const bindEvent = isLocal ? 'addEventListener' : 'removeEventListener';
    window[bindEvent]('pdf-selection-sources', onSources);
    window[bindEvent]('pdf-selection-reset', highlights.clearMarks);
    if (wasLocal) highlights.clearMarks();
  }
  listeningWindow = target;
  target?.addEventListener('pdf-selection-difference', onDifference);
}
function onReviewClosed(event) {
  const api = selection(), { id, editor, model } = event.detail;
  if (api?.selectionEnabled !== false && reviewIds.includes(id)) dismissed = {
    editor, model, version: model.getVersionId?.(), range: editor.getSelection()?.toString(), interaction: api?.interactionId };
}
async function onDifference(event) {
  bind();
  if (selection()?.selectionEnabled === false) return;
  const data = event.detail, { editor, notices, candidateId, kind, pdf, side, interactionId } = data;
  const model = editor?.getModel(), readerHost = listeningWindow?.ReplacementReview, fontStyles = locator.fontStyles;
  const destination = side === 'pdf' || reviewIds.some(id => readerHost?.isOpenFor(id, editor)) ? readerHost
    : editor?.getDomNode()?.ownerDocument.defaultView.ReplacementReview || readerHost;
  if (destination !== host || dismissed?.editor === editor && dismissed.model === model && dismissed.version === model?.getVersionId?.()
    && dismissed.range === editor?.getSelection()?.toString() && dismissed.interaction === interactionId) return;
  if (pdf !== viewer()?.pdfDocument || data.model && data.model !== model || !locator.textEnabled && !fontStyles.length) return;
  const changed = candidateId && kind !== 'font' ? notices[0] : notices.find(value => {
    if (typeof value.html !== 'string' || typeof value.pdf !== 'string'
      || value.source && value.source.index.raw.slice(value.source.start, value.source.end) !== value.html) return false;
    return window.PdfSelectionDiff.comparisonIndex(value).parts.some(part => value.selection === true ? part.changed : part.inconsistent);
  });
  const notice = changed || notices.find(value => value.source), source = notice?.source, hasSource = source && model;
  if (changed ? !locator.textEnabled : !hasSource) return;
  const request = { ...data, notice, kind: changed ? kind : 'font' }, selectedRange = editor?.getSelection?.()?.toString();
  const { items, selection: selected } = hasSource ? await locator.reviewItems({ ...data, request,
    source: source.index.source, version: source.index.version }) : { items: [] };
  if (editor?.getModel() !== model || editor?.getSelection?.()?.toString() !== selectedRange) return;
  const item = candidateId ? items.find(item => item.id === candidateId) : request.kind !== 'font' ? selected
    : items.find(item => item.font && item.sourceStart < source.end && item.sourceEnd > source.start);
  if (hasSource && !item) return;
  if (item) request.focusId = item.id;
  dismissed = null;
  if (nativeEditor && side === 'html') {
    if (item) host.showHover(review,
      { editor, model, documentModel: editor.document, snapshot: editor.document.snapshot }, item, items, source);
    if (!data.userSelection) return;
    request.side = 'pdf';
  }
  if (!hasSource) return host.showNotice({ title: 'PDF 文字差异', message: '文字不一致',
    comparison: comparisonRows(notice, false, notice.missing, true), anchor: data.anchor, layout: presentation({ editor, request }) });
  return host.openForSelection(locator.textEnabled ? 'pdf-ocr' : fontStyles.includes('italic') ? 'pdf-font' : 'pdf-bold', editor, request.focusId, request);
}
function presentation(context, item) {
  const reader = readerWindow() || window, source = context.editor?.getDomNode()?.ownerDocument.defaultView || window;
  const split = source !== reader, side = split ? context.request?.side || 'html' : 'pdf';
  const { anchor: fallback, anchorElement: element, anchorBox: box, notice } = context.request || {};
  // Prefer the measured click range when opening at an inline-tag boundary.
  const pdf = side === 'pdf', destination = pdf ? reader : source, { container, eventBus, pdfDocument } = viewer() || {};
  const rect = pdf && box && element?.isConnected && element.getBoundingClientRect();
  const requested = (!item || item.sourceStart === notice?.source?.start) && (rect
    ? { left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height, bottom: rect.top + (box.y + box.h) * rect.height }
    : fallback);
  const entry = item?.pdfSource, related = pdf && context.snapshot === context.documentModel?.snapshot
    ? locator.reviewLists.get(item)?.entries.filter(value => value !== entry) || [] : [];
  const anchors = locator.reviewAnchors(pdf && !requested && entry ? [entry, ...related] : related, pdfDocument);
  const anchor = pdf ? requested || anchors.get(entry) || null : null;
  return { side, switchable: split, switchLabel: pdf ? '查看HTML' : '查看PDF', host: destination.ReplacementReview, window: destination,
    container, eventBus, anchor, highlights: [anchor, ...related.map(value => anchors.get(value))].filter(Boolean) };
}
function content(state, item) {
  const edits = item?.options[0].edits || [], data = locator.reviewLists.get(state.items);
  const message = item?.missing ? 'OCR 层缺少相关文字。' : item?.font ? fontSummary(item.formats || [item])
    : item ? '文字不一致' : state.items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。';
  return { message, edits: locator.reviewLists.get(item)?.edits, allEdits: data?.edits, all: data?.partial ? false : undefined,
    comparison: item?.font ? ['htmlFont', 'font'].map((field, i) => ({ label: i ? 'PDF' : 'HTML', parts: [{ text: fontSummary(item.formats, field) }] }))
      : comparisonRows(item?.comparison, !item?.selection, item?.missing, item?.selection),
    previewDecorations: item?.font || item?.missing ? item.previewDecorations ||= (data?.index || item.pdfSource?.index || locator.index).sourceSegments(item.sourceStart, item.sourceEnd, true).map(segment => ({
      range: state.context.documentModel.rangeAt(segment.start, segment.end),
      options: { inlineClassName: item.missing ? 'mew-review-proposed' : 'mew-review-format', stickiness: 1 }
    })) : [],
    apply: !!edits.length,
    range: item?.range || (edits.length ? state.context.documentModel.rangeAt(
      Math.min(...edits.map(edit => edit.start)), Math.max(...edits.map(edit => edit.end))) : null),
    options: [], applyLabel: item?.font ? '替换格式' : '替换', advance: false, expanded: false };
}
function apply({ item, items, position, context }, all) {
  const { editor, documentModel } = context;
  const data = locator.reviewLists.get(items), index = data?.index || locator.index;
  const offset = index.starts[item.sourceStart] ?? context.source.length;
  if (index !== locator.editorSourceIndex(documentModel)) return { offset };
  if (all && data?.partial) throw new Error('完整差异队列仍在准备，请稍后替换全部');
  const group = all ? data : locator.reviewLists.get(item), selected = all ? items : group?.items || [];
  const candidates = new Set(selected);
  let next, first, last;
  for (const [at, candidate] of items.entries()) {
    if (!all && item.font && candidate.font && !candidates.has(candidate)
      && selected.some(value => value.font && candidate.sourceStart < value.sourceEnd && candidate.sourceEnd > value.sourceStart))
      candidates.add(candidate);
    if (candidates.has(candidate)) { first ??= at; last = at; }
    else if (at > position) next ??= at;
  }
  const edits = documentModel.validateEdits((candidates.size === selected.length && group?.edits)
    || [...candidates].flatMap(value => value.options[0].edits));
  return { position: next ?? items.length, priority: (last ?? -1) - (first ?? -1) + 1 === candidates.size,
    apply: () => documentModel.applyEdits(edits, { editor }),
    offset: offset + edits.reduce((delta, edit) => delta + (edit.end <= offset
      ? edit.text.length - (edit.end - edit.start) : 0), 0) };
}
const review = {
  compact: true, content, apply, presentation,
  isCurrent: ({ source, ...context }) => (source === undefined || source === context.model.getValue()) && !!locator.prepareReview(context),
  available: editor => !editor || !!locator.prepareReview({ editor }),
  containsSelection(item, request) {
    const source = request?.notice?.source;
    return source && item && (this.id === 'pdf-ocr'
      ? item.sourceStart === source.start && item.sourceEnd === source.end : item.sourceStart < source.end && item.sourceEnd > source.start);
  },
  selectComparison(context, part) {
    const owner = part.source.index.document.defaultView;
    context.editor.setSelection(context.documentModel.rangeAt(part.source.start, part.source.end, true));
    owner.dispatchEvent(new owner.CustomEvent('pdf-selection-difference', { detail: { ...context, ...context.request, interactionId: undefined, snapshot: null, notices: [part] } }));
  },
  onSelect(item, context, items, previewEnabled = false) {
    context.editor.getDomNode()?.classList.toggle('mew-review-preview', previewEnabled);
    selection()?.showReviewPointer(context.editor, locator.reviewLists.get(item)?.items || []);
  },
  onClose(context) {
    context.editor.getDomNode()?.classList.remove('mew-review-preview');
    selection()?.clearReviewPointer(context.editor);
  }
};
function onSources(event) {
  bind();
  const { editor, pdf, enabled: highlighted, diffEnabled } = event.detail, context = { editor, pdf };
  const index = editor?.createDecorationsCollection && locator.prepareReview(context);
  if (!index) return;
  const data = locator.completeReview(), owner = editor.getDomNode()?.ownerDocument.defaultView;
  const controller = nativeEditor ? editor : owner.mewWorkbench || owner.readerMonaco;
  host.bindSuggestions(editor, model => locator.prepareReview({ editor, model }) ? locator.completeReview().plans : []);
  const id = 'mew.pdf-difference';
  if (editor.addAction && !editor.getAction(id)) {
    const action = editor.addAction({
      id, label: '查看 PDF 差异',
      async run(_, request) {
        const context = { editor, version: request.version }, index = locator.prepareReview(context);
        if (!index || context.model.uri.toString() !== request.model) return;
        const span = request.selection;
        const { items, selection: selected } = locator.completeReview({}, span && { ...span,
          source: { index, start: span.start, end: span.end } });
        const item = selected || items.find(item => item.id === request.id);
        if (!item) return;
        if (request.save) {
          const position = selected?.queueRange[0] ?? items.indexOf(item);
          await apply({ item, items, position, context: { ...context, source: context.model.getValue() } }, false).apply?.();
          return controller.save({ followPdf: false, model: context.model });
        }
        const reader = readerWindow() || window, notice = { ...item.comparison, missing: item.missing, source: item.pdfSource };
        reader.dispatchEvent(new reader.CustomEvent('pdf-selection-difference', { detail: {
          editor, model: context.model, pdf: context.pdf, notices: [notice],
          candidateId: item.font ? item.id : undefined, kind: item.font ? 'font' : 'text', side: 'pdf'
        } }));
        if (owner && owner !== reader) {
          reader.name ||= `mew-review-${crypto.randomUUID()}`;
          owner.open('', reader.name)?.focus();
        }
      }
    });
    editor.onDidDispose(() => action.dispose());
  }
  const editorId = !nativeEditor && editor.getId?.();
  const hover = nativeEditor ? item => host.hoverContent(review, context, item, data.items)
    : item => sourceHover(item, context.model, editorId && `${editorId}:${id}`);
  highlights.updateSource(editor, [index, highlighted, data, context.model],
    () => highlighted || nativeEditor
      ? sourceDecorations(index, data.items, locator.fontStyles, locator.textEnabled, hover, context.documentModel, !!highlighted) : []);
  if (diffEnabled) selection()?.showReviewPointer(editor, data.items, data);
}
window.PdfReviewReady = (async () => {
  if (!window.MewEditorCore?.DocumentModel) await import('../editor-core.js');
  if (!window.PdfSelectionDiff?.PdfConnections) await import('./pdf-connection.js');
  await window.PdfSelectionDiff.ready;
  if (!window.ReplacementReview || !window.ReviewHighlights) await import('./replacement-review.js');
  host = window.ReplacementReview;
  highlights = window.ReviewHighlights.create({ document, classes: {
    selection: 'mew-pdf-selection-highlight', pointer: 'mew-pdf-review-pointer', caret: 'mew-pdf-selection-caret'
  } });
  bind();
  window.addEventListener('replacement-review-closed', onReviewClosed);
  window.PdfReviewProvider = {
    PdfLocator, get locator() { bind(); return locator; }, highlights,
    textItemBaseline: pdfTextBaseline, fontStyle: pdfFontStyle, sourceDecorations, fontSummary, comparisonRows, readPageText, readPageFonts, layerFonts,
    ...(!nativeEditor && { sourceHover }),
    setFontEnabled(value, key, persist = true) {
      locator.fontStyles = fontKeys.filter(name => !key || name === key ? value : locator.fontStyles.includes(name));
      if (persist) for (const style of key ? [key] : fontKeys)
        selection()?.savePreference(`${style}Detection`, !!value, '无法保存字体探测设置');
      for (const id of reviewIds) host.invalidate(id);
      selection()?.clearReviewPointer();
      selection()?.refresh();
    }
  };
  const unregister = reviewIds.map((id, i) => host.register({
    ...review, get locator() { bind(); return locator; }, id,
    label: ['PDF 文字差异审阅', 'PDF 斜体探测', 'PDF 粗体探测'][i],
    isEnabled: () => i === 0 ? locator.textEnabled : locator.fontStyles.includes(fontKeys[i - 1]),
    setEnabled(value) {
      if (i) return (readerWindow()?.PdfReviewProvider || window.PdfReviewProvider).setFontEnabled(value, fontKeys[i - 1]);
      locator.textEnabled = value;
      selection()?.savePreference('textDetection', value, '无法保存文字差异设置');
      try { localStorage.setItem('mew.pdf-review.enabled', String(value)); } catch { }
      for (const id of reviewIds.slice(1)) host.invalidate(id);
      selection()?.refresh();
    }
  }));
  for (const [id, label, setting, setEnabled, toggleOnly] of [
    ['pdf-selection', 'PDF 差异高亮', 'enabled', value => selection()?.setDiffHighlight(value), true],
    ['source-diff', '源码差异高亮', 'sourceEnabled', value => selection()?.setDiffHighlight(value, 'source'), true],
    ['pdf-selection-sync', 'PDF 与源码选区联动', 'selectionEnabled', value => selection()?.setSelectionHighlight(value)]
  ]) unregister.push(host.register({
    id, label, toggleOnly, setEnabled, isEnabled: () => selection()?.[setting] === true,
    available: () => { const api = selection(); return !!api && (setting === 'selectionEnabled' || api.selectionEnabled); }
  }));
  let previousPdf = viewer()?.pdfDocument, previousEnabled, previousFonts = locator.fontStyles;
  const poll = nativeEditor ? null : setInterval(() => {
    bind();
    const pdf = viewer()?.pdfDocument, api = selection(), fonts = locator.fontStyles, state = `${!!api}:${api?.enabled}:${api?.sourceEnabled}:${api?.selectionEnabled}:${fonts}`;
    if (previousPdf !== pdf || previousFonts !== fonts) {
      const fontsChanged = previousFonts !== fonts;
      previousPdf = pdf; previousFonts = fonts;
      for (const id of reviewIds) host.invalidate(id, context => fontsChanged || context.pdf !== pdf);
    }
    if (previousEnabled !== state) { previousEnabled = state; host.refreshMenu(); }
  }, 500);
  window.addEventListener('pagehide', () => { clearInterval(poll); bind(null); highlights.dispose(); window.removeEventListener('replacement-review-closed', onReviewClosed); unregister.forEach(dispose => dispose()); });
  return window.PdfReviewProvider;
})();
