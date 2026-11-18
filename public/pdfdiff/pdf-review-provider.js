// PDF mapping, review candidates, provider actions and highlights.
'use strict';
const nativeEditor = !!window.PdfSelectionOptions?.nativeEditor;
// Source/PDF mapping and candidate generation.
const pages = new WeakMap(), fontKeys = ['italic', 'bold'], reviewIds = ['pdf-ocr', 'pdf-font', 'pdf-bold'];
const wordCharacter = /^[\p{L}\p{M}\p{N}_'’\-]+$/u;
const escapeComparison = text => JSON.stringify(text.trim() ? text : '').replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');

function sourceDecorations(index, items = [], fonts = true, text = true, hover, documentModel) {
  return items.filter(item => item.font ? fonts : text).flatMap(item => {
    const font = !item.comparison, start = !font && !item.comparison.html.trim() && /^\s/u.test(item.comparison.pdf) ? item.sourceEnd : item.sourceStart;
    const options = { description: font ? 'PDF font difference' : 'PDF OCR text difference', stickiness: 1,
      inlineClassName: font ? 'mew-font-diff-text' : 'mew-ocr-diff-text', hoverMessage: hover?.(item) };
    const segments = index.sourceSegments(start, item.sourceEnd, font);
    if (!font && (!segments.length || segments.every(segment => segment.start === segment.end))) {
      if (!segments.length) segments.push(...index.sourceSegments(start, start));
      Object.assign(options, { inlineClassName: undefined, showIfCollapsed: true,
        before: { content: '\u200b', inlineClassName: 'mew-ocr-diff-insert', inlineClassNameAffectsLetterSpacing: true } });
    }
    return segments.map(({ start, end }) => ({ range: documentModel.rangeAt(start, end), options, reviewItem: item }));
  }).sort(({ range: a }, { range: b }) => documentModel.model.getOffsetAt({ lineNumber: a.endLineNumber, column: a.endColumn })
    - documentModel.model.getOffsetAt({ lineNumber: a.startLineNumber, column: a.startColumn })
    - (documentModel.model.getOffsetAt({ lineNumber: b.endLineNumber, column: b.endColumn })
      - documentModel.model.getOffsetAt({ lineNumber: b.startLineNumber, column: b.startColumn })));
}
function sourceHover(item, model, command) {
  const request = { model: model.uri?.toString(), version: model.getVersionId?.(), id: item.id };
  const pdf = command ? `[PDF:](command:${command}?${encodeURIComponent(JSON.stringify([request]))})` : 'PDF:';
  const htmlText = item.font ? fontSummary(item.formats, 'htmlFont') : escapeComparison(item.comparison.html);
  const pdfText = item.font ? fontSummary(item.formats, 'font') : escapeComparison(item.comparison.pdf);
  const save = command && !item.missing ? `\n\n[替换&保存](command:${command}?${encodeURIComponent(JSON.stringify([{ ...request, save: true }]))})` : '';
  return { value: (item.missing ? `${pdf} PDF OCR 缺少相关文字。` : `HTML: ${htmlText}\n\n${pdf} ${pdfText}`) + save,
    isTrusted: command ? { enabledCommands: [command] } : false };
}
function fontSummary(runs, field) {
  const states = [['italic', '斜体', new Set()], ['bold', '粗体', new Set()]], reasons = new Set();
  for (const value of runs) for (const [key, label, values] of states) {
    const run = value[field || 'font'];
    if (field) { values.add(run[key]); if (run.reason) reasons.add(run.reason); }
    else if (typeof run[key] === 'boolean' && run[key] !== value.htmlFont[key])
      values.add(`${label}不一致（HTML ${value.htmlFont[key] ? '是' : '否'} / PDF ${run[key] ? '是' : '否'}${key === 'bold' && run.scanBoldRatio ? '，扫描估计' : ''}）`);
  }
  return states.map(([, label, values]) => field ? `${label}：${!values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否'}` : [...values].join('；')).filter(Boolean).join('；')
    + (reasons.size ? `（${[...reasons].join('；')}）` : '');
}
function comparisonRows(value, compact = true, missing = value?.missing, full = value?.selection === true) {
  if (typeof value?.html !== 'string' || typeof value?.pdf !== 'string') return [];
  let parts = window.PdfSelectionDiff.comparisonParts(value, full);
  const rows = value.comparisonDiff.rows, key = Number(compact) + 2 * !!missing + 4 * !!full;
  // Expanded rows carry live source indices and offsets; only compact rows are reusable.
  if (compact && rows[key]) return rows[key];
  if (compact) {
    const first = parts.findIndex(part => part.changed), last = parts.findLastIndex(part => part.changed);
    if (first >= 0) {
      // Keep every changed run, including unchanged text between distant edits.
      // Reuse the original character diff rather than computing it again on a crop.
      const before = value.html.slice(0, parts[first].start);
      const prefix = (before.length > 45 ? '…' : '') + before.slice(-45);
      const suffix = value.html.slice(parts[last].end, parts[last].end + 45) + (value.html.length - parts[last].end > 45 ? '…' : '');
      parts = [...(prefix ? [{ html: prefix, pdf: prefix, changed: false }] : []),
      ...parts.slice(first, last + 1), ...(suffix ? [{ html: suffix, pdf: suffix, changed: false }] : [])];
    }
  }
  return rows[key] = (missing && !value.pdf.trim() ? ['html'] : ['html', 'pdf']).map(side => ({
    label: side.toUpperCase(), parts: parts.map(part => {
      const empty = part.changed && !part[side].trim() && !!part[side === 'html' ? 'pdf' : 'html'].trim();
      return { ...part, changed: part.changed && !missing, text: empty ? '' : part[side], source: !compact && value.source
        ? { index: value.source.index, start: value.source.start + part.start, end: value.source.start + part.end } : undefined };
    })
  }));
}
function pageData(page) {
  let data = pages.get(page);
  if (!data) pages.set(page, data = {});
  return data;
}
function readPageText(page) {
  const data = pageData(page);
  return data.text ||= Promise.resolve().then(() => page.getTextContent()).then(content => {
    const items = content.items.filter(item => item.str?.length), sorted = [...items].sort((a, b) =>
      Math.round((window.PdfSelectionDiff.pdfTextBaseline(b) - window.PdfSelectionDiff.pdfTextBaseline(a)) / Math.max(a.height, b.height)) || a.transform[4] - b.transform[4]), misaligned = sorted.some((item, i) =>
        i && item.transform[4] < sorted[i - 1].transform[4] && Math.abs(window.PdfSelectionDiff.pdfTextBaseline(item)
          - window.PdfSelectionDiff.pdfTextBaseline(sorted[i - 1])) <= Math.max(item.height, sorted[i - 1].height) * 0.75), ordered = misaligned ? items : sorted;
    let raw = '', previous, previousBaseline, line;
    const parts = [], breaks = [];
    for (const item of ordered) {
      const baseline = window.PdfSelectionDiff.pdfTextBaseline(item), size = item.height;
      if (previous && !raw.endsWith('\n')) {
        const lineBreak = Math.abs(baseline - previousBaseline) > Math.max(size, previous.height) * (misaligned ? 0.75 : 0.5);
        if (lineBreak) raw += '\n';
        else if (item.transform[4] - previous.transform[4] - previous.width > Math.max(size, previous.height) * 0.08) raw += ' ';
      }
      if (size && /\p{L}{2}/u.test(item.str)) {
        const gap = line && baseline - line.baseline, height = Math.max(line?.size ?? 0, size);
        if (gap < -height * 1.8) {
          const start = raw.lastIndexOf('\n') + 1;
          if (start > (breaks.at(-1) ?? 0)) breaks.push(start);
        }
        if (!line || Math.abs(gap) > height * .6 || size > line.size) line = { baseline, size };
      }
      parts.push({ start: raw.length, end: raw.length + item.str.length, item });
      raw += item.str + (item.hasEOL ? '\n' : '');
      previous = item; previousBaseline = baseline;
    }
    return Object.assign(content, { raw, parts, breaks });
  }).catch(error => {
    delete data.text;
    throw error;
  });
}

function readPageFonts(page) {
  const data = pageData(page);
  return data.fonts ||= (async () => {
    const items = (await readPageText(page)).parts.map(part => part.item);
    const ops = window.pdfjsLib?.OPS || { save: 10, restore: 11, setFont: 37, setTextRenderingMode: 38,
      showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47 };
    const textOps = new Set([ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText]);
    const invisibleFonts = new Set(), stack = [];
    let fontId = null, mode = 0, failed = false;
    try {
      const list = await page.getOperatorList?.();
      for (let i = 0; i < (list?.fnArray.length || 0); i++) {
        const fn = list.fnArray[i], args = list.argsArray[i];
        if (fn === ops.save) stack.push([fontId, mode]);
        else if (fn === ops.restore && stack.length) [fontId, mode] = stack.pop();
        else if (fn === ops.setFont) fontId = args[0];
        else if (fn === ops.setTextRenderingMode) mode = args[0];
        else if (textOps.has(fn)
          && (mode & 3) === 3) invisibleFonts.add(fontId);
      }
    } catch {
      failed = true; /* Text comparison remains available. */
    }
    const fonts = new Map(), textFonts = new Set();
    let letters = 0, boldLetters = 0;
    for (const item of items) {
      let style = fonts.get(item.fontName);
      if (!style) {
        const id = item.fontName, font = id && page.commonObjs?.has(id) ? page.commonObjs.get(id) : null;
        style = window.PdfSelectionDiff.pdfFontStyle(font, id || '');
        if (failed) {
          style.bold = style.italic = null;
          style.reason = '字体读取失败';
        } else if (invisibleFonts.has(id)) {
          // Invisible OCR retains declarations, not scan-derived style evidence.
          style.declaredBold = style.bold;
          style.declaredItalic = style.italic;
          style.reason ||= 'OCR 字体';
        }
        fonts.set(id, style);
      }
      const count = item.str?.replace(/\s/g, '').length || 0;
      if (count) textFonts.add(style);
      letters += count;
      if (style.bold === true) boldLetters += count;
    }
    const dominantBold = letters > 0 && boldLetters / letters >= 0.8;
    for (const key of ['bold', 'italic']) {
      if (!textFonts.size || !(key === 'bold' && dominantBold) && ![...textFonts].every(font => font?.[key] === true)) continue;
      const reason = key === 'bold' && boldLetters < letters ? '大部分文字声明为粗体' : `均为${key === 'bold' ? '粗体' : '斜体'}`;
      for (const font of textFonts) {
        if (font[key] !== true) continue;
        if (key === 'bold') font.declaredBold = true;
        font[key] = null;
        font.reason = font.reason ? `${font.reason}：${reason}` : reason;
      }
    }
    return fonts;
  })().catch(error => { delete data.fonts; throw error; });
}

function layerFonts(view, layer, refresh) {
  const page = view?.pdfPage;
  const cached = page && pageData(page);
  if (page?.getTextContent && !cached.layer) {
    cached.layer = { items: [], fonts: new Map() };
    readPageText(page).then(async content => {
      const items = content.items.filter(item => item.str?.length);
      const fonts = await readPageFonts(page);
      Object.assign(cached.layer, { items, fonts, text: content }); refresh();
    }).catch(() => { delete cached.layer; });
  }
  const data = cached?.layer, items = data?.items || [];
  const spans = (view?._textHighlighter?.textDivs || [...layer.querySelectorAll('span[role="presentation"]')]).filter(span => span.textContent);
  const names = new Map();
  if (spans.length === items.length && spans.every((span, i) => span.textContent === items[i].str))
    spans.forEach((span, i) => names.set(span, items[i]));
  return Object.assign(element => data?.fonts.get(names.get(element)?.fontName), { items: names, text: data?.text });
}

class PdfLocator {
  documents = new WeakMap();
  comparisons = new WeakMap();
  reviewLists = new WeakMap();
  textEnabled = true;
  fontStyles = [...fontKeys];
  constructor(options = {}, environment = {}) {
    this.environment = environment;
    this.options = options;
    this.pdf = environment.getPdf?.() || {};
    this.document = environment.document || window.document;
  }
  prepareReview(context = {}) {
    if (selection()?.selectionEnabled === false) return null;
    const pdf = viewer()?.pdfDocument, editor = selection()?.editor, model = editor?.getModel();
    if (!pdf || !model || context.signal?.aborted || context.pdf && context.pdf !== pdf ||
    context.editor && context.editor !== editor || context.model && context.model !== model || (context.version !== undefined ? context.version !== model.getVersionId() : context.source !== undefined && context.source !== model.getValue()))
      return null;
    Object.assign(context, { pdf, editor, model, documentModel: editor.document, snapshot: editor.document.snapshot });
    return this.editorSourceIndex(editor.document);
  }
  reviewItems(context = {}) {
    if (selection()?.selectionEnabled === false) return { items: [] };
    const fontStyles = this.fontStyles;
    if (context.source !== undefined) { if (!this.prepareReview(context)) return { items: [] }; }
    else this.editorSourceIndex(context.editor?.document);
    const notice = context.request?.candidateId ? null : context.request?.notice;
    const fontKey = fontStyles.join(','), { changedRange, lowerBound } = window.PdfSelectionDiff;
    const reusable = this.review?.model === this.model && this.review.enabled === this.textEnabled && this.review.fontKey === fontKey;
    const previous = this.review?.index, prepared = previous?.prepared;
    let priority = [];
    if (context.onProgress && context.priority && reusable && previous !== this.index && prepared?.pdf === this.pdf
      && previous.fontsCurrent) {
      const raw = changedRange(previous.raw, this.index.raw), source = changedRange(previous.source, this.index.source);
      const delta = raw.newEnd - raw.oldEnd, sourceDelta = source.newEnd - source.oldEnd, suffix = previous.raw !== this.index.raw ? raw.oldEnd : 0;
      for (let at = lowerBound(this.review.items, Math.max(suffix, lowerBound(previous.ends, context.priority.offset - sourceDelta + 1)),
        item => item.reviewStart ?? item.sourceStart); at < this.review.items.length; at++) {
        const item = this.review.items[at], { range, ...option } = item.options[0];
        if (priority.length === 5) break;
        if (item.sourceStart < suffix || previous.starts[item.sourceStart] < source.oldEnd
          || item.sourceStart === item.sourceEnd && item.sourceStart === raw.oldEnd && raw.newEnd > raw.oldEnd
          || option.edits.some(edit => edit.start < source.oldEnd)) continue;
        priority.push({ ...item, id: `${item.font ? 'font:' : ''}${item.sourceStart + delta}:${item.sourceEnd + delta}`,
          sourceStart: item.sourceStart + delta, sourceEnd: item.sourceEnd + delta,
          reviewStart: item.reviewStart === undefined ? undefined : item.reviewStart + delta, pdfSource: undefined, range: undefined, previewDecorations: undefined,
          options: [{ ...option, edits: option.edits.map(edit => ({ ...edit, start: edit.start + sourceDelta, end: edit.end + sourceDelta })) }] });
      }
    }
    let data = { index: this.index, model: this.model, enabled: this.textEnabled, fontKey,
      items: priority, shared: this.review?.shared, partial: !!priority.length };
    if (!data.partial) {
      if (context.source !== undefined && notice?.source?.index !== this.index) {
        const { model, pdf, index } = this, source = context.source, version = context.version ?? model.getVersionId?.();
        const pages = this.environment.getSourcePages?.();
        return (fontStyles.length ? this.indexFonts(pdf, this.index, context.signal, pages) : this.indexDocument(pdf, pages)).then(full => {
          if (!full || source !== model.getValue() || !this.prepareReview({ ...context, source: undefined, version })
            || this.index !== index) return { items: [] };
          return this.reviewItems({ ...context, source: undefined });
        });
      }
      data.shared = this.index.getDifferences();
      if (reusable && this.review.shared === data.shared) data = this.review;
      else {
        data.items = this.textEnabled ? data.shared.items : data.shared.items.filter(item => item.font);
        data.items = this.index.formatDifferences(data.items, fontStyles);
        this.cacheReview(data);
        this.review = data;
      }
    }
    const selected = notice && this.reviewLists.get(notice);
    if (!data.partial && selected?.items === data.items && selected.index === data.index) return selected;
    const source = this.textEnabled && notice?.source?.index === this.index && notice.source;
    if (!data.partial && source && this.index.raw.slice(source.start, source.end) === notice.html) {
      const overlaps = (item, start, end) => !item.font && item.sourceStart <= end && item.sourceEnd >= start
        && (item.sourceEnd > start || item.sourceStart === start) && (item.sourceStart < end || item.sourceEnd === end);
      const changes = notice.missing ? [] : window.PdfSelectionDiff.comparisonParts(notice, true).filter(part => part.changed);
      const covered = data.items.flatMap((item, at) => overlaps(item, source.start, source.end) ? [at] : []);
      if (!notice.missing && (!changes.length || covered.some(at => data.items[at].missing))) return data;
      const makeSelection = (start, queueRange) => ({
        id: `${start}:${start + notice.html.length}`, sourceStart: start, sourceEnd: start + notice.html.length,
        selection: true, queueRange, comparison: start === source.start ? notice : { ...notice, source: { index: this.index, start, end: start + notice.html.length } },
        missing: notice.missing, range: this.editorDocument.rangeAt(start, start + notice.html.length, true),
        pdfSource: this.index.entry(start, start + notice.html.length, true),
        options: [{ id: 'pdf', label: '替换', edits: changes.flatMap(part => this.index.textEdits(start + part.start, start + part.end, part.pdf)) }]
      });
      const selectedAt = covered.length ? 0 : lowerBound(data.items, source.start, item => item.sourceStart);
      const selectedItem = makeSelection(source.start, covered.length ? [covered[0], covered.at(-1)] : [selectedAt, selectedAt]);
      const selectedAnchor = covered.length === 1 ? data.items[covered[0]] : null;
      const selectedPattern = selectedAnchor && [...notice.html].length === 1 ? this.pattern(selectedAnchor, this.index) : null;
      const group = { index: this.index, items: [selectedItem], entries: [selectedItem.pdfSource], edits: [...selectedItem.options[0].edits] };
      const [change] = changes, text = data.items.filter(item => !item.font);
      // Match selected context against cached faults; never rebuild or splice the queue.
      for (const anchor of covered.length && change ? text : []) {
        if (anchor.missing) continue;
        for (let offset = anchor.comparison.html.indexOf(change.html); offset >= 0;
          offset = change.html ? anchor.comparison.html.indexOf(change.html, offset + 1) : -1) {
          const start = anchor.sourceStart + offset - change.start, end = start + notice.html.length;
          if (start === source.start || start < 0 || this.index.raw.slice(start, end) !== notice.html) continue;
          if (selectedPattern && this.pattern(anchor, this.index) !== selectedPattern) continue;
          const faults = text.slice(lowerBound(text, start, item => item.sourceEnd), lowerBound(text, end + 1, item => item.sourceStart))
            .filter(item => overlaps(item, start, end));
          const parts = faults.flatMap(item => item.missing ? [{ missing: true }] : window.PdfSelectionDiff.comparisonParts(item.comparison)
            .filter(part => part.changed).map(part => {
              const a = Math.max(start, item.sourceStart + part.start), b = Math.min(end, item.sourceStart + part.end);
              const left = a - item.sourceStart - part.start, right = b - item.sourceStart - part.start;
              return { start: a - start, end: b - start, html: part.html.slice(left, right),
                pdf: left === 0 && right === part.html.length ? part.pdf : part.html.length === part.pdf.length ? part.pdf.slice(left, right) : null };
            }).filter(part => part.start <= part.end));
          if (parts.length !== changes.length || parts.some((part, at) => part.missing || part.start !== changes[at].start
            || part.end !== changes[at].end || part.html !== changes[at].html || part.pdf !== changes[at].pdf)) continue;
          const item = makeSelection(start);
          const at = lowerBound(group.items, start, item => item.sourceStart);
          group.items.splice(at, 0, item); group.entries.splice(at, 0, item.pdfSource); group.edits.push(...item.options[0].edits);
        }
      }
      this.reviewLists.set(selectedItem, group);
      this.reviewLists.set(group.items, group);
      const result = { ...data, selection: selectedItem };
      this.reviewLists.set(notice, result);
      return result;
    }
    if (!data.partial) return data;
    this.cacheReview(data);
    return Promise.resolve(context.onProgress(data)).then(accepted => {
      if (accepted === false || !this.prepareReview(context)) return { items: [] };
      return this.reviewItems({ ...context, priority: undefined, onProgress: undefined });
    });
  }
  pattern(value, index = this.index) {
    if (value.missing || !index) return value;
    const start = value.sourceStart, end = value.sourceEnd;
    // Unknown or foreign source context may only match the candidate itself.
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > index.raw.length
      || value.pdfSource && value.pdfSource.index !== index) return value;
    let before = start, after = end;
    while (before > 0 && wordCharacter.test(index.raw.slice(before - (index.raw.codePointAt(before - 2) > 0xffff ? 2 : 1), before)))
      before -= index.raw.codePointAt(before - 2) > 0xffff ? 2 : 1;
    while (after < index.raw.length && wordCharacter.test(String.fromCodePoint(index.raw.codePointAt(after))))
      after += index.raw.codePointAt(after) > 0xffff ? 2 : 1;
    if (!value.font && value.options?.[0]) value.options[0].range = {
      start: index.starts[before] ?? index.source.length,
      end: after > before ? index.ends[after - 1] : index.starts[before] ?? index.source.length };
    const prefix = index.raw.slice(before, start), suffix = index.raw.slice(end, after);
    if ([...index.raw.slice(before, after)].length < 2
      && [...(prefix + (value.comparison?.pdf ?? value.text ?? '') + suffix)].length < 2) return value;
    const change = value.font ? [value.text, ...fontKeys.flatMap(key => [value.htmlFont[key], value.font[key]])]
        : [value.comparison?.html, value.comparison?.pdf];
    return JSON.stringify([!!value.font, !!value.selection, change,
      ...(value.selection && window.PdfSelectionDiff.comparisonParts(value.comparison, true).some(part => !part.changed && part.html.length) ? [] : [prefix, suffix])]);
  }
  cacheReview(data) {
    Object.assign(data, { entries: [], edits: [], plans: [] });
    const groups = new Map();
    for (const value of data.items) {
      if (value.font || value.missing || value.selection && value.comparison.html.trim()) value.range ||= this.editorDocument.rangeAt(value.sourceStart, value.sourceEnd, true);
      value.pdfSource ||= data.index.candidateEntry(value);
      const key = data.partial ? value : this.pattern(value, data.index);
      if (!value.missing) data.plans.push(value.font ? { ...value.options[0],
        title: `替换格式：${value.text}（${fontSummary(value.formats)}）`,
        range: { start: data.index.starts[value.sourceStart], end: data.index.ends[value.sourceEnd - 1] }
      } : value.options[0]);
      let group = groups.get(key);
      if (!group) { group = { index: data.index, items: [], entries: [], edits: [] }; groups.set(key, group); this.reviewLists.set(group.items, group); }
      this.reviewLists.set(value, group);
      group.items.push(value); group.entries.push(value.pdfSource); group.edits.push(...value.options[0].edits);
      data.entries.push(value.pdfSource); data.edits.push(...value.options[0].edits);
    }
    this.reviewLists.set(data.items, data);
  }
  editorSourceIndex(documentModel = this.editorDocument) {
    const pdf = this.environment.getPdf?.() || this.pdf;
    const numbers = this.environment.getSourcePages?.(), sourcePageKey = numbers ? `pages:${numbers.join(',')}` : '';
    this.editorDocument = documentModel;
    this.model = documentModel.model;
    this.pdf = pdf;
    let pairs = this.comparisons.get(this.model);
    if (!pairs) this.comparisons.set(this.model, pairs = new WeakMap());
    let previous = pairs.get(this.pdf);
    const { source, version } = documentModel.snapshot;
    if (previous?.sourcePageKey !== sourcePageKey) { previous = undefined; this.review = null; }
    if (previous?.source === source && previous.version === version) this.index = previous;
    else {
      this.index = new window.PdfSelectionDiff.PdfConnections(this, documentModel);
      this.index.sourcePageKey = sourcePageKey;
      pairs.set(this.pdf, this.index);
      if (previous) this.index.inherit(previous);
    }
    return this.index;
  }
  reviewAnchor(item) {
    const source = item?.pdfSource;
    if (!source) return null;
    for (const { index } of this.environment.getVisiblePages?.() || []) {
      if (!index?.layer?.isConnected) continue;
      const hit = item.missing ? source.index.missingRange(index, source.start, source.end)
        : source.index.range(index, source.start, source.end, false, undefined, true);
      if (!hit) continue;
      const div = index.layer.closest('.page') || index.layer;
      const box = highlights.measureHighlights(div, index, [hit], hit).notices[0]?.box;
      if (!box) continue;
      const page = div.getBoundingClientRect(), sx = page.width / div.offsetWidth, sy = page.height / div.offsetHeight;
      return {
        left: page.left + div.clientLeft * sx + box.x * div.clientWidth * sx + (box.caret ? 2 : 0),
        top: page.top + div.clientTop * sy + box.y * div.clientHeight * sy,
        bottom: page.top + div.clientTop * sy + (box.y + box.h) * div.clientHeight * sy
      };
    }
    return null;
  }
  async indexDocument(pdf, numbers) {
    numbers = numbers ? [...numbers] : undefined;
    if (!this.documents.has(pdf)) this.documents.set(pdf, new Map());
    const documents = this.documents.get(pdf), key = numbers ? `pages:${numbers.join(',')}` : '';
    if (!documents.has(key)) {
      const index = new window.PdfSelectionDiff.PdfConnections(this, { pdf, sourcePages: numbers, raw: "", pages: [], normalized: null });
      documents.set(key, index);
      index.task = Promise.resolve().then(async () => {
        let mappedStart = 0;
        const mapped = { text: "", starts: [], ends: [] };
        for (const number of index.sourcePages || Array.from({ length: pdf.numPages }, (_, i) => i + 1)) {
          if (!this.environment.isCurrent(pdf)) return null;
          await this.environment.waitForIdle(pdf);
          if (!this.environment.isCurrent(pdf)) return null;
          const page = await pdf.getPage(number), content = await readPageText(page);
          if (!this.environment.isCurrent(pdf)) return null;
          const start = index.raw.length;
          const parts = content.parts.map(part => ({ ...part, start: start + part.start, end: start + part.end }));
          index.raw += content.raw;
          index.pages.push({ number, start, end: index.raw.length, parts, breaks: content.breaks.map(at => start + at) });
          index.raw += "\n";
          if (!/[-\u2010\u2011]\s*$/.test(index.raw.slice(mappedStart))) {
            window.PdfSelectionDiff.normalized(index.raw.slice(mappedStart), mapped, mappedStart); mappedStart = index.raw.length;
          }
        }
        window.PdfSelectionDiff.normalized(index.raw.slice(mappedStart), mapped, mappedStart);
        index.normalized = mapped;
        if (this.environment.isCurrent(pdf)) this.environment.onIndexed?.();
        return index;
      }).then(result => {
        if (!result && documents.get(key) === index) documents.delete(key);
        return result;
      }, error => { if (documents.get(key) === index) documents.delete(key); throw error; });
    }
    return documents.get(key).task;
  }
  getDocumentIndex(pdf, numbers) { return window.PdfSelectionDiff.documentIndex(this.documents, pdf, numbers); }
  async indexFonts(pdf, source, signal, numbers) {
    const index = await this.indexDocument(pdf, numbers);
    if (!index || signal?.aborted) return null;
    source?.update();
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
  if (listeningWindow === window) {
    window.removeEventListener('pdf-selection-sources', onSources);
    window.removeEventListener('pdf-selection-reset', highlights.clearMarks);
    highlights.clearMarks();
  }
  listeningWindow = target;
  target?.addEventListener('pdf-selection-difference', onDifference);
  if (target === window) {
    window.addEventListener('pdf-selection-sources', onSources);
    window.addEventListener('pdf-selection-reset', highlights.clearMarks);
  }
}
function onReviewClosed(event) {
  if (selection()?.selectionEnabled === false) return;
  const { id, editor, model } = event.detail;
  if (reviewIds.includes(id)) dismissed = {
    editor, model, version: model.getVersionId?.(), range: editor.getSelection()?.toString(), interaction: selection()?.interactionId
  };
}

async function onDifference(event) {
  bind();
  if (selection()?.selectionEnabled === false) return;
  const data = event.detail, editor = data.editor, model = editor?.getModel(), readerHost = listeningWindow?.ReplacementReview;
  const destination = data.side === 'pdf' || reviewIds.some(id => readerHost?.isOpenFor(id, editor)) ? readerHost
    : editor?.getDomNode()?.ownerDocument.defaultView.ReplacementReview || readerHost;
  if (destination !== host || dismissed?.editor === editor && dismissed.model === model && dismissed.version === model?.getVersionId?.()
    && dismissed.range === editor?.getSelection()?.toString() && dismissed.interaction === data.interactionId) return;
  const { notices, candidateId, kind, pdf } = data, fontStyles = locator.fontStyles;
  if (pdf !== viewer()?.pdfDocument || data.model && data.model !== model
    || !locator.textEnabled && !fontStyles.length) return;
  const changed = candidateId && kind !== 'font' ? notices[0] : notices.find(value =>
    typeof value.html === 'string' && typeof value.pdf === 'string'
    && (!value.source || value.source.index.raw.slice(value.source.start, value.source.end) === value.html)
    && window.PdfSelectionDiff.comparisonParts(value).some(part => part.changed));
  const notice = changed || notices.find(value => value.source) || notices[0];
  if (!notice || changed && !locator.textEnabled || !changed && (!notice.source || !model)) return;
  const request = { ...data, notice, kind: changed ? kind : 'font' };
  const selectedRange = editor?.getSelection?.()?.toString();
  const prepared = notice.source && model ? await locator.reviewItems({ ...data, request,
    source: notice.source.index.source, version: notice.source.index.version }) : { items: [] };
  if (editor?.getModel() !== model || editor?.getSelection?.()?.toString() !== selectedRange) return;
  const item = candidateId ? prepared.items.find(item => item.id === candidateId)
    : request.kind === 'font' ? prepared.items.find(item => item.font && item.sourceStart < notice.source.end && item.sourceEnd > notice.source.start) : prepared.selection;
  if (notice.source && model && !item) return;
  if (item) request.focusId = item.id;
  dismissed = null;
  if (nativeEditor && data.side === 'html')
    return item && host.showHover(review, { editor, model, documentModel: editor.document, snapshot: editor.document.snapshot }, item, prepared.items, notice.source);
  if (!notice.source || !model) return host.showNotice({
    title: 'PDF 文字差异', message: '文字不一致', comparison: comparisonRows(notice, false, notice.missing, true), anchor: data.anchor,
    layout: presentation({ editor, request })
  });
  return host.openForSelection(locator.textEnabled ? 'pdf-ocr' : fontStyles.includes('italic') ? 'pdf-font' : 'pdf-bold', editor, request.focusId, request);
}

function presentation(context, item) {
  const reader = readerWindow() || window, source = context.editor?.getDomNode()?.ownerDocument.defaultView || window;
  const split = source !== reader, side = split ? context.request?.side || 'html' : 'pdf';
  const request = context.request, element = request?.anchorElement, box = request?.anchorBox;
  const rect = element?.isConnected && element.getBoundingClientRect();
  const requested = (!item || item.sourceStart === request?.notice?.source?.start) && (rect && box ? {
    left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height,
    bottom: rect.top + (box.y + box.h) * rect.height
  } : request?.anchor);
  // The event already measured the clicked PDF range. Recomputing it from a
  // source fragment can lose the range at an inline-tag boundary.
  const anchor = side === 'pdf' ? requested || (item && locator.reviewAnchor(item)) : null;
  const destination = side === 'pdf' ? reader : source, pdfViewer = viewer();
  return {
    side, switchable: split, switchLabel: side === 'pdf' ? '查看HTML' : '查看PDF', host: destination.ReplacementReview, window: destination,
    container: pdfViewer?.container, eventBus: pdfViewer?.eventBus, anchor,
    highlights: side === 'pdf' ? [anchor,
      ...(context.snapshot === context.documentModel?.snapshot ? locator.reviewLists.get(item)?.items || [] : [])
        .map(value => value !== item && locator.reviewAnchor(value))
    ].filter(Boolean) : []
  };
}
function content(state, item) {
  const { documentModel } = state.context, edits = item?.options[0].edits || [], data = locator.reviewLists.get(state.items);
  const message = item?.missing ? 'PDF OCR 缺少相关文字。' : item?.font ? fontSummary(item.formats || [item])
    : item ? '文字不一致' : state.items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。';
  return {
    message, edits: locator.reviewLists.get(item)?.edits, allEdits: data?.edits,
    all: data?.partial ? false : undefined,
    comparison: item?.font ? ['htmlFont', 'font'].map((field, i) => ({ label: i ? 'PDF' : 'HTML', parts: [{ text: fontSummary(item.formats, field) }] }))
      : comparisonRows(item?.comparison, !item?.selection, item?.missing, item?.selection),
    previewDecorations: item?.font || item?.missing ? item.previewDecorations ||= (data?.index || item.pdfSource?.index || locator.index).sourceSegments(item.sourceStart, item.sourceEnd, true).map(segment => ({
      range: documentModel.rangeAt(segment.start, segment.end), options: { inlineClassName: item.missing ? 'mew-review-proposed' : 'mew-review-format', stickiness: 1 }
    })) : [],
    apply: !!edits.length,
    range: item?.range || (edits.length ? documentModel.rangeAt(Math.min(...edits.map(edit => edit.start)), Math.max(...edits.map(edit => edit.end))) : null),
    options: [], applyLabel: item?.font ? '替换格式' : '替换', advance: false, expanded: false
  };
}
function apply({ item, items, position, context }, all) {
  const { editor, documentModel, source } = context;
  const data = locator.reviewLists.get(items), index = data?.index || locator.index;
  const offset = index.starts[item.sourceStart] ?? source.length;
  if (index !== locator.editorSourceIndex(documentModel)) return { offset };
  if (all && data?.partial) throw new Error('完整差异队列仍在准备，请稍后替换全部');
  const selected = all ? items : locator.reviewLists.get(item)?.items || [], candidates = new Set(selected);
  if (!all && item.font) for (const candidate of items)
    if (candidate.font && selected.some(value => value.font && candidate.sourceStart < value.sourceEnd && candidate.sourceEnd > value.sourceStart))
      candidates.add(candidate);
  const edits = documentModel.validateEdits((candidates.size === selected.length && locator.reviewLists.get(selected)?.edits)
    || [...candidates].flatMap(value => value.options[0].edits));
  const next = items.findIndex((value, at) => at > position && !candidates.has(value));
  const first = items.findIndex(value => candidates.has(value)), last = items.findLastIndex(value => candidates.has(value));
  return { position: next < 0 ? items.length : next, priority: last - first + 1 === candidates.size,
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
    return source && item && (this.id === 'pdf-ocr' ? item.sourceStart === source.start && item.sourceEnd === source.end
      : item.sourceStart < source.end && item.sourceEnd > source.start);
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
  if (selection()?.selectionEnabled === false) return;
  const fontStyles = locator.fontStyles;
  const { editor, pdf, enabled: highlighted } = event.detail;
  const index = editor?.createDecorationsCollection && locator.prepareReview({ editor, pdf });
  if (!index) return;
  const model = editor.getModel(), data = locator.reviewItems(), owner = editor.getDomNode()?.ownerDocument.defaultView;
  const controller = nativeEditor ? editor : owner.mewWorkbench || owner.readerMonaco;
  host.bindSuggestions(editor, currentModel => editor === selection()?.editor && locator.prepareReview({ editor, model: currentModel })
    ? locator.reviewItems().plans : []);
  if (editor.addAction && !editor.getAction('mew.pdf-difference')) {
    const action = editor.addAction({
      id: 'mew.pdf-difference', label: '查看 PDF 差异',
      async run(_, request) {
        const model = editor.getModel();
        if (!locator.prepareReview({ editor, model, version: request.version }) || model.uri.toString() !== request.model) return;
        const noticeData = request.selection;
        const { items, selection: selected } = locator.reviewItems({ request: noticeData && { notice: { ...noticeData,
          source: { index: locator.index, start: noticeData.start, end: noticeData.end } } } });
        const item = selected || items.find(item => item.id === request.id);
        if (!item) return;
        const reader = readerWindow() || window, notice = { ...item.comparison, missing: item.missing, source: item.pdfSource };
        if (request.save) {
          await apply({ item, items, position: selected ? selected.queueRange[0] : items.indexOf(item), context: { editor, model, documentModel: editor.document, snapshot: editor.document.snapshot, source: model.getValue(), version: request.version } }, false).apply?.();
          return controller.save({ followPdf: false, model });
        }
        reader.dispatchEvent(new reader.CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf: viewer()?.pdfDocument, notices: [notice],
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
  const command = editor.getId?.() && `${editor.getId()}:mew.pdf-difference`;
  const hover = nativeEditor ? item => host.hoverContent(review, { editor, model, documentModel: editor.document }, item, data.items) : item => sourceHover(item, model, command);
  highlights.updateSource(editor, [index, highlighted, data, model],
    () => highlighted || nativeEditor ? sourceDecorations(index, data.items, fontStyles, locator.textEnabled, hover, editor.document)
      .map(mark => highlighted ? mark : { ...mark, options: { ...mark.options, inlineClassName: '', before: undefined } }) : []);
  if (event.detail.diffEnabled && data) selection()?.showReviewPointer(editor, data.items, data);
}
window.PdfReviewReady = (async () => {
  if (!window.MewEditorCore?.DocumentModel) await import('../editor-core.js');
  if (!window.PdfSelectionDiff?.PdfConnections) await import('./pdf-connection.js');
  await window.PdfSelectionDiff.ready;
  if (!window.ReplacementReview || !window.ReviewHighlights) await import('./replacement-review.js');
  host = window.ReplacementReview;
  highlights = window.ReviewHighlights.create({
    document,
    classes: { selection: 'mew-pdf-selection-highlight', pointer: 'mew-pdf-review-pointer', caret: 'mew-pdf-selection-caret' }
  });
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
  const unregister = [...[
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
  })), ...[
    ['pdf-selection', 'PDF 差异高亮', 'enabled', value => selection()?.setDiffHighlight(value), true],
    ['source-diff', '源码差异高亮', 'sourceEnabled', value => selection()?.setDiffHighlight(value, 'source'), true],
    ['pdf-selection-sync', 'PDF 与源码选区联动', 'selectionEnabled', value => selection()?.setSelectionHighlight(value)]
  ].map(([id, label, setting, setEnabled, toggleOnly]) => host.register({
    id, label, toggleOnly, setEnabled, available: () => !!selection() && (setting === 'selectionEnabled' || selection().selectionEnabled), isEnabled: () => selection()?.[setting] === true
  }))];
  let previousPdf = viewer()?.pdfDocument, previousEnabled, previousFonts = locator.fontStyles;
  const poll = nativeEditor ? null : setInterval(() => {
    bind();
    const pdf = viewer()?.pdfDocument, api = selection(), fonts = locator.fontStyles, state = `${!!api}:${api?.enabled}:${api?.sourceEnabled}:${api?.selectionEnabled}:${fonts}`;
    if (previousPdf !== pdf || previousFonts !== fonts) {
      const fontsChanged = previousFonts !== fonts;
      previousPdf = pdf; previousFonts = fonts;
      for (const id of reviewIds) host.invalidate(id, context => fontsChanged || context.pdf !== pdf);
    }
    if (previousEnabled !== state) {
      previousEnabled = state; host.refreshMenu();
    }
  }, 500);
  window.addEventListener('pagehide', () => { clearInterval(poll); bind(null); highlights.dispose(); window.removeEventListener('replacement-review-closed', onReviewClosed); unregister.forEach(dispose => dispose()); });
  return window.PdfReviewProvider;
})();
