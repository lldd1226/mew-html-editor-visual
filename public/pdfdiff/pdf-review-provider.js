'use strict';
// Source/PDF mapping and candidate generation.
const nativeEditor = !!window.PdfSelectionOptions?.nativeEditor;
const pages = new WeakMap(), fontKeys = ['italic', 'bold'], reviewIds = ['pdf-ocr', 'pdf-font', 'pdf-bold'];
const wordBefore = /(?<=([\p{L}\p{M}\p{N}_'’-]+))/uy, wordAfter = /^[\p{L}\p{M}\p{N}_'’-]+/u;
const escapeComparison = text => JSON.stringify(text.trim() ? text : '').replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');

function sourceDecorations(index, items = [], fonts = true, text = true, hover, documentModel, highlighted = true) {
  return items.flatMap(item => {
    if (!(item.font ? fonts : text)) return [];
    const font = !item.comparison, start = !font && !item.comparison.html.trim() && /^\s/u.test(item.comparison.pdf) ? item.sourceEnd : item.sourceStart;
    const hoverMessage = hover?.(item);
    const edits = !font && !item.selection && start === item.sourceStart && item.options?.[0]?.edits;
    const segments = edits?.length && (item.comparison.html.trim() || item.comparison.pdf.trim()) ? edits : index.sourceSegments(start, item.sourceEnd, font);
    const collapsed = !font && segments.every(segment => segment.start === segment.end);
    const options = { description: font ? 'PDF font difference' : 'PDF OCR text difference', stickiness: 1, hoverMessage,
      inlineClassName: !highlighted ? '' : collapsed ? undefined : font ? 'mew-font-diff-text' : 'mew-ocr-diff-text' };
    if (collapsed) options.showIfCollapsed = true;
    if (!highlighted) options.before = undefined;
    else if (collapsed) options.before = { content: '\u200b', inlineClassName: 'mew-ocr-diff-insert', inlineClassNameAffectsLetterSpacing: true };
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
  const text = (font, side) => item.font ? fontSummary(item.formats, font) : escapeComparison(item.comparison[side]);
  const pdf = command ? link('PDF:', request) : 'PDF:';
  const save = command && !item.missing ? `\n\n${link('替换&保存', { ...request, save: true })}` : '';
  return { value: (item.missing ? `${pdf} PDF OCR 缺少相关文字。` : `HTML: ${text('htmlFont', 'html')}\n\n${pdf} ${text('font', 'pdf')}`) + save,
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
  const change = full ? 'changed' : 'inconsistent', key = Number(compact) + 2 * !!missing + 4 * !!full;
  const diff = window.PdfSelectionDiff.comparisonIndex(value), rows = diff.rows ||= [];
  let { parts } = diff;
  // Expanded rows carry live source indices and offsets; only compact rows are reusable.
  if (compact && rows[key]) return rows[key];
  const first = compact ? parts.findIndex(part => part[change]) : -1;
  if (first >= 0) {
    const last = parts.findLastIndex(part => part[change]), { start } = parts[first], { end } = parts[last];
    const prefix = (start > 45 ? '…' : '') + value.html.slice(Math.max(0, start - 45), start);
    const suffix = value.html.slice(end, end + 45) + (value.html.length - end > 45 ? '…' : '');
    parts = parts.slice(first, last + 1);
    if (prefix) parts.unshift({ html: prefix, pdf: prefix, changed: false });
    if (suffix) parts.push({ html: suffix, pdf: suffix, changed: false });
  }
  const sides = missing && !value.pdf.trim() ? ['html'] : ['html', 'pdf'], source = !compact && value.source;
  return rows[key] = sides.map(side => ({ label: side.toUpperCase(), parts: parts.map(part => {
    const changed = !!part[change], text = part[side];
    return { ...part, changed: changed && !missing,
      text: changed && !text.trim() && part[side === 'html' ? 'pdf' : 'html'].trim() ? '' : text,
      source: source ? { index: source.index, start: source.start + part.start, end: source.start + part.end } : undefined };
  }) }));
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
      if (str?.length) items.push({ item, height, x: item.transform[4], end: item.transform[4] + width,
        y: window.PdfSelectionDiff.pdfTextBaseline(item), text: str.trim(), wide: width >= height * 4, word: /\p{L}{2}/u.test(str) });
    }
    const sorted = [...items].sort((a, b) => Math.round((b.y - a.y) / Math.max(a.height, b.height)) || a.x - b.x);
    const misaligned = sorted.some((row, i) => i && row.x < sorted[i - 1].x
      && Math.abs(row.y - sorted[i - 1].y) <= Math.max(row.height, sorted[i - 1].height) * .75);
    let raw = '', previous, line;
    const parts = [], breaks = [], passages = columnPassages(misaligned ? items : sorted);
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
    return Object.assign(content, { raw, parts, breaks, horizontal: passages.length > 1 });
  }).catch(error => { delete data.text; throw error; });
}
function readPageFonts(page) {
  const data = pageData(page);
  return data.fonts ||= (async () => {
    const { parts } = await readPageText(page);
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
        style = window.PdfSelectionDiff.pdfFontStyle(id && page.commonObjs?.has(id) ? page.commonObjs.get(id) : null, id || '');
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
  })().catch(error => { delete data.fonts; throw error; });
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
  const data = cached?.layer, items = data?.items || [];
  const names = new Map();
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
    const { source, signal, onProgress, priority } = context;
    if (source === undefined ? selection()?.selectionEnabled === false : !this.prepareReview(context)) return { items: [] };
    if (source === undefined) this.editorSourceIndex(context.editor?.document);
    const { index, model, pdf, fontStyles, review } = this;
    const notice = context.request?.candidateId ? null : context.request?.notice;
    const fontKey = fontStyles.join(','), { changedRange, lowerBound } = window.PdfSelectionDiff;
    const reusable = review?.model === model && review.enabled === this.textEnabled && review.fontKey === fontKey;
    const previous = review?.index, items = [];
    if (onProgress && priority && reusable && previous !== index && previous?.prepared?.pdf === pdf && previous.fontsCurrent) {
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
    }
    if (items.length) {
      const partial = this.cacheReview({ index, model, enabled: this.textEnabled, fontKey, items, shared: review.shared, partial: true });
      return Promise.resolve(context.onProgress(partial)).then(accepted => accepted !== false && this.prepareReview(context)
        ? this.reviewItems({ ...context, priority: undefined, onProgress: undefined }) : { items: [] });
    }
    if (source !== undefined && notice?.source?.index !== index) {
      const version = context.version ?? model.getVersionId?.(), pages = this.environment.getSourcePages?.();
      return (fontStyles.length ? this.indexFonts(pdf, index, signal, pages) : this.indexDocument(pdf, pages)).then(full =>
        full && source === model.getValue() && this.prepareReview({ ...context, source: undefined, version }) && this.index === index
          ? this.reviewItems({ ...context, source: undefined }) : { items: [] });
    }
    const shared = index.getDifferences();
    const data = reusable && review.shared === shared ? review : this.review = this.cacheReview({
      index, model, enabled: this.textEnabled, fontKey, shared, partial: false,
      items: index.formatDifferences(this.textEnabled ? shared.items : shared.items.filter(item => item.font), fontStyles) });
    const { reviewLists } = this, selected = reviewLists.get(notice);
    if (selected?.items === data.items && selected.index === index) return selected;
    const span = this.textEnabled && notice?.source?.index === index && notice.source;
    if (!span || index.raw.slice(span.start, span.end) !== notice.html) return data;
    const overlaps = (item, start, end) => item.sourceStart <= end && item.sourceEnd >= start
      && (item.sourceEnd > start || item.sourceStart === start) && (item.sourceStart < end || item.sourceEnd === end);
    const changes = notice.missing ? [] : window.PdfSelectionDiff.comparisonIndex(notice).parts.filter(part => part.changed), [change] = changes;
    if (!notice.missing && !change) return data;
    let first, last;
    const text = [];
    for (const [at, item] of data.items.entries()) {
      if (item.font) continue;
      if (change) text.push(item);
      if (!overlaps(item, span.start, span.end)) continue;
      if (change && item.missing) return data;
      first ??= at;
      last = at;
    }
    const makeSelection = (start, queueRange) => {
      const end = start + notice.html.length;
      return { id: `${start}:${end}`, sourceStart: start, sourceEnd: end, selection: true, queueRange,
        comparison: start === span.start ? notice : { ...notice, source: { index, start, end } },
        missing: notice.missing, range: this.editorDocument.rangeAt(start, end, true), pdfSource: index.entry(start, end, true),
        options: [{ id: 'pdf', label: '替换', edits: changes.flatMap(part => index.textEdits(start + part.start, start + part.end, part.pdf)) }] };
    };
    const selectedAt = first ?? lowerBound(data.items, span.start, item => item.sourceStart);
    const selectionItem = makeSelection(span.start, [selectedAt, last ?? selectedAt]);
    const matching = first !== undefined && first === last && [...notice.html].length === 1 && reviewLists.get(data.items[first]);
    const group = { index, items: [selectionItem], entries: [selectionItem.pdfSource], edits: [...selectionItem.options[0].edits] };
    // Match selected context against cached faults without rebuilding the queue.
    for (const anchor of first === undefined ? [] : text) {
      if (anchor.missing) continue;
      offsets: for (let offset = anchor.comparison.html.indexOf(change.html); offset >= 0;
        offset = change.html ? anchor.comparison.html.indexOf(change.html, offset + 1) : -1) {
        const start = anchor.sourceStart + offset - change.start, end = start + notice.html.length;
        if (start === span.start || start < 0 || index.raw.slice(start, end) !== notice.html
          || matching && reviewLists.get(anchor) !== matching) continue;
        let matched = 0;
        const stop = lowerBound(text, end + 1, item => item.sourceStart);
        for (let at = lowerBound(text, start, item => item.sourceEnd); at < stop; at++) {
          const { comparison, sourceStart, missing } = text[at];
          if (!overlaps(text[at], start, end)) continue;
          if (missing) continue offsets;
          for (const part of window.PdfSelectionDiff.comparisonIndex(comparison).parts) {
            if (!(comparison.selection === true ? part.changed : part.inconsistent)) continue;
            const from = sourceStart + part.start, a = Math.max(start, from), b = Math.min(end, sourceStart + part.end);
            if (a > b) continue;
            const expected = changes[matched++], left = a - from, right = b - from;
            if (!expected || expected.start !== a - start || expected.end !== b - start || expected.html !== part.html.slice(left, right)) continue offsets;
            if (expected.pdf !== (left === 0 && right === part.html.length ? part.pdf
              : part.html.length === part.pdf.length ? part.pdf.slice(left, right) : null)) continue offsets;
          }
        }
        if (matched !== changes.length) continue;
        const item = makeSelection(start), at = lowerBound(group.items, start, item => item.sourceStart);
        group.items.splice(at, 0, item); group.entries.splice(at, 0, item.pdfSource); group.edits.push(...item.options[0].edits);
      }
    }
    const result = { ...data, selection: selectionItem };
    reviewLists.set(selectionItem, group).set(group.items, group).set(notice, result);
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
  cacheReview(data) {
    const { index, items, partial } = data, groups = new Map(), { reviewLists } = this;
    const entries = data.entries = [], edits = data.edits = [], plans = data.plans = [];
    for (const value of items) {
      if (value.font || value.missing || value.selection && value.comparison.html.trim()) value.range ||= this.editorDocument.rangeAt(value.sourceStart, value.sourceEnd, true);
      const entry = value.pdfSource ||= index.candidateEntry(value), key = partial ? value : this.pattern(value, index), option = value.options[0];
      if (value.font) {
        option.title = `替换格式：${value.text}（${fontSummary(value.formats)}）`;
        option.range = { start: index.starts[value.sourceStart], end: index.ends[value.sourceEnd - 1] };
      }
      if (!value.missing) plans.push(option);
      let group = groups.get(key);
      if (!group) {
        groups.set(key, group = { index, items: [], entries: [], edits: [] });
        reviewLists.set(group.items, group);
      }
      reviewLists.set(value, group);
      group.items.push(value); group.entries.push(entry); group.edits.push(...option.edits);
      entries.push(entry); edits.push(...option.edits);
    }
    reviewLists.set(items, data);
    return data;
  }
  editorSourceIndex(documentModel = this.editorDocument) {
    const pdf = this.environment.getPdf?.() || this.pdf;
    const numbers = this.environment.getSourcePages?.(), sourcePageKey = numbers ? `pages:${numbers.join(',')}` : '';
    const { model } = documentModel;
    Object.assign(this, { editorDocument: documentModel, model, pdf });
    let pairs = this.comparisons.get(model);
    if (!pairs) this.comparisons.set(model, pairs = new WeakMap());
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
  reviewAnchor(item) {
    if (!item?.pdfSource) return null;
    const { index: source, start, end } = item.pdfSource;
    for (const { index } of this.environment.getVisiblePages?.() || []) {
      if (!index?.layer?.isConnected) continue;
      const hit = item.missing ? source.missingRange(index, start, end) : source.range(index, start, end, false, undefined, true);
      if (!hit) continue;
      const div = index.layer.closest('.page') || index.layer;
      const box = highlights.measureHighlights(div, index, [hit], hit).notices[0]?.box;
      if (!box) continue;
      const page = div.getBoundingClientRect(), sx = page.width / div.offsetWidth, sy = page.height / div.offsetHeight;
      const top = page.top + div.clientTop * sy;
      return { top: top + box.y * div.clientHeight * sy, bottom: top + (box.y + box.h) * div.clientHeight * sy,
        left: page.left + div.clientLeft * sx + box.x * div.clientWidth * sx + (box.caret ? 2 : 0) };
    }
    return null;
  }
  async indexDocument(pdf, numbers) {
    numbers = numbers ? [...numbers] : undefined;
    const documents = this.documents.get(pdf) || this.documents.set(pdf, new Map()).get(pdf);
    const key = numbers ? `pages:${numbers.join(',')}` : '', task = documents.get(key)?.task;
    if (task) return task;
    const { PdfConnections, normalized } = window.PdfSelectionDiff;
    const index = new PdfConnections(this, { pdf, sourcePages: numbers, raw: '', pages: [], normalized: null });
    documents.set(key, index);
    return index.task = Promise.resolve().then(async () => {
      let mappedStart = 0;
      const mapped = { text: '', starts: [], ends: [] };
      for (const number of numbers || Array.from({ length: pdf.numPages }, (_, i) => i + 1)) {
        if (!this.environment.isCurrent(pdf)) return null;
        await this.environment.waitForIdle(pdf);
        if (!this.environment.isCurrent(pdf)) return null;
        const content = await readPageText(await pdf.getPage(number));
        if (!this.environment.isCurrent(pdf)) return null;
        const start = index.raw.length, end = start + content.raw.length;
        index.pages.push({ number, start, end, horizontal: content.horizontal,
          parts: content.parts.map(part => ({ ...part, start: start + part.start, end: start + part.end })),
          breaks: content.breaks.map(at => start + at) });
        index.raw += content.raw + '\n';
        const segment = index.raw.slice(mappedStart);
        if (/[-\u2010\u2011]\s*$/.test(segment)) continue;
        normalized(segment, mapped, mappedStart);
        mappedStart = index.raw.length;
      }
      normalized(index.raw.slice(mappedStart), mapped, mappedStart);
      index.normalized = mapped;
      if (this.environment.isCurrent(pdf)) this.environment.onIndexed?.();
      return index;
    }).then(result => result || discard(), error => { discard(); throw error; });
    function discard() {
      if (documents.get(key) === index) documents.delete(key);
      return null;
    }
  }
  getDocumentIndex(pdf, numbers) { return window.PdfSelectionDiff.documentIndex(this.documents, pdf, numbers); }
  async indexFonts(pdf, source, signal, numbers) {
    const index = await this.indexDocument(pdf, numbers);
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
  const request = { ...data, notice, kind: changed ? kind : 'font' };
  const selectedRange = editor?.getSelection?.()?.toString();
  const prepared = hasSource ? await locator.reviewItems({ ...data, request,
    source: source.index.source, version: source.index.version }) : { items: [] };
  if (editor?.getModel() !== model || editor?.getSelection?.()?.toString() !== selectedRange) return;
  const item = candidateId ? prepared.items.find(item => item.id === candidateId)
    : request.kind === 'font' ? prepared.items.find(item => item.font && item.sourceStart < source.end && item.sourceEnd > source.start) : prepared.selection;
  if (hasSource && !item) return;
  if (item) request.focusId = item.id;
  dismissed = null;
  if (nativeEditor && side === 'html')
    return item && host.showHover(review, { editor, model, documentModel: editor.document, snapshot: editor.document.snapshot }, item, prepared.items, source);
  if (!hasSource) return host.showNotice({
    title: 'PDF 文字差异', message: '文字不一致', comparison: comparisonRows(notice, false, notice.missing, true), anchor: data.anchor,
    layout: presentation({ editor, request })
  });
  return host.openForSelection(locator.textEnabled ? 'pdf-ocr' : fontStyles.includes('italic') ? 'pdf-font' : 'pdf-bold', editor, request.focusId, request);
}
function presentation(context, item) {
  const reader = readerWindow() || window, source = context.editor?.getDomNode()?.ownerDocument.defaultView || window;
  const split = source !== reader, side = split ? context.request?.side || 'html' : 'pdf';
  const { anchor: fallback, anchorElement: element, anchorBox: box, notice } = context.request || {};
  // Prefer the measured click range when opening at an inline-tag boundary.
  const pdf = side === 'pdf', destination = pdf ? reader : source, { container, eventBus } = viewer() || {};
  const rect = pdf && box && element?.isConnected && element.getBoundingClientRect();
  const requested = (!item || item.sourceStart === notice?.source?.start) && (rect
    ? { left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height, bottom: rect.top + (box.y + box.h) * rect.height }
    : fallback);
  const anchor = pdf ? requested || (item && locator.reviewAnchor(item)) : null;
  const related = pdf && context.snapshot === context.documentModel?.snapshot ? locator.reviewLists.get(item)?.items || [] : [];
  return { side, switchable: split, switchLabel: pdf ? '查看HTML' : '查看PDF', host: destination.ReplacementReview, window: destination,
    container, eventBus, anchor, highlights: [anchor, ...related.map(value => value !== item && locator.reviewAnchor(value))].filter(Boolean) };
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
  const selected = all ? items : locator.reviewLists.get(item)?.items || [], candidates = new Set(selected);
  let next = items.length, first = -1, last = -1;
  for (const [at, candidate] of items.entries()) {
    if (!all && item.font && candidate.font && !candidates.has(candidate)
      && selected.some(value => value.font && candidate.sourceStart < value.sourceEnd && candidate.sourceEnd > value.sourceStart))
      candidates.add(candidate);
    if (candidates.has(candidate)) {
      if (first < 0) first = at;
      last = at;
    } else if (at > position && next === items.length) next = at;
  }
  const edits = documentModel.validateEdits((candidates.size === selected.length && locator.reviewLists.get(selected)?.edits)
    || [...candidates].flatMap(value => value.options[0].edits));
  return { position: next, priority: last - first + 1 === candidates.size,
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
    textItemBaseline: window.PdfSelectionDiff.pdfTextBaseline, fontStyle: window.PdfSelectionDiff.pdfFontStyle, sourceDecorations, sourceHover, fontSummary, comparisonRows, readPageText, readPageFonts, layerFonts,
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
  ].map(([key, id, label]) => ({
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
  })).concat([
    ['pdf-selection', 'PDF 差异高亮', 'enabled', value => selection()?.setDiffHighlight(value), true],
    ['source-diff', '源码差异高亮', 'sourceEnabled', value => selection()?.setDiffHighlight(value, 'source'), true],
    ['pdf-selection-sync', 'PDF 与源码选区联动', 'selectionEnabled', value => selection()?.setSelectionHighlight(value)]
  ].map(([id, label, setting, setEnabled, toggleOnly]) => ({
    id, label, toggleOnly, setEnabled, isEnabled: () => selection()?.[setting] === true,
    available: () => { const api = selection(); return !!api && (setting === 'selectionEnabled' || api.selectionEnabled); }
  }))).map(provider => host.register(provider));
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
