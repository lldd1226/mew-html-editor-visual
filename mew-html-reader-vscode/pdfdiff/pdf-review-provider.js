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
    parts = parts.slice(first, parts.findLastIndex(part => part[change]) + 1);
    const { start } = parts[0], { end } = parts.at(-1);
    const context = text => ({ html: text, pdf: text, changed: false });
    if (start) parts.unshift(context((start > 45 ? '…' : '') + value.html.slice(Math.max(0, start - 45), start)));
    if (end < value.html.length) parts.push(context(value.html.slice(end, end + 45) + (value.html.length - end > 45 ? '…' : '')));
  }
  const sides = missing && !value.pdf.trim() ? ['html'] : ['html', 'pdf'], source = !compact && value.source;
  const result = sides.map(side => ({ label: side.toUpperCase(), parts: parts.map(part => ({
    ...part, changed: !!part[change] && !missing,
    text: part[change] && !part[side].trim() && part[side === 'html' ? 'pdf' : 'html'].trim() ? '' : part[side],
    source: source ? { index: source.index, start: source.start + part.start, end: source.start + part.end } : undefined
  })) }));
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
// Start with continuous gutters, then look for short columns between vertical gaps.
function columnPassages(items) {
  const rows = items.filter(row => row.text && row.height).sort((a, b) => b.y - a.y);
  if (rows.length < 2) return [items];
  const gutters = new Set(rows.map(({ x, height }) => Math.floor(x - height * .5)));
  rows.push({ x: NaN, y: -Infinity, end: NaN, height: 1 });
  let gutter = findGutter(false);
  if (!gutter && rows.length >= 4) {
    for (let i = rows.length - 2; i > 0; i--) {
      const upper = rows[i - 1], lower = rows[i];
      if (upper.y - lower.y > 1.8 * Math.max(upper.height, lower.height))
        rows.splice(i, 0, { x: NaN, y: (upper.y + lower.y) / 2, end: NaN, height: 1 });
    }
    gutter = findGutter(true);
  }
  if (!gutter) return [items];
  const passages = [[], [], [], []];
  for (const row of items)
    passages[row.y >= gutter.top ? 0 : row.y <= gutter.bottom ? 3 : row.x < gutter.x ? 1 : 2].push(row);
  return passages[1].length && passages[2].length ? passages.flatMap(part => part.length ? columnPassages(part) : []) : [items];

  function findGutter(local) {
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
            && (local || Math.max(left[0].y, right[0].y) - Math.min(left.at(-1).y, right.at(-1).y) <= height * .5)) {
            gutter = { x, top, bottom: row.y };
            score = count;
          }
        }
        left = []; right = []; top = row.y;
      }
    }
    return gutter;
  }
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
    let columns;
    data.columnText = () => {
      if (columns === undefined) columns = assemble(columnPassages(rows), true);
      return columns;
    };
    return assemble([rows]);
    function assemble(passages, columnOnly = false) {
      const horizontal = passages.length > 1;
      if (columnOnly && !horizontal) return null;
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
      return { ...content, raw, parts, breaks, horizontal };
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
    for (const font of textFonts) for (const key of ['bold', 'italic']) if (reasons[key] && font[key] === true) {
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
    const layer = cached.layer = {};
    readPageFonts(page).then(async fonts => {
      Object.assign(layer, { fonts, text: await cached.text });
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
    const api = selection(), editor = api?.editor, model = editor?.getModel(), pdf = viewer()?.pdfDocument;
    if (!pdf || !model || api.selectionEnabled === false || context.signal?.aborted) return null;
    if (context.pdf && context.pdf !== pdf || context.editor && context.editor !== editor
      || context.model && context.model !== model) return null;
    if (context.version !== undefined ? context.version !== model.getVersionId()
      : context.source !== undefined && context.source !== model.getValue()) return null;
    const documentModel = editor.document;
    Object.assign(context, { pdf, editor, model, documentModel, snapshot: documentModel.snapshot });
    return this.editorSourceIndex(documentModel);
  }
  reviewItems(context = {}, focus) {
    const { source, priority } = context;
    if (source === undefined ? selection()?.selectionEnabled === false : !this.prepareReview(context)) return { items: [] };
    if (source === undefined) this.editorSourceIndex(context.editor?.document);
    const review = !focus && context.onProgress && priority && this.currentReview;
    const previous = review?.index, index = this.index;
    if (!previous?.fontsCurrent || previous === index || previous.prepared?.pdf !== this.pdf)
      return this.completeReview(context, undefined, focus);
    const { changedRange, lowerBound, shiftRanges } = window.PdfSelectionDiff, items = [];
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
      option.edits = shiftRanges(edits, sourceDelta);
      items.push({ ...item, id: undefined, sourceStart: start + delta, sourceEnd: end + delta,
        reviewStart: reviewStart === undefined ? undefined : reviewStart + delta,
        pdfSource: undefined, range: undefined, previewDecorations: undefined, options: [option] });
    }
    if (!items.length) return this.completeReview(context);
    return Promise.resolve(context.onProgress(this.cacheReview({ index, items, partial: true })))
      .then(accepted => accepted !== false && this.prepareReview(context) ? this.completeReview(context) : { items: [] });
  }
  get currentReview() {
    const { review } = this;
    if (review && review.model === this.model && review.enabled === this.textEnabled && review.fontKey === this.fontStyles.join(',')) return review;
  }
  get reviewProvider() { return reviewIds[this.textEnabled ? 0 : this.fontStyles.includes('italic') ? 1 : this.fontStyles.length ? 2 : -1]; }
  completeReview(context = {}, notice = context.request?.candidateId ? null : context.request?.notice, focus) {
    const { index, model, textEnabled } = this, { source } = context, span = notice?.source;
    if (source !== undefined && span?.index !== index) {
      const version = context.version ?? model.getVersionId?.(), pages = this.environment.getSourcePages?.();
      const prepared = this.fontStyles.length ? this.indexFonts(this.pdf, index, context.signal, pages) : this.indexDocument(this.pdf, pages);
      return prepared.then(full => full && source === model.getValue() && this.prepareReview({ ...context, source: undefined, version }) && this.index === index
        ? this.completeReview({}, notice, focus) : { items: [] });
    }
    const shared = index.getDifferences(), review = this.currentReview;
    const data = review?.shared === shared ? review : this.review = this.cacheReview(
      { model, enabled: textEnabled, fontKey: this.fontStyles.join(','), shared, partial: false }, { text: textEnabled });
    if (typeof focus === 'string') {
      const item = data.items.find(item => item.id === focus);
      return item ? { items: data.items, item } : data;
    }
    const { lowerBound, comparisonIndex } = window.PdfSelectionDiff, { html, missing } = notice || {};
    const selected = !focus && this.reviewLists.get(notice);
    if (selected && selected.items === data.items && selected.index === index) return selected;
    if (!focus && (!textEnabled || span?.index !== index || index.raw.slice(span.start, span.end) !== html)) return data;
    const changes = focus || missing ? [] : comparisonIndex(notice).parts.filter(part => part.changed);
    if (!focus && !missing && !changes.length) return data;
    let first, last;
    for (const [at, item] of data.items.entries()) {
      if ((item.reviewStart ?? item.sourceStart) > span.end) break;
      if (focus) {
        if (item.font && item.sourceStart < span.end && item.sourceEnd > span.start) return { items: data.items, item };
      } else if (!item.font && this.overlapsDifference(item, span.start, span.end)) {
        if (item.missing && !missing) return data;
        first ??= at;
        last = at;
      }
    }
    if (focus) return data;
    const position = first ?? lowerBound(data.items, span.start, item => item.sourceStart), width = html.length;
    const selectedItem = { sourceStart: span.start, sourceEnd: span.start + width, selection: true,
      queueRange: [position, last ?? position], comparison: notice, missing };
    const selectedItems = [selectedItem], { items } = shared, firstChange = changes[0];
    const group = first === last && [...html].length === 1 && this.reviewLists.get(data.items[first]);
    if (firstChange && last !== undefined) for (const anchor of group?.items ?? items) {
      if (anchor.missing) continue;
      const text = anchor.comparison.html, needle = firstChange.html;
      candidate: for (let offset = text.indexOf(needle); offset >= 0; offset = needle ? text.indexOf(needle, offset + 1) : -1) {
        const start = anchor.sourceStart + offset - firstChange.start, end = start + width;
        if (start < 0 || start === span.start || !index.raw.startsWith(html, start)) continue;
        let matched = 0;
        for (let at = lowerBound(items, start, item => item.sourceEnd); items[at]?.sourceStart <= end; at++) {
          const item = items[at];
          if (!this.overlapsDifference(item, start, end)) continue;
          if (item.missing) continue candidate;
          const key = item.comparison.selection === true ? 'changed' : 'inconsistent';
          for (const part of comparisonIndex(item.comparison).parts) {
            if (!part[key]) continue;
            const from = item.sourceStart + part.start - start, length = part.html.length;
            const left = Math.max(0, -from), right = Math.min(width - from, length);
            if (left > right) continue;
            const pdf = !left && right === length ? part.pdf : length === part.pdf.length ? part.pdf.slice(left, right) : null;
            const expected = changes[matched++];
            if (expected?.start !== from + left || expected.end !== from + right
              || expected.pdf !== pdf || expected.html !== part.html.slice(left, right)) continue candidate;
          }
        }
        if (matched === changes.length) selectedItems.push({ sourceStart: start, sourceEnd: end, selection: true, missing,
          comparison: { ...notice, source: { index, start, end } }, queueRange: undefined });
      }
    }
    this.cacheReview({ items: selectedItems.sort((a, b) => a.sourceStart - b.sourceStart) }, { selected: true, changes });
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
    targets, connections, selected = false, changes } = {}) {
    const index = data.index ??= data.shared?.index ?? this.index;
    const { comparisonIndex, shiftRanges } = window.PdfSelectionDiff, shared = data.shared;
    const keys = fonts === true ? fontKeys : fonts;
    const styles = index.formats && keys?.length && !data.partial && !selected ? keys : undefined;
    const fromShared = !targets && !connections && !data.items && shared?.fontSpans;
    const items = text ? data.items || (!targets && !connections ? shared?.items : undefined) : [];
    if (fromShared && styles) data.items = index.fontCandidates(items, shared.fontSpans, styles, true);
    else if (!items || styles) data.items = index.candidates(targets, connections ?? (!targets ? shared?.connections : undefined),
      false, { items, fonts: styles });
    else data.items = items.slice();
    const groups = new Map();
    Object.assign(data, { entries: [], edits: [], plans: [] });
    for (const [at, item] of data.items.entries()) {
      const value = shared && !data.partial && (!fromShared || !item.font) ? data.items[at] = { ...item } : item;
      value.id ||= `${value.font ? 'font:' : ''}${value.sourceStart}:${value.sourceEnd}`;
      if (value.font) value.text = index.raw.slice(value.sourceStart, value.sourceEnd);
      value.pdfSource ||= index.candidateEntry(value);
      if (!value.options) {
        const { sourceStart, sourceEnd, font, comparison } = value;
        const option = font ? { id: 'format', edits: [] } : { id: 'pdf', label: '替换', edits: [] };
        if (makeEdits && font) option.edits = index.fontEdits(sourceStart, sourceEnd, font);
        else if (makeEdits && !value.missing && value.selection)
          option.edits = shiftRanges(changes ?? comparisonIndex(comparison).parts.filter(part => part.changed),
            sourceStart, (part, start, end) => index.textEdits(start, end, part.pdf));
        else if (makeEdits && !value.missing && !(index.starts?.[sourceStart] < index.ends?.[sourceStart - 1]
          || index.starts?.[sourceEnd] < index.ends?.[sourceEnd - 1]))
          option.edits = index.textEdits(sourceStart, sourceEnd, comparison?.pdf);
        value.options = [option];
      }
      const [option] = value.options;
      if (value.font && option) Object.assign(option, { title: `替换格式：${value.text}（${fontSummary(value.formats)}）`,
        range: { start: index.starts[value.sourceStart], end: index.ends[value.sourceEnd - 1] } });
      if (this.editorDocument && (value.font || value.missing || value.selection && value.comparison.html.trim()))
        value.range ||= this.editorDocument.rangeAt(value.sourceStart, value.sourceEnd, true);
      data.entries.push(value.pdfSource);
      data.edits.push(...option.edits);
      if (!value.missing) data.plans.push(option);
      if (selected) { this.reviewLists.set(value, data); continue; }
      const key = data.partial ? value : this.pattern(value, index);
      const group = groups.get(key) || groups.set(key, { index, items: [], entries: [], edits: [] }).get(key);
      group.items.push(value);
      group.entries.push(value.pdfSource);
      group.edits.push(...option.edits);
      this.reviewLists.set(value, group);
    }
    for (const group of groups.values()) this.reviewLists.set(group.items, group);
    this.reviewLists.set(data.items, data);
    return data;
  }
  replacement({ item, items, position, context: { editor, documentModel } }, all) {
    const data = this.reviewLists.get(items), index = data?.index || this.index;
    const offset = index.starts[item.sourceStart] ?? index.source.length;
    if (index !== this.editorSourceIndex(documentModel)) return { offset };
    if (all && data?.partial) throw new Error('完整差异队列仍在准备，请稍后替换全部');
    const group = all ? data : this.reviewLists.get(item), members = all ? items : group?.items || [];
    let edits = group?.edits ?? members.flatMap(value => value.options[0].edits);
    let count = members.length, next, first, last = -1;
    if (!all && item.font) edits = edits.slice();
    if (!all) for (const [at, candidate] of items.entries()) {
      if (!group || this.reviewLists.get(candidate) !== group) {
        if (!(item.font && candidate.font && members.some(value => value.font
          && candidate.sourceStart < value.sourceEnd && candidate.sourceEnd > value.sourceStart))) {
          if (at > position) next ??= at;
          continue;
        }
        count++;
        edits.push(...candidate.options[0].edits);
      }
      first ??= at;
      last = at;
    }
    edits = documentModel.validateEdits(edits);
    let resume = offset;
    for (const { start, end, text } of edits) {
      if (end > offset) break;
      resume += text.length - (end - start);
    }
    return { position: next ?? items.length, priority: all || last - (first ?? -1) + 1 === count,
      offset: resume, apply: () => documentModel.applyEdits(edits, { editor }) };
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
    pairs.set(pdf, Object.assign(index, { sourcePageKey }));
    if (previous) index.inherit(previous);
    return index;
  }
  findLocations(pdf, entries, visibleOnly = false, visible) {
    const scope = this.environment.getSourcePages?.(), full = this.getDocumentIndex(pdf, scope);
    visible ??= this.environment.getVisiblePages?.() || [];
    const pageIndexes = visible.map(page => page.index), searchPages = [...visible, null];
    const hasLayoutBreaks = full?.pages?.some(page => page.breaks?.length), prepared = new Map(), locations = [];
    for (const originalEntry of entries) {
      const { index: source, start, end, marked } = originalEntry;
      let data, fragments;
      if (source) {
        data = prepared.get(source);
        if (!data) prepared.set(source, data = {
          missing: source.getDifferences(pageIndexes).items.filter(item => item.missing),
          document: hasLayoutBreaks ? source.targetConnections(full).toSorted((a, b) => a.start - b.start) : []
        });
        const ranges = data.document.filter(range => range.start < end && range.end > start);
        if (visibleOnly || marked || ranges.some((range, i) => ranges[i + 1] &&
          (range.targetStart > ranges[i + 1].targetStart || /\S/u.test(full.raw.slice(range.targetEnd, ranges[i + 1].targetStart))))) {
          const connections = ranges.length ? ranges : data.visible ??= source.pairs.filter(({ target }) => target === full || pageIndexes.includes(target));
          if (connections.length && !connections.some(range => range.start <= start && range.end >= end)) {
            fragments = [];
            for (const range of connections.concat(data.missing)) {
              const from = Math.max(start, range.sourceStart ?? range.start), to = Math.min(end, range.sourceEnd ?? range.end);
              if (from < to) fragments.push(Object.assign(source.entry(from, to, marked), { originalEntry }));
            }
          }
        }
      }
      for (const entry of fragments?.length ? fragments.sort((a, b) => a.start - b.start) : [originalEntry]) {
        const absent = this.textEnabled && data?.missing.find(({ sourceStart, sourceEnd }) =>
          entry.start === entry.end ? entry.marked && entry.start >= sourceStart && entry.start <= sourceEnd
            : entry.start < sourceEnd && entry.end > sourceStart);
        let index = full, number, hit;
        if (absent) hit = full && source.missingRange(full, absent.sourceStart, absent.sourceEnd, absent.comparison);
        else if (!source) hit = !visibleOnly && full?.search(entry);
        else for (const page of searchPages) {
          const target = page ? page.index : full;
          if (!target) continue;
          const found = !page && (hit || visibleOnly) ? source.range(target, entry.start, entry.end, false, undefined, true)
            : source.locate(target, entry, false, target.connections.get(source)?.scope, true, { visiblePage: !!page });
          if (!found || hit && found.approximate) continue;
          hit = found; index = target;
          if (page) number = page.number;
          if (!hit.approximate) break;
        }
        if (!hit && !absent) { locations.push({ entry, targets: [], queries: source ? [] : [entry.text] }); continue; }
        const start = absent?.sourceStart ?? entry.start, end = absent?.sourceEnd ?? entry.end;
        const span = source && { index: source, start, end };
        const counterpart = hit ? index.raw.slice(hit.start, hit.end) : '';
        const difference = absent ? { ...absent.comparison, missing: true } : entry.difference
          || (hit.approximate || entry.text !== counterpart ? { html: entry.text, pdf: counterpart } : null);
        const targetPages = !hit ? visible : index.pages || [{ number, start: 0, end: index.raw.length, parts: index.parts }];
        const caret = hit?.start === hit?.end;
        const targets = [];
        for (const page of targetPages) {
          if (absent) {
            if (hit && (hit.start < page.start || hit.end > page.end || hit.endBias && hit.start === page.start)) continue;
            const range = hit ? { ...hit, start: hit.start - page.start, end: hit.end - page.start }
              : page.index?.raw.trim() && source.missingRange(page.index, start, end, absent.comparison);
            if (range) targets.push({ pageNumber: page.number, range, start, end, marked: true, source: span, difference, text: counterpart,
              ...(hit && { item: page.parts.find(part => part.end >= hit.start)?.item }) });
            continue;
          }
          if (!(caret ? hit.start >= page.start && hit.start <= page.end : hit.start < page.end && hit.end > page.start)) continue;
          const fragment = index.entry(Math.max(hit.start, page.start), Math.min(hit.end, page.end), entry.marked, undefined, page);
          const sourceRange = entry.marked || start === end ? entry : source?.range(index, fragment.start, fragment.end, true, hit.connection);
          targets.push({ pageNumber: page.number, item: page.parts.find(part => part.end > fragment.start)?.item, difference,
            layer: index.layer, range: index.layer && { start: fragment.start, end: fragment.end }, marked: entry.marked,
            text: fragment.text, before: fragment.before, after: fragment.after, ...(difference && span && { source: span }),
            ...((sourceRange || caret) && { index: source, start: sourceRange?.start ?? start, end: sourceRange?.end ?? end }) });
        }
        locations.push({ entry, targets, ...(absent ? { queries: [] } : { approximate: hit.approximate }),
          notice: (absent || entry.marked) && difference && { ...difference, source: span } });
      }
    }
    if (visibleOnly || full || locations.every(hit => hit.targets.length && !hit.approximate)) return locations;
    return this.indexDocument(pdf, scope).then(index => index ? this.findLocations(pdf, entries) : locations);
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
      let mappedStart = 0, mapped, sourceLength;
      for (const number of index.sourcePages || Array.from({ length: index.pdf.numPages }, (_, i) => i + 1)) {
        if (!this.environment.isCurrent(index.pdf)) return null;
        await this.environment.waitForIdle(index.pdf);
        if (!this.environment.isCurrent(index.pdf)) return null;
        const page = await index.pdf.getPage(number), ordinary = await readPageText(page);
        if (!this.environment.isCurrent(index.pdf)) return null;
        const columns = source && pageData(page).columnText();
        const limit = columns ? Math.min(sourceLength ??= significantText(source.raw).length, significantText(ordinary.raw).length) : 0;
        let content = ordinary, best = 0;
        for (const layout of [ordinary, columns]) {
          if (best >= limit) break;
          const target = new PdfConnections(source, { ...layout, sourcePages: [number] });
          source.connect(target);
          const matched = [];
          for (const connection of source.targetConnections(target))
            for (const part of source.compare(connection, true)?.parts || [])
              if (!part.changed) matched.push([connection.start + part.start, connection.start + part.end]);
          let score = 0, edge = 0;
          for (const [start, end] of matched.sort((a, b) => a[0] - b[0])) if (end > edge) {
            score += source.raw.slice(Math.max(edge, start), end).replace(/[\s\-\u00ad\u2010\u2011]/gu, '').length;
            edge = end;
          }
          if (score > best) { best = score; content = layout; }
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
  columnText(pdf, number) { return this.getDocumentIndex(pdf, this.environment.getSourcePages?.())?.pages.find(page => page.number === number)?.columnText; }
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
let host, localLocator, highlights, dismissed;
const actionId = 'mew.pdf-difference';
function readerWindow() {
  const opener = window.ReaderUI?.getPdfViewer ? null : window.opener;
  try { return opener && !opener.closed && opener.ReaderUI?.getPdfViewer ? opener : window; } catch { return window; }
}
function viewer(reader = readerWindow()) { return reader.ReaderUI?.getPdfViewer?.() || window.PdfSelection?.viewer; }
function selection(reader = readerWindow()) { return reader?.PdfSelection || window.PdfSelection; }
function currentLocator(reader = readerWindow()) {
  const existing = selection(reader)?.locator || (reader !== window && reader.PdfReviewProvider?.locator) || localLocator;
  if (existing) return existing;
  localLocator = new PdfLocator({}, { document, getPdf: () => viewer()?.pdfDocument,
    isCurrent: pdf => selection()?.selectionEnabled !== false && viewer()?.pdfDocument === pdf,
    waitForIdle: () => new Promise(resolve => setTimeout(resolve, 0)) });
  try { localLocator.textEnabled = localStorage.getItem('mew.pdf-review.enabled') !== 'false'; } catch { }
  return localLocator;
}
function onDifference({ detail }) {
  const { editor, side } = detail, owner = editor?.getDomNode()?.ownerDocument.defaultView;
  return side !== 'pdf' && owner?.ReplacementReview && owner !== window && !reviewIds.some(id => host.isOpenFor(id, editor))
    ? owner.PdfReviewProvider?.openDifference(detail) : openDifference(detail);
}
function readDifference(locator, context) {
  const { request, model } = context, { notices = [], candidateId } = request;
  let textNotice, sourceNotice;
  if (candidateId && request.kind !== 'font') textNotice = notices[0];
  else for (const notice of notices) {
    const { html, pdf, source } = notice;
    if (source) sourceNotice ??= notice;
    if (typeof html !== 'string' || typeof pdf !== 'string') continue;
    if (source && source.index.raw.slice(source.start, source.end) !== html) continue;
    const key = notice.selection === true ? 'changed' : 'inconsistent';
    if (window.PdfSelectionDiff.comparisonIndex(notice).parts.some(part => part[key])) {
      textNotice = notice;
      break;
    }
  }
  if (textNotice ? !locator.textEnabled : !sourceNotice || !model) return;
  request.notice = textNotice || sourceNotice;
  if (!textNotice) request.kind = 'font';
  const span = model && request.notice.source;
  if (!span) return {};
  Object.assign(context, { source: span.index.source, version: span.index.version });
  return locator.reviewItems(context, candidateId || (!textNotice && span));
}
async function openDifference({ editor, model: expectedModel, pdf, ...request }) {
  const reader = readerWindow(), locator = currentLocator(reader), provider = locator.reviewProvider;
  if (!provider || selection(reader)?.selectionEnabled === false || pdf !== viewer(reader)?.pdfDocument) return;
  const model = editor?.getModel();
  if (expectedModel && expectedModel !== model) return;
  const range = editor?.getSelection?.()?.toString(), context = { editor, model, pdf, request };
  if (dismissed && dismissed.editor === editor && dismissed.model === model
    && dismissed.interaction === request.interactionId && dismissed.range === range
    && dismissed.version === model?.getVersionId?.()) return;
  const prepared = await readDifference(locator, context);
  if (!prepared) return;
  const { item = prepared.selection, items } = prepared;
  if (model && request.notice.source
    && (!item || context.snapshot !== editor.document?.snapshot || editor.getSelection?.()?.toString() !== range)) return;
  dismissed = null;
  if (nativeEditor && request.side === 'html') {
    if (item) host.showHover(review, context, item, items, request.notice.source);
    if (!request.userSelection) return;
    request.side = 'pdf';
  }
  return item ? openPrepared(provider, context, item, prepared)
    : host.showNotice({ title: 'PDF 文字差异', message: '文字不一致', anchor: request.anchor,
      comparison: comparisonRows(request.notice, false, request.notice.missing, true), layout: presentation(context) });
}
function openPrepared(provider, { editor, model, pdf, snapshot, request }, item, { items, selection }) {
  request.snapshot = { items, selection, context: { model, pdf, ...snapshot } };
  return host.openForSelection(provider, editor, item.id, request);
}
function presentation(context, item) {
  const { editor, request, snapshot, documentModel } = context, reader = readerWindow();
  const source = editor?.getDomNode()?.ownerDocument.defaultView || window, split = source !== reader;
  if (split && request?.side !== 'pdf') return { side: 'html', switchable: true, switchLabel: '查看PDF', host: source.ReplacementReview };
  const { container, eventBus, pdfDocument } = viewer(reader) || {}, locator = currentLocator(reader);
  const entry = item?.pdfSource, group = snapshot === documentModel?.snapshot && locator.reviewLists.get(item);
  const click = request && (!item || item.sourceStart === request.notice?.source?.start) ? request : {};
  const { anchorBox: box, anchorElement } = click;
  const rect = box && anchorElement?.isConnected && anchorElement.getBoundingClientRect();
  let anchor = rect ? { left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height,
    bottom: rect.top + (box.y + box.h) * rect.height } : click.anchor;
  const entries = group?.entries ?? (entry ? [entry] : []);
  const anchors = locator.reviewAnchors(anchor ? entries.filter(value => value !== entry) : entries, pdfDocument);
  anchor ||= anchors.get(entry) || null;
  anchors.delete(entry);
  return { side: 'pdf', switchable: split, switchLabel: '查看HTML', host: reader.ReplacementReview,
    container, eventBus, anchor, highlights: anchor ? [anchor, ...anchors.values()] : [...anchors.values()] };
}
function content({ items, context: { documentModel } }, item) {
  const locator = currentLocator(), edits = item?.options[0].edits, data = locator.reviewLists.get(items);
  return { message: item?.missing ? 'OCR 层缺少相关文字。' : item?.font ? fontSummary(item.formats || [item]) :
      item ? '文字不一致' : items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。',
    edits: locator.reviewLists.get(item)?.edits, allEdits: data?.edits, all: data?.partial ? false : undefined,
    comparison: item?.font ? ['htmlFont', 'font'].map((field, i) => ({ label: i ? 'PDF' : 'HTML', parts: [{ text: fontSummary(item.formats, field) }] }))
      : comparisonRows(item?.comparison, !item?.selection, item?.missing, item?.selection),
    previewDecorations: item?.font || item?.missing ? item.previewDecorations ||= (data?.index || item.pdfSource?.index || locator.index)
      .sourceSegments(item.sourceStart, item.sourceEnd, true).map(({ start, end }) => ({ range: documentModel.rangeAt(start, end),
        options: { inlineClassName: item.missing ? 'mew-review-proposed' : 'mew-review-format', stickiness: 1 } })) : [],
    range: item?.range || (edits?.length ? documentModel.rangeAt(edits[0].start, edits.at(-1).end) : null),
    apply: !!edits?.length, advance: false, expanded: false };
}
const review = {
  compact: true, content, presentation,
  apply(state, all) { return currentLocator().replacement(state, all); },
  isCurrent: context => !!currentLocator().prepareReview({ ...context }),
  available: editor => !editor || !!currentLocator().prepareReview({ editor }),
  containsSelection(item, request) {
    const source = request?.notice?.source;
    return source && item && (this.id === 'pdf-ocr' ? item.sourceStart === source.start && item.sourceEnd === source.end
      : item.sourceStart < source.end && item.sourceEnd > source.start);
  },
  selectComparison({ editor, documentModel, model, pdf, request }, part) {
    const { source } = part, owner = source.index.document.defaultView;
    editor.setSelection(documentModel.rangeAt(source.start, source.end, true));
    owner.dispatchEvent(new owner.CustomEvent('pdf-selection-difference', { detail: {
      editor, model, pdf, ...request, interactionId: undefined, snapshot: null, notices: [part] } }));
  },
  onSelect(item, { editor }, items, previewEnabled = false) {
    editor.getDomNode()?.classList.toggle('mew-review-preview', previewEnabled);
    selection()?.showReviewPointer(editor, currentLocator().reviewLists.get(item)?.items || []);
  },
  onClose({ editor }) { editor.getDomNode()?.classList.remove('mew-review-preview'); selection()?.clearReviewPointer(editor); }
};
function onSources({ detail: { editor, pdf, enabled, diffEnabled } }) {
  const locator = currentLocator(window), context = { editor, pdf };
  if (!editor?.createDecorationsCollection || !locator.prepareReview(context)) return;
  const data = locator.completeReview(), registered = editor.getAction?.(actionId);
  if (nativeEditor || !registered) host.bindSuggestions(editor,
    registered ? undefined : model => locator.prepareReview({ editor, model }) ? locator.completeReview().plans : [], data.plans);
  highlights.updateSource(editor, [data, enabled], () => {
    if (!enabled && !nativeEditor) return [];
    const editorId = !nativeEditor && editor.getId?.();
    const hover = nativeEditor ? item => host.hoverContent(review, context, item, data.items)
      : item => sourceHover(item, context.model, editorId && `${editorId}:${actionId}`);
    return sourceDecorations(data.index, data.items, locator.fontStyles, locator.textEnabled, hover, context.documentModel, !!enabled);
  });
  if (diffEnabled) selection(window)?.showReviewPointer(editor, data.items, data);
  if (registered || !editor.addAction) return;
  const action = editor.addAction({ id: actionId, label: '查看 PDF 差异', async run(_, request) {
    const context = { editor, version: request.version, request: { side: 'pdf' } };
    const index = locator.prepareReview(context), span = request.selection;
    if (!index || context.model.uri.toString() !== request.model) return;
    const data = locator.completeReview({}, span && { ...span, source: { index, start: span.start, end: span.end } });
    const position = data.selection?.queueRange[0] ?? data.items.findIndex(item => item.id === request.id);
    const item = data.selection || data.items[position];
    if (!item) return;
    const owner = editor.getDomNode()?.ownerDocument.defaultView;
    if (request.save) {
      await locator.replacement({ item, items: data.items, position, context }, false).apply?.();
      return (nativeEditor ? editor : owner.mewWorkbench || owner.readerMonaco).save({ followPdf: false, model: context.model });
    }
    context.request.notice = { ...item.comparison, missing: item.missing, source: item.pdfSource };
    const result = item.font || data.selection ? data : locator.completeReview(context), selected = item.font ? item : result.selection;
    if (owner && owner !== window) owner.open('', window.name ||= `mew-review-${crypto.randomUUID()}`)?.focus();
    if (selected) return openPrepared(locator.reviewProvider, context, selected, result);
  } });
  editor.onDidDispose(() => action.dispose());
}
function setReviewEnabled(value, key, persist = true) {
  const api = selection(), locator = currentLocator(), text = key === 'text';
  if (text) locator.textEnabled = value;
  else locator.fontStyles = fontKeys.filter(name => key && name !== key ? locator.fontStyles.includes(name) : value);
  if (persist) for (const style of key ? [key] : fontKeys) api?.savePreference(`${style}Detection`, text ? value : !!value,
    text ? '无法保存文字差异设置' : '无法保存字体探测设置');
  if (text) try { localStorage.setItem('mew.pdf-review.enabled', String(value)); } catch { }
  for (let i = text ? 1 : 0; i < reviewIds.length; i++) host.invalidate(reviewIds[i]);
  if (!text) api?.clearReviewPointer();
  api?.refresh();
}
window.PdfReviewReady = (async () => {
  if (!window.MewEditorCore?.DocumentModel) await import('../editor-core.js');
  if (!window.PdfSelectionDiff?.PdfConnections) await import('./pdf-connection.js');
  await window.PdfSelectionDiff.ready;
  if (!window.ReplacementReview || !window.ReviewHighlights) await import('./replacement-review.js');
  host = window.ReplacementReview;
  highlights = window.ReviewHighlights.create({ document, classes: {
    selection: 'mew-pdf-selection-highlight', pointer: 'mew-pdf-review-pointer', caret: 'mew-pdf-selection-caret' } });
  const events = Object.entries({ 'pdf-selection-difference': onDifference, 'pdf-selection-sources': onSources, 'pdf-selection-reset': highlights.clearMarks,
    'replacement-review-closed': ({ detail: { id, editor, model } }) => {
    const api = selection();
    if (reviewIds.includes(id) && api?.selectionEnabled !== false) dismissed = { editor, model, interaction: api?.interactionId,
      version: model.getVersionId?.(), range: editor.getSelection()?.toString() };
  } });
  for (const [name, handler] of events) window.addEventListener(name, handler);
  window.PdfReviewProvider = {
    PdfLocator, get locator() { return currentLocator(); }, highlights, setFontEnabled: setReviewEnabled, openDifference,
    textItemBaseline: pdfTextBaseline, fontStyle: pdfFontStyle, sourceDecorations, fontSummary, comparisonRows, readPageText, readPageFonts, layerFonts,
    ...(!nativeEditor && { sourceHover }) };
  const unregister = ['text', ...fontKeys].map((key, i) => host.register({ ...review, id: reviewIds[i],
    label: ['PDF 文字差异审阅', 'PDF 斜体探测', 'PDF 粗体探测'][i], get locator() { return window.PdfReviewProvider.locator; },
    isEnabled: () => i ? currentLocator().fontStyles.includes(key) : currentLocator().textEnabled,
    setEnabled: value => i ? (readerWindow().PdfReviewProvider || window.PdfReviewProvider).setFontEnabled(value, key) : setReviewEnabled(value, key) }));
  for (const [id, label, setting, setEnabled, toggleOnly] of [
    ['pdf-selection', 'PDF 差异高亮', 'enabled', value => selection()?.setDiffHighlight(value), true],
    ['source-diff', '源码差异高亮', 'sourceEnabled', value => selection()?.setDiffHighlight(value, 'source'), true],
    ['pdf-selection-sync', 'PDF 与源码选区联动', 'selectionEnabled', value => selection()?.setSelectionHighlight(value)]
  ]) unregister.push(host.register({ id, label, toggleOnly, setEnabled, isEnabled: () => selection()?.[setting] === true,
    available: () => { const api = selection(); return !!api && (setting === 'selectionEnabled' || api.selectionEnabled); } }));
  let previousPdf = viewer()?.pdfDocument, previousEnabled, previousFonts = currentLocator().fontStyles;
  const poll = !nativeEditor && setInterval(() => {
    const reader = readerWindow(), api = selection(reader), pdf = viewer(reader)?.pdfDocument, fonts = currentLocator(reader).fontStyles;
    const fontsChanged = previousFonts !== fonts;
    const state = `${api?.enabled}:${api?.sourceEnabled}:${api?.selectionEnabled}:${fonts}`;
    if (previousPdf !== pdf || fontsChanged) for (const id of reviewIds) host.invalidate(id, context => fontsChanged || context.pdf !== pdf);
    if (previousEnabled !== state) { previousEnabled = state; host.refreshMenu(); }
    previousPdf = pdf; previousFonts = fonts;
  }, 500);
  window.addEventListener('pagehide', () => {
    clearInterval(poll);
    for (const [name, handler] of events) window.removeEventListener(name, handler);
    highlights.dispose();
    unregister.forEach(dispose => dispose());
  }, { once: true });
  return window.PdfReviewProvider;
})();
