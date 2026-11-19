'use strict';
// Source/PDF mapping and candidate generation.
const nativeEditor = !!window.PdfSelectionOptions?.nativeEditor;
const pages = new WeakMap(), fontKeys = ['italic', 'bold'], reviewIds = ['pdf-ocr', 'pdf-font', 'pdf-bold'];
const wordBefore = /(?<=([\p{L}\p{M}\p{N}_'’-]+))/uy, wordAfter = /^[\p{L}\p{M}\p{N}_'’-]+/u;

function sourceDecorations(index, items = [], fonts = true, text = true, hover, documentModel, highlighted = true) {
  return items.flatMap(item => {
    if (!(item.font ? fonts : text)) return [];
    const { comparison, sourceStart, sourceEnd } = item, font = !comparison;
    const html = comparison?.html.trim(), pdf = comparison?.pdf;
    const start = !font && !html && /^\s/u.test(pdf) ? sourceEnd : sourceStart;
    const edits = !font && !item.selection && start === sourceStart && (html || pdf.trim()) && item.options?.[0]?.edits;
    const segments = edits?.length ? edits : index.sourceSegments(start, sourceEnd, font);
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
  if (nativeEditor) return;
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
  const diff = window.PdfSelectionDiff.comparisonIndex(value), { parts } = diff;
  // Expanded rows carry live source indices and offsets; only compact rows are reusable.
  const rows = compact && (diff.rows ||= []);
  if (rows?.[key]) return rows[key];
  const first = compact ? parts.findIndex(part => part[change]) : -1;
  const last = first < 0 ? parts.length - 1 : parts.findLastIndex(part => part[change]);
  const context = text => ({ html: text, pdf: text, changed: false, text, source: undefined });
  const start = parts[first]?.start ?? 0, end = parts[last]?.end ?? 0;
  const prefix = first < 0 ? '' : (start > 45 ? '…' : '') + value.html.slice(Math.max(0, start - 45), start);
  const suffix = first < 0 ? '' : value.html.slice(end, end + 45) + (value.html.length - end > 45 ? '…' : '');
  const sides = missing && !value.pdf.trim() ? ['html'] : ['html', 'pdf'], source = !compact && value.source;
  const result = sides.map(side => {
    const cells = prefix ? [context(prefix)] : [];
    for (let i = Math.max(0, first); i <= last; i++) {
      const part = parts[i], changed = !!part[change], text = part[side];
      cells.push({ ...part, changed: changed && !missing,
        text: changed && !text.trim() && part[side === 'html' ? 'pdf' : 'html'].trim() ? '' : text,
        source: source ? { index: source.index, start: source.start + part.start, end: source.start + part.end } : undefined });
    }
    if (suffix) cells.push(context(suffix));
    return { label: side.toUpperCase(), parts: cells };
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
    const items = [];
    for (const item of content.items) {
      const { str, height, width } = item;
      if (!str?.length) continue;
      const x = item.transform[4];
      items.push({ item, height, x, end: x + width,
        y: pdfTextBaseline(item), text: str.trim(), wide: width >= height * 4, word: /\p{L}{2}/u.test(str) });
    }
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
    const fonts = new Map(), textFonts = new Set();
    let letters = 0, boldLetters = 0, italic = true;
    for (const { item: { fontName: id, str } } of parts) {
      let style = fonts.get(id);
      if (!style) {
        style = pdfFontStyle(id && page.commonObjs?.has(id) ? page.commonObjs.get(id) : null, id || '');
        if (failed) Object.assign(style, { bold: null, italic: null, reason: '字体读取失败' });
        // Invisible OCR retains declarations, not scan-derived style evidence.
        else if (invisibleFonts.has(id)) Object.assign(style,
          { declaredBold: style.bold, declaredItalic: style.italic, reason: style.reason || 'OCR 字体' });
        fonts.set(id, style);
      }
      const count = str.replace(/\s/g, '').length;
      if (!count) continue;
      letters += count;
      if (style.bold === true) boldLetters += count;
      italic &&= style.italic === true;
      textFonts.add(style);
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
      Object.assign(cached.layer, { items: text.items.filter(item => item.str?.length), fonts: await readPageFonts(page), text });
      refresh();
    }).catch(() => { delete cached.layer; });
  }
  const data = cached?.layer, items = data?.items || [], names = new Map();
  let i = 0;
  for (const span of view?._textHighlighter?.textDivs || layer.querySelectorAll('span[role="presentation"]')) {
    const { textContent } = span;
    if (!textContent) continue;
    const item = items[i++];
    if (textContent !== item?.str) { i = -1; break; }
    names.set(span, item);
  }
  if (i !== items.length) names.clear();
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
  prepareReview(context = {}) {
    if (selection()?.selectionEnabled === false) return null;
    const pdf = viewer()?.pdfDocument, editor = selection()?.editor, model = editor?.getModel();
    if (!pdf || !model || context.signal?.aborted || context.pdf && context.pdf !== pdf
      || context.editor && context.editor !== editor || context.model && context.model !== model) return null;
    const { version, source } = context, { document: documentModel } = editor;
    if (version !== undefined ? version !== model.getVersionId() : source !== undefined && source !== model.getValue()) return null;
    Object.assign(context, { pdf, editor, model, documentModel, snapshot: documentModel.snapshot });
    return this.editorSourceIndex(documentModel);
  }
  reviewItems(context = {}) {
    const { source, signal, onProgress, priority, request } = context;
    if (source === undefined ? selection()?.selectionEnabled === false : !this.prepareReview(context)) return { items: [] };
    if (source === undefined) this.editorSourceIndex(context.editor?.document);
    const { index, model, pdf, fontStyles, review, reviewLists, textEnabled } = this;
    const notice = request?.candidateId ? null : request?.notice, fontKey = fontStyles.join(',');
    const { changedRange, lowerBound, comparisonIndex, overlapsDifference, matchingChanges } = window.PdfSelectionDiff;
    const reusable = review?.model === model && review.enabled === textEnabled && review.fontKey === fontKey, previous = review?.index;
    if (onProgress && priority && reusable && previous !== index && previous?.prepared?.pdf === pdf && previous.fontsCurrent) {
      const items = [];
      const raw = index.change?.before === previous.raw ? index.change : changedRange(previous.raw, index.raw);
      const { oldEnd, newEnd } = changedRange(previous.source, index.source);
      const delta = raw.newEnd - raw.oldEnd, sourceDelta = newEnd - oldEnd, suffix = previous.raw !== index.raw ? raw.oldEnd : 0;
      const from = Math.max(suffix, lowerBound(previous.ends, priority.offset - sourceDelta + 1));
      for (let at = lowerBound(review.items, from, item => item.reviewStart ?? item.sourceStart);
        at < review.items.length && items.length < 5; at++) {
        const item = review.items[at], { sourceStart: start, sourceEnd: end, reviewStart } = item, { range, ...option } = item.options[0];
        if (start < suffix || previous.starts[start] < oldEnd || start === end && start === raw.oldEnd && raw.newEnd > raw.oldEnd
          || option.edits.some(edit => edit.start < oldEnd)) continue;
        items.push({ ...item, id: `${item.font ? 'font:' : ''}${start + delta}:${end + delta}`, sourceStart: start + delta, sourceEnd: end + delta,
          reviewStart: reviewStart === undefined ? undefined : reviewStart + delta, pdfSource: undefined, range: undefined, previewDecorations: undefined,
          options: [{ ...option, edits: option.edits.map(edit => ({ ...edit, start: edit.start + sourceDelta, end: edit.end + sourceDelta })) }] });
      }
      if (items.length) {
        const partial = this.cacheReview({ index, model, enabled: textEnabled, fontKey, items, shared: review.shared, partial: true });
        return Promise.resolve(context.onProgress(partial)).then(accepted => accepted !== false && this.prepareReview(context)
          ? this.reviewItems({ ...context, priority: undefined, onProgress: undefined }) : { items: [] });
      }
    }
    if (source !== undefined && notice?.source?.index !== index) {
      const version = context.version ?? model.getVersionId?.(), pages = this.environment.getSourcePages?.();
      return (fontStyles.length ? this.indexFonts(pdf, index, signal, pages) : this.indexDocument(pdf, pages)).then(full =>
        full && source === model.getValue() && this.prepareReview({ ...context, source: undefined, version }) && this.index === index
          ? this.reviewItems({ ...context, source: undefined }) : { items: [] });
    }
    const shared = index.getDifferences();
    const data = reusable && review.shared === shared ? review : this.review = this.cacheReview({
      index, model, enabled: textEnabled, fontKey, shared, partial: false }, { text: textEnabled });
    const selected = reviewLists.get(notice);
    if (selected?.items === data.items && selected.index === index) return selected;
    const span = textEnabled && notice?.source?.index === index && notice.source;
    if (!span || index.raw.slice(span.start, span.end) !== notice.html) return data;
    const { missing } = notice;
    if (!missing && !comparisonIndex(notice).parts.some(part => part.changed)) return data;
    let first, last;
    const text = [];
    for (const [at, item] of data.items.entries()) {
      if (item.font) continue;
      if (!missing) text.push(item);
      if (!overlapsDifference(item, span.start, span.end)) continue;
      if (!missing && item.missing) return data;
      first ??= at;
      last = at;
    }
    const makeSelection = (start, queueRange) => {
      const end = start + notice.html.length;
      return { sourceStart: start, sourceEnd: end, selection: true, queueRange,
        comparison: start === span.start ? notice : { ...notice, source: { index, start, end } }, missing };
    };
    first ??= lowerBound(data.items, span.start, item => item.sourceStart);
    const result = { ...data, selection: makeSelection(span.start, [first, last ?? first]) };
    const group = first === last && [...notice.html].length === 1 && reviewLists.get(data.items[first]);
    const selectedItems = [result.selection];
    if (last !== undefined) for (const start of matchingChanges(index.raw, text, notice, span.start,
      group && (anchor => reviewLists.get(anchor) === group))) selectedItems.push(makeSelection(start));
    this.cacheReview({ index, items: selectedItems.sort((a, b) => a.sourceStart - b.sourceStart) }, { selected: true });
    reviewLists.set(notice, result);
    return result;
  }
  pattern(value, index = this.index) {
    const { sourceStart: start, sourceEnd: end, font, comparison, selection, pdfSource, text } = value;
    // Unknown or foreign source context may only match the candidate itself.
    if (value.missing || !index || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < start || end > index.raw.length || pdfSource && pdfSource.index !== index) return value;
    wordBefore.lastIndex = start;
    const prefix = wordBefore.exec(index.raw.slice(0, start))?.[1] || '';
    const suffix = wordAfter.exec(index.raw.slice(end))?.[0] || '';
    const before = start - prefix.length, after = end + suffix.length;
    if (!font && value.options?.[0]) {
      const start = index.starts[before] ?? index.source.length;
      value.options[0].range = { start, end: after > before ? index.ends[after - 1] : start };
    }
    if ([...index.raw.slice(before, after)].length < 2 && [...(prefix + (comparison?.pdf ?? text ?? '') + suffix)].length < 2) return value;
    const change = font ? [text, ...fontKeys.flatMap(key => [value.htmlFont[key], font[key]])] : [comparison?.html, comparison?.pdf];
    const contextual = selection && window.PdfSelectionDiff.comparisonIndex(comparison).parts.some(part => !part.changed && part.html.length);
    return JSON.stringify([!!font, !!selection, change, ...(contextual ? [] : [prefix, suffix])]);
  }
  cacheReview(data, { fonts = data.shared ? this.fontStyles : false, edits: makeEdits = true, text = true, targets, connections, selected = false } = {}) {
    const { index, partial, shared } = data, { lowerBound, comparisonIndex } = window.PdfSelectionDiff;
    const items = data.items || (!targets && !connections && shared?.items);
    connections ??= targets ? index.targetConnections(targets) : index.pairs;
    const keys = fonts === true ? fontKeys : fonts || [];
    const fontConnections = index.formats && keys.length && !partial && !selected ? connections : [];
    let candidates = text ? items || index.candidates(targets, connections) : [];
    if (shared) candidates = candidates.map(item => ({ ...item }));
    const absent = fontConnections.length ? candidates.filter(item => item.missing).sort((a, b) => a.sourceStart - b.sourceStart) : [];
    let missingEnd = -Infinity;
    const ends = absent.map(({ sourceEnd }) => missingEnd = Math.max(missingEnd, sourceEnd));
    const byRange = new Map();
    for (const connection of fontConnections) if (index.compare(connection))
      for (const { start, end, font: style } of connection.fontItems) {
        const sourceStart = connection.start + start, sourceEnd = connection.start + end, id = `font:${sourceStart}:${sourceEnd}`;
        if (byRange.has(id) || ends[lowerBound(absent, sourceEnd, item => item.sourceStart) - 1] > sourceStart) continue;
        const htmlFont = index.formats[sourceStart];
        if (!keys.some(key => typeof style[key] === 'boolean' && style[key] !== htmlFont[key])) continue;
        const font = { ...style };
        for (const key of fontKeys) if (!keys.includes(key)) font[key] = null;
        byRange.set(id, { sourceStart, sourceEnd, font, htmlFont });
      }
    // Merge adjacent format changes, or bridge punctuation with the same mismatch.
    const formats = [];
    for (const item of [...byRange.values()].sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      const previous = formats.at(-1), gap = previous && index.raw.slice(previous.sourceEnd, item.sourceStart);
      const joins = previous && item.sourceStart >= previous.sourceEnd && !/[\r\n]/.test(gap)
        && previous.htmlFont.tags === item.htmlFont.tags
        && fontKeys.every(key => previous.font[key] === item.font[key] && previous.htmlFont[key] === item.htmlFont[key])
        && (!gap.trim() || !(/\s/u.test(gap) && /[\p{L}\p{N}]/u.test(gap)) && fontKeys.some(key =>
          typeof previous.font[key] === 'boolean'
          && index.formats.slice(previous.sourceEnd, item.sourceStart).every((style, i) =>
            /\s/u.test(gap[i]) || (style && style[key] !== previous.font[key]))));
      if (joins) previous.sourceEnd = item.sourceEnd;
      else formats.push(item);
      ((joins ? previous : item).formats ||= []).push({ font: item.font, htmlFont: item.htmlFont });
    }
    for (const item of formats) {
      const nearby = candidates[lowerBound(candidates, item.sourceStart, range => range.sourceEnd)];
      item.reviewStart = nearby?.sourceStart <= item.sourceEnd ? nearby.sourceStart : item.sourceStart;
    }
    data.items = candidates.concat(formats);
    if (formats.length) data.items.sort((a, b) => (a.reviewStart ?? a.sourceStart) - (b.reviewStart ?? b.sourceStart) || Number(!!a.font) - Number(!!b.font));
    const groups = new Map(), { reviewLists } = this;
    data.entries = []; data.edits = []; data.plans = [];
    for (const value of data.items) {
      const { sourceStart: start, sourceEnd: end, font, comparison, missing, selection } = value;
      value.id ||= `${font ? 'font:' : ''}${start}:${end}`;
      if (font) value.text = index.raw.slice(start, end);
      const entry = value.pdfSource ||= index.candidateEntry(value);
      const splitGlyph = index.starts?.[start] < index.ends?.[start - 1] || index.starts?.[end] < index.ends?.[end - 1];
      const [option] = value.options ||= font ? [{ id: 'format', edits: makeEdits ? index.fontEdits(start, end, font) : [] }]
        : [{ id: 'pdf', label: '替换', edits: !makeEdits || missing || !selection && splitGlyph ? []
          : !selection ? index.textEdits(start, end, comparison?.pdf)
            : comparisonIndex(comparison).parts.flatMap(part =>
              part.changed ? index.textEdits(start + part.start, start + part.end, part.pdf) : []) }];
      if (font && option) Object.assign(option, { title: `替换格式：${value.text}（${fontSummary(value.formats)}）`,
        range: { start: index.starts[start], end: index.ends[end - 1] } });
      if (this.editorDocument && (font || missing || selection && comparison.html.trim())) value.range ||= this.editorDocument.rangeAt(start, end, true);
      const key = !selected && (partial ? value : this.pattern(value, index));
      if (!missing) data.plans.push(option);
      let group = selected ? data : groups.get(key);
      if (!group) {
        groups.set(key, group = { index, items: [], entries: [], edits: [] });
        reviewLists.set(group.items, group);
      }
      reviewLists.set(value, group);
      if (!selected) { group.items.push(value); group.entries.push(entry); group.edits.push(...option.edits); }
      data.entries.push(entry); data.edits.push(...option.edits);
    }
    reviewLists.set(data.items, data);
    return data;
  }
  editorSourceIndex(documentModel = this.editorDocument) {
    const pdf = this.environment.getPdf?.() || this.pdf;
    const numbers = this.environment.getSourcePages?.(), sourcePageKey = numbers ? `pages:${numbers.join(',')}` : '';
    const { model } = documentModel;
    Object.assign(this, { editorDocument: documentModel, model, pdf });
    const pairs = this.comparisons.get(model) || this.comparisons.set(model, new WeakMap()).get(model);
    let previous = pairs.get(pdf);
    const { source, version } = documentModel.snapshot;
    if (previous?.sourcePageKey !== sourcePageKey) { previous = undefined; this.review = null; }
    if (previous?.source === source && previous.version === version) return this.index = previous;
    const index = this.index = new window.PdfSelectionDiff.PdfConnections(this, documentModel);
    index.sourcePageKey = sourcePageKey;
    pairs.set(pdf, index);
    if (previous) index.connect(null, { previous });
    return index;
  }
  findLocations(pdf, entries, visibleOnly = false, visible) {
    const scope = this.environment.getSourcePages?.(), full = this.getDocumentIndex(pdf, scope);
    visible ??= this.environment.getVisiblePages?.() || [];
    const pageIndexes = visible.map(page => page.index), searchPages = full ? [...visible, full] : visible;
    const hasLayoutBreaks = full?.pages?.some(page => page.breaks?.length), missing = new Map();
    const selections = entries.flatMap(entry => {
      const { index: source, start, end, marked } = entry;
      if (!source) return [entry];
      if (!missing.has(source)) missing.set(source, source.getDifferences(pageIndexes).items.filter(item => item.missing));
      const documentRanges = hasLayoutBreaks ? source.targetConnections(full)
        .filter(range => range.start < end && range.end > start).sort((a, b) => a.start - b.start) : undefined;
      if (!visibleOnly && !marked && !documentRanges?.some(({ targetStart, targetEnd }, i) => {
        const next = documentRanges[i + 1];
        return next && (targetStart > next.targetStart || /\S/u.test(full.raw.slice(targetEnd, next.targetStart)));
      })) return [entry];
      const connections = documentRanges?.length ? documentRanges
        : source.livePairs.filter(({ target }) => target === full || pageIndexes.includes(target));
      if (!connections.length || connections.some(range => range.start <= start && range.end >= end)) return [entry];
      const fragments = [...connections, ...missing.get(source)].flatMap(range => {
        const a = Math.max(start, range.sourceStart ?? range.start), b = Math.min(end, range.sourceEnd ?? range.end);
        return b > a ? [Object.assign(source.entry(a, b, marked), { originalEntry: entry })] : [];
      });
      return fragments.length ? fragments.sort((a, b) => a.start - b.start) : [entry];
    });
    const locations = selections.map(entry => {
      const { index: source, start: from, end: to, marked, text } = entry;
      const absent = this.textEnabled && missing.get(source)?.find(({ sourceStart, sourceEnd }) =>
        from === to ? marked && from >= sourceStart && from <= sourceEnd : from < sourceEnd && to > sourceStart);
      if (absent) {
        const { sourceStart, sourceEnd } = absent;
        const start = from < to ? Math.max(from, sourceStart) : sourceStart;
        const end = from < to ? Math.min(to, sourceEnd) : sourceEnd;
        const span = { index: source, start, end }, difference = { html: source.raw.slice(start, end), pdf: '', missing: absent.missing };
        const mapped = full && source.missingRange(full, sourceStart, sourceEnd);
        const targets = (mapped ? full.pages : visible).flatMap(page => {
          if (mapped && (mapped.start < page.start || mapped.end > page.end || mapped.endBias && mapped.start === page.start)) return [];
          const range = mapped ? { ...mapped, start: mapped.start - page.start, end: mapped.end - page.start }
            : page.index?.raw.trim() && source.missingRange(page.index, sourceStart, sourceEnd);
          return range ? [{ pageNumber: page.number, range, start, end, marked: true, source: span, difference,
            text: mapped ? full.raw.slice(mapped.start, mapped.end) : '',
            ...(mapped && { item: page.parts.find(part => part.end >= mapped.start)?.item }) }] : [];
        });
        return { entry, targets, queries: [], notice: { ...difference, source: span } };
      }
      let hit, index, number;
      // Try the full index last, even if a visible page returned an approximate match.
      for (const page of searchPages) {
        const visiblePage = page !== full, target = visiblePage ? page.index : full;
        if (!target) continue;
        const found = !source ? !visiblePage && !visibleOnly && target.search(entry)
          : !visiblePage && (hit || visibleOnly) ? source.range(target, from, to, false, undefined, true)
            : source.locate(target, entry, false, target.connections.get(source)?.scope, true, { visiblePage });
        if (!found || hit && found.approximate) continue;
        hit = found; index = target;
        if (visiblePage) number = page.number;
        if (!hit.approximate) break;
      }
      if (!hit) return { entry, targets: [], queries: source ? [] : [text] };
      const { raw, layer, parts, pages } = index, { start: pdfStart, end: pdfEnd, approximate, connection } = hit;
      const caret = pdfStart === pdfEnd, counterpart = raw.slice(pdfStart, pdfEnd);
      const difference = entry.difference || (approximate || text !== counterpart ? { html: text, pdf: counterpart } : null);
      const span = source && { index: source, start: from, end: to };
      const targets = (pages || [{ number, start: 0, end: raw.length, parts }]).flatMap(page => {
        if (!(caret ? pdfStart >= page.start && pdfStart <= page.end : pdfStart < page.end && pdfEnd > page.start)) return [];
        const { start, end, text, before, after } = index.entry(Math.max(pdfStart, page.start), Math.min(pdfEnd, page.end), marked, undefined, page);
        const sourceRange = marked || from === to ? entry : source?.range(index, start, end, true, connection);
        return [{ pageNumber: page.number, item: page.parts.find(part => part.end > start)?.item,
          difference, layer, range: layer && { start, end }, marked, text, before, after,
          ...(difference && span && { source: span }),
          ...((sourceRange || caret) && { index: source, start: sourceRange?.start ?? from, end: sourceRange?.end ?? to }) }];
      });
      return { entry, targets, approximate, notice: marked && difference && { ...difference, source: span } };
    });
    if (visibleOnly || full || locations.every(({ targets, approximate }) => targets.length && !approximate)) return locations;
    return this.indexDocument(pdf, scope).then(index => index ? this.findLocations(pdf, entries) : locations);
  }
  reviewAnchor(item) {
    const entry = item?.pdfSource;
    return entry && this.reviewAnchors([entry]).get(entry) || null;
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
      for (const number of numbers || Array.from({ length: pdf.numPages }, (_, i) => i + 1)) {
        if (!this.environment.isCurrent(pdf)) return null;
        await this.environment.waitForIdle(pdf);
        if (!this.environment.isCurrent(pdf)) return null;
        const page = await pdf.getPage(number), ordinary = await readPageText(page);
        if (!this.environment.isCurrent(pdf)) return null;
        const columns = source && pageData(page).columnText();
        let content = ordinary;
        if (columns) {
          const limit = Math.min(significantText(source.raw).length, significantText(ordinary.raw).length);
          let best = 0;
          for (const layout of [ordinary, columns]) {
            if (best >= limit) break;
            const target = new PdfConnections(source, { ...layout, sourcePages: [number] });
            source.connect(target);
            const matched = [];
            for (const connection of source.targetConnections(target))
              for (const part of source.compare(connection, undefined, { textOnly: true })?.parts || [])
                if (!part.changed) matched.push([connection.start + part.start, connection.start + part.end]);
            let score = 0, edge = 0;
            for (const [start, end] of matched.sort((a, b) => a[0] - b[0])) {
              if (end <= edge) continue;
              score += source.raw.slice(Math.max(edge, start), end).replace(/[\s\-\u00ad\u2010\u2011]/gu, '').length;
              edge = end;
            }
            if (score > best) { best = score; content = layout; }
          }
        }
        const start = index.raw.length, end = start + content.raw.length;
        index.pages.push({ number, start, end, horizontal: content.horizontal,
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
      if (this.environment.isCurrent(pdf)) this.environment.onIndexed?.();
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
    source?.connect();
    const ranges = source?.pairs.filter(connection => connection.target === index);
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
  const model = editor?.getModel(), readerHost = listeningWindow?.ReplacementReview, { fontStyles, textEnabled } = locator;
  const destination = side === 'pdf' || reviewIds.some(id => readerHost?.isOpenFor(id, editor)) ? readerHost
    : editor?.getDomNode()?.ownerDocument.defaultView.ReplacementReview || readerHost;
  if (destination !== host || dismissed?.editor === editor && dismissed.model === model && dismissed.version === model?.getVersionId?.()
    && dismissed.range === editor?.getSelection()?.toString() && dismissed.interaction === interactionId) return;
  if (pdf !== viewer()?.pdfDocument || data.model && data.model !== model || !textEnabled && !fontStyles.length) return;
  const changed = candidateId && kind !== 'font' ? notices[0] : notices.find(value =>
    typeof value.html === 'string' && typeof value.pdf === 'string'
    && (!value.source || value.source.index.raw.slice(value.source.start, value.source.end) === value.html)
    && window.PdfSelectionDiff.comparisonIndex(value).parts.some(part => value.selection === true ? part.changed : part.inconsistent));
  const notice = changed || notices.find(value => value.source), source = notice?.source, hasSource = source && model;
  if (changed ? !textEnabled : !hasSource) return;
  const request = { ...data, notice, kind: changed ? kind : 'font' }, selectedRange = editor?.getSelection?.()?.toString();
  const { items, selection: selected } = hasSource ? await locator.reviewItems({ ...data, request,
    source: source.index.source, version: source.index.version }) : { items: [] };
  if (editor?.getModel() !== model || editor?.getSelection?.()?.toString() !== selectedRange) return;
  const item = candidateId ? items.find(item => item.id === candidateId) : request.kind !== 'font' ? selected
    : items.find(item => item.font && item.sourceStart < source.end && item.sourceEnd > source.start);
  if (hasSource && !item) return;
  if (item) request.focusId = item.id;
  dismissed = null;
  if (nativeEditor && side === 'html') return item && host.showHover(review,
    { editor, model, documentModel: editor.document, snapshot: editor.document.snapshot }, item, items, source);
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
  const { documentModel } = state.context, edits = item?.options[0].edits || [], data = locator.reviewLists.get(state.items);
  const message = item?.missing ? 'PDF OCR 缺少相关文字。' : item?.font ? fontSummary(item.formats || [item])
    : item ? '文字不一致' : state.items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。';
  return { message, edits: locator.reviewLists.get(item)?.edits, allEdits: data?.edits, all: data?.partial ? false : undefined,
    comparison: item?.font ? ['htmlFont', 'font'].map((field, i) => ({ label: i ? 'PDF' : 'HTML', parts: [{ text: fontSummary(item.formats, field) }] }))
      : comparisonRows(item?.comparison, !item?.selection, item?.missing, item?.selection),
    previewDecorations: item?.font || item?.missing ? item.previewDecorations ||= (data?.index || item.pdfSource?.index || locator.index).sourceSegments(item.sourceStart, item.sourceEnd, true).map(segment => ({
      range: documentModel.rangeAt(segment.start, segment.end), options: { inlineClassName: item.missing ? 'mew-review-proposed' : 'mew-review-format', stickiness: 1 }
    })) : [],
    apply: !!edits.length,
    range: item?.range || (edits.length ? documentModel.rangeAt(Math.min(...edits.map(edit => edit.start)), Math.max(...edits.map(edit => edit.end))) : null),
    options: [], applyLabel: item?.font ? '替换格式' : '替换', advance: false, expanded: false };
}
function apply({ item, items, position, context }, all) {
  const { editor, documentModel, source } = context;
  const data = locator.reviewLists.get(items), index = data?.index || locator.index;
  const offset = index.starts[item.sourceStart] ?? source.length;
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
    const { index, start, end } = part.source, owner = index.document.defaultView;
    context.editor.setSelection(context.documentModel.rangeAt(start, end, true));
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
  const { model, documentModel } = context, data = locator.reviewItems(), owner = editor.getDomNode()?.ownerDocument.defaultView;
  const controller = nativeEditor ? editor : owner.mewWorkbench || owner.readerMonaco;
  host.bindSuggestions(editor, currentModel => editor === selection()?.editor && locator.prepareReview({ editor, model: currentModel })
    ? locator.reviewItems().plans : []);
  const id = 'mew.pdf-difference';
  if (editor.addAction && !editor.getAction(id)) {
    const action = editor.addAction({
      id, label: '查看 PDF 差异',
      async run(_, request) {
        const context = { editor, version: request.version };
        if (!locator.prepareReview(context) || context.model.uri.toString() !== request.model) return;
        const { model, pdf } = context, noticeData = request.selection;
        const { items, selection: selected } = locator.reviewItems({ request: noticeData && { notice: { ...noticeData,
          source: { index: locator.index, start: noticeData.start, end: noticeData.end } } } });
        const item = selected || items.find(item => item.id === request.id);
        if (!item) return;
        if (request.save) {
          const position = selected?.queueRange[0] ?? items.indexOf(item);
          await apply({ item, items, position, context: { ...context, source: model.getValue() } }, false).apply?.();
          return controller.save({ followPdf: false, model });
        }
        const reader = readerWindow() || window, notice = { ...item.comparison, missing: item.missing, source: item.pdfSource };
        reader.dispatchEvent(new reader.CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf, notices: [notice],
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
    : item => sourceHover(item, model, editorId && `${editorId}:${id}`);
  highlights.updateSource(editor, [index, highlighted, data, model],
    () => highlighted || nativeEditor
      ? sourceDecorations(index, data.items, locator.fontStyles, locator.textEnabled, hover, documentModel, !!highlighted) : []);
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
    textItemBaseline: pdfTextBaseline, fontStyle: pdfFontStyle, sourceDecorations, sourceHover, fontSummary, comparisonRows, readPageText, readPageFonts, layerFonts,
    setFontEnabled(value, key, persist = true) {
      locator.fontStyles = fontKeys.filter(name => !key || name === key ? value : locator.fontStyles.includes(name));
      if (persist) for (const style of key ? [key] : fontKeys)
        selection()?.savePreference(`${style}Detection`, !!value, '无法保存字体探测设置');
      for (const id of reviewIds) host.invalidate(id);
      selection()?.clearReviewPointer();
      selection()?.refresh();
    }
  };
  const unregister = [
    ['text', 'pdf-ocr', 'PDF 文字差异审阅'],
    ['italic', 'pdf-font', 'PDF 斜体探测'],
    ['bold', 'pdf-bold', 'PDF 粗体探测']
  ].map(([key, id, label]) => host.register({
    ...review, get locator() { bind(); return locator; }, id, label,
    isEnabled: () => key === 'text' ? locator.textEnabled : locator.fontStyles.includes(key),
    setEnabled(value) {
      if (key !== 'text') return (readerWindow()?.PdfReviewProvider || window.PdfReviewProvider).setFontEnabled(value, key);
      locator.textEnabled = value;
      selection()?.savePreference('textDetection', value, '无法保存文字差异设置');
      try { localStorage.setItem('mew.pdf-review.enabled', String(value)); } catch { }
      for (const id of ['pdf-font', 'pdf-bold']) host.invalidate(id);
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
