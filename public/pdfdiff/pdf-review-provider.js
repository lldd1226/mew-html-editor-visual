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
    const segments = index.sourceSegments(start, item.sourceEnd, font || !index.raw.slice(start, item.sourceEnd).trim());
    if (!font && !segments.length) {
      const at = index.starts[start] ?? index.ends[start - 1] ?? 0;
      segments.push({ start: at, end: at });
      Object.assign(options, { inlineClassName: undefined, showIfCollapsed: true,
        before: { content: '\u200b', inlineClassName: 'mew-ocr-diff-insert', inlineClassNameAffectsLetterSpacing: true } });
    }
    return segments.map(({ start, end }) => ({ range: documentModel.rangeAt(start, end), options }));
  }).sort(({ range: a }, { range: b }) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn
    || b.endLineNumber - a.endLineNumber || b.endColumn - a.endColumn);
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
function comparisonRows(value, compact = true, missing = value?.missing) {
  if (typeof value?.html !== 'string' || typeof value?.pdf !== 'string') return [];
  let parts = window.PdfSelectionDiff.comparisonParts(value);
  const rows = value.comparisonDiff.rows, key = Number(compact) + 2 * !!missing;
  if (rows[key]) return rows[key];
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
  return data.text ||= Promise.resolve().then(() => page.getTextContent()).catch(error => {
    delete data.text;
    throw error;
  });
}

function readPageFonts(page, items) {
  const data = pageData(page);
  return data.fonts ||= (async () => {
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
  })();
}

function layerFonts(view, layer, refresh) {
  const page = view?.pdfPage, objects = page?.commonObjs, fonts = new Map();
  const cached = page && pageData(page);
  if (page?.getTextContent && !cached.layer) {
    cached.layer = { items: [], fonts: new Map() };
    readPageText(page).then(async content => {
      const items = content.items.filter(item => item.str?.length);
      const fonts = await readPageFonts(page, items);
      Object.assign(cached.layer, { items, fonts }); refresh();
    }).catch(() => { delete cached.layer; });
  }
  const data = cached?.layer, items = data?.items || [];
  const spans = (view?._textHighlighter?.textDivs || [...layer.querySelectorAll('span[role="presentation"]')]).filter(span => span.textContent);
  const names = new Map();
  if (spans.length === items.length && spans.every((span, i) => span.textContent === items[i].str))
    spans.forEach((span, i) => names.set(span, items[i]));
  return Object.assign(element => {
    const item = names.get(element);
    const observed = item && data?.fonts.get(item.fontName);
    if (observed) return observed;
    const css = element.ownerDocument.defaultView.getComputedStyle(element), family = css.fontFamily;
    const id = item?.fontName || element.dataset?.fontName;
    const key = `${id}:${family}:${css.fontStyle}:${css.fontWeight}`;
    if (!fonts.has(key)) {
      const font = id && objects?.has(id) ? objects.get(id) : objects && [...objects]
        .find(([, value]) => value.loadedName && family.includes(value.loadedName))?.[1];
      const style = data?.fonts.get(id) || window.PdfSelectionDiff.pdfFontStyle(font, family, css);
      fonts.set(key, page?.getTextContent && !data?.fonts.has(id)
        ? { ...style, bold: null, italic: null, reason: '字体渲染模式检查中' } : style);
    }
    return fonts.get(key);
  }, { items: names, spans });
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
    const request = context.request, { source, target } = request?.notice || {};
    const selected = request?.pdf === pdf && context.source !== undefined && source?.index.source === context.source && source.index;
    this.editorSourceIndex(editor.document, selected
      ? [...new Set([target?.index, ...(request.targets || [])].filter(Boolean))]
      : undefined, selected || undefined);
    // A selection can confirm an exact text mapping before background preparation.
    if (selected && target && window.PdfSelectionDiff.normalized(this.index.raw.slice(source.start, source.end)).text
      === window.PdfSelectionDiff.normalized(target.index.raw.slice(target.start, target.end)).text)
      this.index.remember(source.start, source.end, target.index, { start: target.start, end: target.end });
    return this.index;
  }
  reviewItems(context = {}) {
    if (selection()?.selectionEnabled === false) return { items: [] };
    const fontStyles = activeFontStyles();
    if (context.source !== undefined) { if (!this.prepareReview(context)) return { items: [] }; }
    else this.editorSourceIndex(context.editor?.document);
    const { request } = context;
    const fontKey = fontStyles.join(','), { changedRange, lowerBound } = window.PdfSelectionDiff;
    const reusable = this.review?.model === this.model && this.review.enabled === this.textEnabled && this.review.fontKey === fontKey;
    const previous = this.review?.index, prepared = previous?.prepared, versions = prepared?.fontVersions;
    let priority = [];
    if (context.onProgress && context.priority && reusable && previous !== this.index && prepared?.pdf === this.pdf
      && versions && prepared.pages.every((page, i) => page.parts === versions[1 + i * 3]
        && page.pages === versions[2 + i * 3] && page.fontVersion === versions[3 + i * 3])) {
      const raw = changedRange(previous.raw, this.index.raw), source = changedRange(previous.source, this.index.source);
      const delta = raw.newEnd - raw.oldEnd, sourceDelta = source.newEnd - source.oldEnd, suffix = previous.raw !== this.index.raw ? raw.oldEnd : 0;
      for (let at = lowerBound(this.review.items, Math.max(suffix, lowerBound(previous.ends, context.priority.offset - sourceDelta + 1)),
        item => item.reviewStart ?? item.sourceStart); at < this.review.items.length; at++) {
        const item = this.review.items[at], { range, ...option } = item.options[0];
        if (priority.length === 5 || item.selection) break;
        if (item.sourceStart < suffix || previous.starts[item.sourceStart] < source.oldEnd
          || item.sourceStart === item.sourceEnd && item.sourceStart === raw.oldEnd && raw.newEnd > raw.oldEnd
          || option.edits.some(edit => edit.start < source.oldEnd)) continue;
        priority.push({ ...item, id: `${item.font ? 'font:' : ''}${item.sourceStart + delta}:${item.sourceEnd + delta}`,
          sourceStart: item.sourceStart + delta, sourceEnd: item.sourceEnd + delta,
          reviewStart: item.reviewStart === undefined ? undefined : item.reviewStart + delta, range: undefined, previewDecorations: undefined,
          options: [{ ...option, edits: option.edits.map(edit => ({ ...edit, start: edit.start + sourceDelta, end: edit.end + sourceDelta })) }] });
      }
    }
    const notice = !request?.candidateId && request?.notice;
    const data = { index: this.index, model: this.model, notice, enabled: this.textEnabled, fontKey,
      items: priority, shared: this.review?.shared, partial: !!priority.length };
    if (!data.partial) {
      if (context.source !== undefined && !(request?.pdf === this.pdf && request.notice?.source?.index === this.index)) {
        const { model, pdf } = this, source = context.source, version = context.version ?? model.getVersionId?.();
        const pages = (readerWindow() || window).ReaderUI?.getPdfSourcePages?.();
        return (fontStyles.length ? this.indexFonts(pdf, this.index, context.signal, pages) : this.indexDocument(pdf, pages)).then(full => {
          if (!full || source !== model.getValue() || !this.prepareReview({ ...context, source: undefined, version })) return { items: [] };
          this.editorSourceIndex(context.editor.document, [...new Set([full, ...(this.environment.getTargets?.() || [])])]);
          return this.reviewItems({ request });
        });
      }
      data.shared = this.index.getDifferences();
      if (reusable && this.review.shared === data.shared && this.review.notice === notice) return this.review;
      data.items = this.textEnabled ? data.shared.items : data.shared.items.filter(item => item.font);
    }
    const source = this.textEnabled && notice?.source, selected = source && (notice.missing ? [] : this.index.candidates(notice));
    const selectedItem = data.selection = source && (notice.missing || selected.length && !data.shared.items.some(item => item.missing
      && item.sourceStart < source.end && item.sourceEnd > source.start)) && {
      id: `${source.start}:${source.end}`, sourceStart: source.start, sourceEnd: source.end,
      selection: true, comparison: notice, ...(notice.missing ? { missing: true } : {}),
      options: [{ id: 'pdf', label: '替换', edits: selected.flatMap(item => item.options[0].edits) }]
    };
    if (selectedItem) {
      const text = data.items.filter(item => !item.font);
      const selections = [selectedItem], covered = new Set();
      const changes = selectedItem.missing ? [] : window.PdfSelectionDiff.comparisonParts(notice).filter(part => part.changed);
      const [change] = changes;
      // Anchor the selected context to confirmed faults in the existing queue.
      for (const anchor of change ? text : []) {
        if (anchor.missing || anchor.comparison.html !== change.html || anchor.comparison.pdf !== change.pdf) continue;
        const start = anchor.sourceStart - change.start, end = start + notice.html.length;
        if (start === selectedItem.sourceStart || start < 0 || this.index.raw.slice(start, end) !== notice.html) continue;
        const faults = text.slice(lowerBound(text, start, item => item.sourceEnd), lowerBound(text, end + 1, item => item.sourceStart))
          .filter(item => !(item.sourceEnd <= start && item.sourceStart < start || item.sourceStart >= end && item.sourceEnd > end));
        if (faults.length !== changes.length || faults.some((item, at) => item.missing
          || item.sourceStart !== start + changes[at].start || item.sourceEnd !== start + changes[at].end
          || item.comparison.html !== changes[at].html || item.comparison.pdf !== changes[at].pdf)) continue;
        selections.push({ ...selectedItem, id: `${start}:${end}`, sourceStart: start, sourceEnd: end,
          comparison: { html: notice.html, pdf: notice.pdf, source: { index: this.index, start, end } },
          options: [{ id: 'pdf', label: '替换', edits: faults.flatMap(item => { covered.add(item); return item.options[0].edits; }) }] });
      }
      data.items = [...text.filter(item => !covered.has(item) && (item.missing && !selectedItem.missing
        || item.sourceEnd <= selectedItem.sourceStart && item.sourceStart < selectedItem.sourceStart
        || item.sourceStart >= selectedItem.sourceEnd && item.sourceEnd > selectedItem.sourceEnd)),
      ...selections].sort((a, b) => a.sourceStart - b.sourceStart);
    }
    if (!data.partial) data.items = this.index.formatDifferences(data.items, fontStyles);
    this.cacheReview(data, data.partial ? value => value : undefined);
    if (!data.partial) return this.review = data;
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
      ...(value.selection && window.PdfSelectionDiff.comparisonParts(value.comparison).some(part => !part.changed && part.html.length) ? [] : [prefix, suffix])]);
  }
  cacheReview(data, groupKey = value => this.pattern(value, data.index)) {
    Object.assign(data, { entries: [], edits: [], plans: [], groups: new Map() });
    for (const value of data.items) {
      if (value.font && data.notice?.source && value.sourceStart < data.notice.source.end && value.sourceEnd > data.notice.source.start) data.focus ||= value;
      if (value.font || value.missing || value.selection) value.range ||= this.editorDocument.rangeAt(value.sourceStart, value.sourceEnd, true);
      value.pdfSource ||= data.index.entry(value.sourceStart, value.sourceEnd, true);
      const key = groupKey(value);
      if (!value.missing) data.plans.push(value.font ? { ...value.options[0],
        title: `替换格式：${value.text}（${fontSummary(value.formats)}）`,
        range: { start: data.index.starts[value.sourceStart], end: data.index.ends[value.sourceEnd - 1] }
      } : value.options[0]);
      let group = data.groups.get(key);
      if (!group) { group = { index: data.index, items: [], entries: [], edits: [] }; data.groups.set(key, group); this.reviewLists.set(group.items, group); }
      data.groups.set(value, group);
      group.items.push(value); group.entries.push(value.pdfSource); group.edits.push(...value.options[0].edits);
      data.entries.push(value.pdfSource); data.edits.push(...value.options[0].edits);
    }
    this.reviewLists.set(data.items, data);
  }
  editorSourceIndex(documentModel = this.editorDocument, targets, index) {
    const pdf = this.environment.getPdf?.() || this.pdf;
    targets ??= documentModel.model === this.model && pdf === this.pdf ? this.index?.targets : undefined;
    this.editorDocument = documentModel;
    this.model = documentModel.model;
    this.pdf = pdf;
    let pairs = this.comparisons.get(this.model);
    if (!pairs) this.comparisons.set(this.model, pairs = new WeakMap());
    const previous = pairs.get(this.pdf), { source, version } = documentModel.snapshot;
    if (!index && previous?.source === source && previous.version === version) index = previous;
    const created = !index;
    this.index = index || new window.PdfSelectionDiff.PdfConnections(this, documentModel);
    Object.assign(this.index, { version, model: this.model });
    this.index.targets = targets || this.index.targets || previous?.targets || [];
    pairs.set(this.pdf, this.index);
    if (created && previous) this.index.inherit(previous);
    return this.index;
  }
  reviewAnchor(item, currentIndex = this.index) {
    const source = item?.pdfSource;
    if (!source) return null;
    for (const { index } of this.environment.getVisiblePages?.() || []) {
      if (!index?.layer?.isConnected) continue;
      index.reviewAnchors ||= new WeakMap();
      const connections = source.index.connections.get(index)?.ranges, currentConnections = currentIndex?.connections.get(index)?.ranges;
      let cached = index.reviewAnchors.get(item);
      if (!cached || cached.connections !== connections || cached.currentIndex !== currentIndex || cached.currentConnections !== currentConnections) {
        const hit = item.missing ? source.index.missingRange(index, source.start, source.end)
          : source.index.range(index, source.start, source.end, false, undefined, true)
            || currentIndex && currentIndex !== source.index && currentIndex.range(index, item.sourceStart, item.sourceEnd, false, undefined, true);
        cached = { connections, currentIndex, currentConnections, hit };
        index.reviewAnchors.set(item, cached);
      }
      const layer = index.layer.getBoundingClientRect(), hit = cached.hit;
      if (!hit) continue;
      if (cached.bounds) return {
        left: layer.left + cached.bounds.left * layer.width,
        top: layer.top + cached.bounds.top * layer.height, bottom: layer.top + cached.bounds.bottom * layer.height
      };
      const end = index.raw.slice(hit.start, hit.end).trim() ? hit.start + index.raw.slice(hit.start, hit.end).trimEnd().length : hit.start;
      const bounds = { left: Infinity, top: Infinity, bottom: -Infinity };
      const range = this.document.createRange();
      const at = end === hit.start && hit.endBias ? Math.max(0, hit.start - 1) : hit.start;
      for (const part of index.fontRuns(at, end === hit.start ? at : end, true)) {
        if (end > hit.start && !index.raw.slice(Math.max(hit.start, part.start), Math.min(end, part.end)).trim()) continue;
        range.setStart(part.node, Math.max(0, Math.min(part.node.length, hit.start - part.start)));
        range.setEnd(part.node, Math.max(0, Math.min(part.node.length, end - part.start)));
        for (const box of range.getClientRects()) if (box.height && (box.width || end === hit.start)) {
          bounds.left = Math.min(bounds.left, box.left);
          bounds.top = Math.min(bounds.top, box.top);
          bounds.bottom = Math.max(bounds.bottom, box.bottom);
        }
      }
      if (bounds.bottom !== -Infinity) {
        if (layer.width && layer.height) cached.bounds = {
          left: (bounds.left - layer.left) / layer.width,
          top: (bounds.top - layer.top) / layer.height, bottom: (bounds.bottom - layer.top) / layer.height
        };
        return bounds;
      }
    }
    return null;
  }
  async indexDocument(pdf, numbers) {
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
          const start = index.raw.length, parts = [];
          let previous = null;
          for (const item of content.items.filter(item => item.str?.length).sort((a, b) =>
            Math.round((window.PdfSelectionDiff.pdfTextBaseline(b) - window.PdfSelectionDiff.pdfTextBaseline(a)) / Math.max(a.height, b.height)) || a.transform[4] - b.transform[4])) {
            if (previous && !index.raw.endsWith("\n")) {
              const lineBreak = Math.abs(window.PdfSelectionDiff.pdfTextBaseline(item) - window.PdfSelectionDiff.pdfTextBaseline(previous)) > Math.max(item.height, previous.height) * 0.5;
              if (lineBreak) index.raw += "\n";
              else if (item.transform[4] - previous.transform[4] - previous.width > Math.max(item.height, previous.height) * 0.08) index.raw += " ";
            }
            parts.push({ start: index.raw.length, end: index.raw.length + item.str.length, item });
            index.raw += item.str + (item.hasEOL ? "\n" : "");
            previous = item;
          }
          index.pages.push({ number, start, end: index.raw.length, parts });
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
        if (!result) documents.delete(key);
        return result;
      }, error => { documents.delete(key); throw error; });
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
        const fonts = await readPageFonts(page, entry.parts.map(part => part.item));
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
function activeFontStyles() { return readerWindow()?.PdfReviewProvider?.locator?.fontStyles || locator.fontStyles; }
// Only the reader owns decorations, including those in its paired editor.
function bind(target = readerWindow() || window) {
  if (!locator) {
    locator = window.PdfSelection?.locator || new PdfLocator({}, {
      document, getPdf: () => viewer()?.pdfDocument,
      isCurrent: pdf => selection()?.selectionEnabled !== false && viewer()?.pdfDocument === pdf,
      waitForIdle: () => new Promise(resolve => setTimeout(resolve, 0))
    });
    try { locator.textEnabled = localStorage.getItem('mew.pdf-review.enabled') !== 'false'; } catch { }
    window.addEventListener('replacement-review-closed', onReviewClosed);
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

function onDifference(event) {
  if (selection()?.selectionEnabled === false) return;
  const data = event.detail, editor = data.editor, model = editor?.getModel(), readerHost = listeningWindow?.ReplacementReview;
  const destination = data.side === 'pdf' || reviewIds.some(id => readerHost?.isOpenFor(id, editor)) ? readerHost
    : editor?.getDomNode()?.ownerDocument.defaultView.ReplacementReview || readerHost;
  if (destination !== host || dismissed?.editor === editor && dismissed.model === model && dismissed.version === model?.getVersionId?.()
    && dismissed.range === editor?.getSelection()?.toString() && dismissed.interaction === data.interactionId) return;
  const { notices, candidateId, kind, pdf } = data, fontStyles = activeFontStyles();
  if (pdf !== viewer()?.pdfDocument || data.model && data.model !== model
    || !locator.textEnabled && !fontStyles.length) return;
  const changed = candidateId && kind !== 'font' ? notices[0] : notices.find(value =>
    typeof value.html === 'string' && typeof value.pdf === 'string'
    && (!value.source || value.source.index.raw.slice(value.source.start, value.source.end) === value.html)
    && window.PdfSelectionDiff.comparisonParts(value).some(part => part.changed));
  const notice = changed || notices.find(value => value.source) || notices[0];
  if (!notice || changed && !locator.textEnabled || !changed && (!notice.source || !model)) return;
  const request = { ...data, notice, kind: changed ? kind : 'font' };
  const prepared = notice.source && model ? locator.reviewItems({ ...data, request,
    source: notice.source.index.source, version: notice.source.index.version }) : { items: [] };
  const item = candidateId ? prepared.items.find(item => item.id === candidateId)
    : request.kind === 'font' ? prepared.focus : prepared.selection;
  if (notice.source && model && !item) return;
  if (item) request.focusId = item.id;
  dismissed = null;
  if (nativeEditor && data.side === 'html')
    return item && host.showHover(review, { editor, model, documentModel: editor.document, snapshot: editor.document.snapshot }, item, prepared.items, notice.source);
  if (!notice.source || !model) return host.showNotice({
    title: 'PDF 文字差异', message: '文字不一致', comparison: comparisonRows(notice, false), anchor: data.anchor,
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
  const anchor = item && side === 'pdf' && locator.reviewAnchor(item) || requested;
  const destination = side === 'pdf' ? reader : source, pdfViewer = viewer();
  return {
    side, switchable: split, switchLabel: side === 'pdf' ? '查看HTML' : '查看PDF', host: destination.ReplacementReview, window: destination,
    container: pdfViewer?.container, eventBus: pdfViewer?.eventBus, anchor,
    highlights: side === 'pdf' ? [anchor,
      ...(context.highlightedItems || []).map(value => value !== item && locator.reviewAnchor(value))
    ].filter(Boolean) : []
  };
}
function content(state, item) {
  const { documentModel } = state.context, edits = item?.options[0].edits || [], data = locator.reviewLists.get(state.items);
  const message = item?.missing ? 'PDF OCR 缺少相关文字。' : item?.font ? fontSummary(item.formats || [item])
    : item ? '文字不一致' : state.items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。';
  return {
    message, edits: data?.groups.get(item)?.edits, allEdits: data?.edits,
    all: data?.partial ? false : undefined,
    comparison: item?.font ? ['htmlFont', 'font'].map((field, i) => ({ label: i ? 'PDF' : 'HTML', parts: [{ text: fontSummary(item.formats, field) }] }))
      : comparisonRows(item?.comparison, !item?.selection, item?.missing),
    previewDecorations: item?.font || item?.missing ? item.previewDecorations ||= (data?.index || item.pdfSource?.index || locator.index).sourceSegments(item.sourceStart, item.sourceEnd, true).map(segment => ({
      range: documentModel.rangeAt(segment.start, segment.end), options: { inlineClassName: item.missing ? 'mew-review-proposed' : 'mew-review-format', stickiness: 1 }
    })) : [],
    apply: !!edits.length,
    range: item?.range || (edits.length ? documentModel.rangeAt(Math.min(...edits.map(edit => edit.start)), Math.max(...edits.map(edit => edit.end))) : null),
    options: [], applyLabel: item?.font ? '替换格式' : '替换', advance: false, expanded: false
  };
}
function matchingItems(item, context, items) {
  if (!item) return [];
  const data = locator.reviewLists.get(items);
  if (data) return (data.groups?.get(item) || data.groups?.get(locator.pattern(item, data.index)))?.items || [];
  const key = locator.pattern(item);
  return items.filter(value => locator.pattern(value) === key);
}
function apply(state, all) {
  const item = state.items[state.position], { editor, documentModel, source } = state.context;
  const data = locator.reviewLists.get(state.items), index = data?.index || locator.index;
  const offset = index.starts[item.sourceStart] ?? source.length;
  if (index !== locator.editorSourceIndex(documentModel)) return { offset };
  if (all && data?.partial) throw new Error('完整差异队列仍在准备，请稍后替换全部');
  const selected = all ? state.items : matchingItems(item, state.context, state.items), candidates = new Set(selected);
  if (!all && item.font) for (const candidate of state.items)
    if (candidate.font && selected.some(value => value.font && candidate.sourceStart < value.sourceEnd && candidate.sourceEnd > value.sourceStart))
      candidates.add(candidate);
  const edits = documentModel.validateEdits((candidates.size === selected.length && locator.reviewLists.get(selected)?.edits)
    || [...candidates].flatMap(value => value.options[0].edits));
  const position = state.items.findIndex((value, at) => at > state.position && !candidates.has(value));
  const first = state.items.findIndex(value => candidates.has(value)), last = state.items.findLastIndex(value => candidates.has(value));
  return { position: position < 0 ? state.items.length : position, priority: last - first + 1 === candidates.size,
    apply: () => documentModel.applyEdits(edits, { editor }),
    offset: offset + edits.reduce((delta, edit) => delta + (edit.end <= offset
      ? edit.text.length - (edit.end - edit.start) : 0), 0) };
}

const review = {
  compact: true, content, apply, presentation, matchingItems,
  isCurrent: ({ source, ...context }) => (source === undefined || source === context.model.getValue()) && !!locator.prepareReview(context),
  available: editor => !editor || !!locator.prepareReview({ editor }),
  focusIndex(items, request) {
    const offset = request?.notice?.source?.start, text = this.id === 'pdf-ocr';
    if (offset === undefined) return -1;
    const found = items.findIndex(item => text ? !!item.font === (request?.kind === 'font')
      && (item.sourceEnd > offset || item.sourceStart >= offset) : item.sourceEnd > offset);
    return text && found < 0 ? items.length - 1 : found;
  },
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
    context.highlightedItems = matchingItems(item, context, items);
    selection()?.showReviewPointer(context.editor, context.highlightedItems);
  },
  onClose(context) {
    delete context.highlightedItems;
    context.editor.getDomNode()?.classList.remove('mew-review-preview');
    selection()?.clearReviewPointer(context.editor);
  }
};
function onSources(event) {
  if (selection()?.selectionEnabled === false) return;
  const fontStyles = activeFontStyles();
  const { editor, targets, enabled: highlighted } = event.detail;
  const index = editor?.createDecorationsCollection && locator.prepareReview({ editor });
  if (!index) return;
  index.targets = targets;
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
        const items = noticeData ? locator.reviewItems({ request: { notice: { ...noticeData,
          source: { index: locator.index, start: noticeData.start, end: noticeData.end } } } }).items : locator.reviewItems().items;
        const item = items.find(item => item.id === request.id);
        if (!item) return;
        const reader = readerWindow() || window, notice = { ...item.comparison, source: { index: locator.index, start: item.sourceStart, end: item.sourceEnd } };
        if (request.save) {
          await apply({ items, position: items.indexOf(item), context: { editor, model, documentModel: editor.document, snapshot: editor.document.snapshot, source: model.getValue(), version: request.version } }, false).apply?.();
          return controller.save({ followPdf: false, model });
        }
        reader.dispatchEvent(new reader.CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf: viewer()?.pdfDocument, notices: [notice], targets: locator.index.targets,
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
  window.PdfReviewProvider = {
    PdfLocator, locator, highlights,
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
    ...review, locator, id, label,
    isEnabled: () => key === 'text' ? locator.textEnabled : activeFontStyles().includes(key),
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
  let previousPdf = viewer()?.pdfDocument, previousApi = selection(), previousEnabled, previousFonts = activeFontStyles();
  const poll = nativeEditor ? null : setInterval(() => {
    bind();
    const pdf = viewer()?.pdfDocument, api = selection(), fonts = activeFontStyles(), state = `${api?.enabled}:${api?.sourceEnabled}:${api?.selectionEnabled}:${fonts}`;
    if (previousPdf !== pdf || previousFonts !== fonts) {
      const fontsChanged = previousFonts !== fonts;
      previousPdf = pdf; previousFonts = fonts;
      for (const id of reviewIds) host.invalidate(id, context => fontsChanged || context.pdf !== pdf);
    }
    if (previousApi !== api || previousEnabled !== state) {
      previousApi = api; previousEnabled = state; host.refreshMenu();
    }
  }, 500);
  window.addEventListener('pagehide', () => { clearInterval(poll); bind(null); highlights.dispose(); window.removeEventListener('replacement-review-closed', onReviewClosed); unregister.forEach(dispose => dispose()); });
  return window.PdfReviewProvider;
})();
