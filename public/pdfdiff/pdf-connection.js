import { diffIndex, fontKeys, textDiff, localTextDiff, extendPageRange, changedRange, normalized, lowerBound, significantText, findMatches, mapDiffRange, forwardRangeKeys, reverseRangeKeys } from './pdf-selection-diff.js';
const covers = (range, start, end, [begin, stop] = forwardRangeKeys) => range[begin] <= start && range[stop] >= end;
const overlaps = (range, start, end, [begin, stop] = forwardRangeKeys) => range[begin] < end && range[stop] > start;

const lineStart = (raw, at) => raw.lastIndexOf('\n', at - 1) + 1;
const letters = text => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

function documentIndex(documents, pdf, numbers) {
  const index = documents?.get(pdf)?.get(numbers ? `pages:${numbers.join(',')}` : '');
  return index?.normalized ? index : undefined;
}
function matchingPage(index, target) {
  if (!index?.pages?.length || !target?.layer) return;
  const number = Number(target.layer.closest('.page')?.dataset.pageNumber);
  const page = index.pages.find(entry => entry.number === number);
  if (page && index.raw.slice(page.start, page.end) === target.raw) return page;
}
function connectionBounds(ranges, reverse = false) {
  const [start, end] = reverse ? reverseRangeKeys : forwardRangeKeys;
  const bounds = { start: Infinity, end: -Infinity };
  for (const range of ranges) {
    bounds.start = Math.min(bounds.start, range[start]); bounds.end = Math.max(bounds.end, range[end]);
  }
  return bounds;
}

function* connectionGaps(ordered, at, end = at, reverse = false) {
  const [start, stop] = reverse ? reverseRangeKeys : forwardRangeKeys;
  for (const next of ordered) {
    if (at < next[start]) yield [at, next[start], next];
    at = Math.max(at, next[stop]);
  }
  if (at < end) yield [at, end];
}

function normalizedRange(index, start, end, base = 0) {
  return start === 0 && end === index.raw.length ? index.normalized : normalized(index.raw.slice(start, end), undefined, base);
}

function compact(view) {
  const text = [], starts = [], ends = [];
  for (let i = 0; i < view.text.length; i++) if (!/[\s\-\u00ad\u2010\u2011]/u.test(view.text[i])) {
    text.push(view.text[i]); starts.push(view.starts[i]); ends.push(view.ends[i]);
  }
  return { text: text.join(''), starts, ends };
}
const noConnections = Object.freeze([]);
const sourceOrder = (a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd;
const shiftRanges = (ranges, offset, move = (range, start, end) => ({ ...range, start, end })) =>
  ranges.flatMap(range => move(range, range.start + offset, range.end + offset));
class PdfConnections {
  connections = new WeakMap();
  prepared = null;
  constructor({ environment, documents, document, pdf, options }, values) {
    if (typeof values === 'string') values = new window.MewEditorCore.DocumentModel({ text: values });
    Object.assign(this, { environment, documents, document, pdf, options }, values?.parse?.(document) ?? values);
    if (this.normalized !== null) this.normalized ||= normalized(this.raw);
  }
  get pairs() { return this.prepared?.pairs || []; }
  get #fullIndex() { return documentIndex(this.documents, this.pdf, this.environment.getSourcePages?.()); }
  targetConnections(target, prepared = true) {
    const ranges = value => {
      const state = this.connections.get(value);
      return prepared && state?.preparedRanges || state?.ranges || noConnections;
    };
    return Array.isArray(target) ? target.filter(Boolean).sort((left, right) => Number(Boolean(left.pages))
      - Number(Boolean(right.pages)) || Number(Boolean(right.layer)) - Number(Boolean(left.layer))).flatMap(ranges) : ranges(target);
  }
  get textVersion() { return this.version ?? this.formats; }
  get fontsCurrent() {
    const inputs = this.prepared?.fonts;
    return !!inputs && this.prepared.pages.every((page, i) => page.parts === inputs[i].parts
      && page.pages === inputs[i].pages && page.fontVersion === inputs[i].fontVersion);
  }
  entry(start, end, marked, text = this.raw.slice(start, end), page) {
    return { index: this, start, end, marked, text,
      before: this.raw.slice(Math.max(page?.start ?? 0, start - 160), start),
      after: this.raw.slice(end, Math.min(page?.end ?? this.raw.length, end + 160)) };
  }
  candidateEntry(item, marked = true) {
    const entry = item.pdfSource || this.entry(item.sourceStart, item.sourceEnd, marked);
    entry.difference ||= item.comparison || item.font && { html: item.text, pdf: item.text, fonts: [item.font] };
    return entry;
  }
  fontRuns(start = 0, end = this.raw.length, nodes = false) {
    const runs = [];
    const first = this.parts && Math.min(this.parts.length - 1, lowerBound(this.parts, start + 1, part => part.end));
    const parts = this.parts ? this.parts.slice(first, (start === end ? first : lowerBound(this.parts, end, part => part.end)) + 1)
      : this.pages?.slice(lowerBound(this.pages, start + 1, page => page.end), lowerBound(this.pages, end, page => page.start))
        .flatMap(({ parts }) => nodes ? parts : parts.slice(lowerBound(parts, start + 1, part => part.end),
          lowerBound(parts, end, part => part.start))) || [];
    if (nodes) return parts;
    for (const part of parts) {
      const a = Math.max(start, part.start), b = Math.min(end, part.end);
      if (a >= b || !this.raw.slice(a, b).trim()) continue;
      const style = part.font || { name: '', italic: null, bold: null }, last = runs.at(-1);
      if (last && last.italic === style.italic && last.bold === style.bold && last.name === style.name
        && !this.raw.slice(last.end, a).trim()) last.end = b;
      else runs.push({ ...style, start: a, end: b });
    }
    return runs;
  }
  fontEdits(start, end, font) {
    while (start < end && /\s/u.test(this.raw[start])) start++;
    while (end > start && /\s/u.test(this.raw[end - 1])) end--;
    if (start >= end) return [];
    const sourceStart = this.starts[start], sourceEnd = this.ends[end - 1];
    const styles = this.formats.slice(start, end), keys = ['italic', 'bold'].filter(key => typeof font[key] === 'boolean'
      && styles.some((style, i) => !/\s/u.test(this.raw[start + i])
        && (style[key] !== font[key] || !font[key] && style.tags?.some(tag => typeof tag[key] === 'boolean'))));
    if (!keys.length) return [];
    const tags = [...new Set(styles.flatMap(style => style.tags || []))]
      .filter(tag => keys.some(key => typeof tag[key] === 'boolean'))
      .sort((a, b) => a.start - b.start);
    if (tags.some(tag => tag.fontCloseStart === undefined || !['i', 'em', 'b', 'strong', 'span'].includes(tag.name))) return [];
    // Move adjacent boundaries when adding a single format to unwrapped text.
    if (!tags.length && keys.length === 1 && font[keys[0]]) {
      const opening = keys[0] === 'italic' ? /^<(i|em)>$/i : /^<(b|strong)>$/i;
      const adjacent = before => {
        let at = before ? start - 1 : end;
        while (at >= 0 && at < this.raw.length && /[^\S\r\n]/u.test(this.raw[at])) at += before ? -1 : 1;
        return this.formats[at]?.tags?.findLast(tag => tag[keys[0]] === true
          && opening.test(tag.open)
          && tag.fontCloseStart !== undefined && (before ? tag.rawEnd <= start : tag.rawStart >= end)
          && /^[^\S\r\n]*$/u.test(this.source.slice(before ? tag.closeEnd : sourceEnd,
            before ? sourceStart : tag.start)));
      };
      const left = adjacent(true);
      let right = adjacent(false);
      if (left && right && right.open !== left.open) right = null;
      if (left || right) {
        const a = left ? left.fontCloseStart : sourceStart, b = right ? right.openEnd : sourceEnd;
        const text = (left ? this.source.slice(left.closeEnd, sourceStart) : right.open)
          + this.source.slice(sourceStart, sourceEnd)
          + (right ? this.source.slice(sourceEnd, right.start) : left.closing);
        return [{ start: a, end: b, expected: this.source.slice(a, b), text }];
      }
    }
    let a = sourceStart, b = sourceEnd;
    const boundaries = [];
    // Include complete wrappers, including whitespace at their edges.
    for (const tag of tags) {
      if (!this.raw.slice(tag.rawStart, start).trim()) a = Math.min(a, tag.start);
      if (!this.raw.slice(end, tag.rawEnd).trim()) b = Math.max(b, tag.closeEnd);
      boundaries.push([tag.start, tag.openEnd, ''], [tag.fontCloseStart, tag.closeEnd, '']);
    }
    const wrap = keys.filter(key => font[key]).map(key => key === 'italic' ? 'i' : 'b');
    boundaries.push([sourceStart, sourceStart, [...wrap].reverse().map(name => '<' + name + '>').join('')],
      [sourceEnd, sourceEnd, wrap.map(name => '</' + name + '>').join('')]);
    boundaries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cursor = a, text = '', left = '', right = '';
    for (const [from, to, replacement] of boundaries) {
      if (from < cursor || to > b) continue;
      text += this.source.slice(cursor, from) + replacement;
      cursor = to;
    }
    text += this.source.slice(cursor, b);
    for (const tag of tags) {
      if (tag.start < a) left = tag.closing + left;
      if (tag.closeEnd > b) right += tag.open;
    }
    if (left) { const space = this.source.slice(0, a).match(/\s*$/u)[0]; a -= space.length; text = left + space + text; }
    if (right) { const space = this.source.slice(b).match(/^\s*/u)[0]; b += space.length; text += space + right; }
    return [{ start: a, end: b, expected: this.source.slice(a, b), text }];
  }
  sourceSegments(start, end, includeWhitespace = false) {
    const segments = [];
    for (let at = start; at < end; at++) {
      const a = this.starts[at], b = this.ends[at], last = segments.at(-1);
      const text = this.source?.slice(a, b);
      if (/^</.test(text) || !includeWhitespace && /^\s*$/.test(text)) continue;
      if (last && a <= last.end) last.end = Math.max(last.end, b);
      else segments.push({ start: a, end: b });
    }
    if (segments.length) return segments;
    let offset = this.starts[start] ?? this.ends[start - 1] ?? 0;
    const body = this.tags?.pairs.find(tag => tag.name === 'body');
    if (body) offset = Math.max(body.openEnd, Math.min(body.closeStart, offset));
    return [{ start: offset, end: offset }];
  }
  textEdits(start, end, replacement) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start
      || end > this.raw.length || typeof replacement !== 'string') throw new Error('无效的可见文字替换范围');
    return this.sourceSegments(start, end, !this.raw.slice(start, end).trim() && !replacement.trim())
      .map((segment, i) => ({ ...segment,
        text: i ? '' : replacement.replace(/[&<>]/g, char => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'),
        expected: this.source.slice(segment.start, segment.end) }));
  }
  // Compare this snapshot; the caller selects the current editor index explicitly.
  getDifferences(pages = []) {
    const prepared = this.connect(pages);
    if (!prepared.differences || !this.fontsCurrent) {
      const fontSpans = [], items = this.candidates(prepared.pages, prepared.pairs, false, { fontSpans });
      prepared.differences = { index: this, connections: prepared.pairs, items, fontSpans: fontSpans.sort(sourceOrder) };
      prepared.fonts = prepared.pages.map(({ parts, pages, fontVersion }) => ({ parts, pages, fontVersion }));
    }
    return prepared.differences;
  }
  inherit(previous) {
    if (this.change) return;
    const unchanged = previous.raw === this.raw;
    const { start, oldEnd, newEnd } = changedRange(previous.raw, this.raw);
    this.change = { start, oldEnd, newEnd, before: previous.raw };
    const change = newEnd - oldEnd, insertion = start === oldEnd;
    const shift = (a, b) => b <= start ? 0 : a >= oldEnd ? change : null;
    const full = this.#fullIndex || this.prepared?.full;
    for (const page of new Set([full, ...(this.environment.getTargets?.() || [])])) {
      if (!page) continue;
      let state = this.connections.get(page);
      if (!state) this.connections.set(page, state = {});
      const cached = previous.connections.get(page), reverse = page.connections.get(previous);
      if (reverse) {
        const ranges = [];
        for (const item of reverse.ranges || noConnections) {
          const delta = shift(item.targetStart, item.targetEnd);
          if (delta !== null) ranges.push(Object.assign(item.copy(this, delta, true), { gap: undefined }));
        }
        if (ranges.length || unchanged && reverse.scope !== undefined)
          page.connections.set(this, { ...(unchanged ? reverse : {}), ranges: ranges.length ? ranges : undefined });
      }

      if (!cached) continue;
      const { ranges: live = noConnections, preparedRanges: prepared, scope } = cached;
      const migrated = scope && prepared && prepared !== live ? new Map() : null;
      for (const items of migrated ? [live, prepared] : [live]) {
        const isLive = items === live, retained = [];
        for (const item of items) {
          let kept = isLive ? undefined : migrated.get(item);
          if (kept === undefined) {
            const delta = insertion && item.start < start && item.end === start ? null : shift(item.start, item.end);
            kept = delta === null ? null : Object.assign(item.copy(this, delta), { gap: undefined });
            if (kept?.editorDiff?.fontContext && kept.comparisonVersion === previous.textVersion
              && this.formats?.slice(kept.start, kept.end).every((style, i, styles) => {
                const old = previous.formats[item.start + i];
                const sameRun = !i || (style === styles[i - 1]) === (old === previous.formats[item.start + i - 1]);
                return sameRun && style.italic === old.italic && style.bold === old.bold
                  && style.name === old.name && style.definition?.open === old.definition?.open;
              })) kept.comparisonVersion = this.textVersion;
            if (!kept && covers(item, start, oldEnd)) {
              if (!item.editorDiff && previous.pairs.includes(item)) previous.compare(item, true);
              const diff = item.editorDiff;
              if (diff && diff.reliable !== false) {
                const tailEnd = item.start + (diff.parts?.findLast(part => part.pdf.trim())?.end ?? item.end - item.start);
                kept = this.remember(item.start, (tailEnd >= oldEnd ? tailEnd : item.end) + change, page, item.targetStart, item.targetEnd,
                  { previous: item, change: { start: start - item.start, newEnd: newEnd - item.start, previous: diff } });
              }
            }
            if (isLive) migrated?.set(item, kept ?? null);
          }
          if (kept) retained.push(kept);
        }
        if (!isLive || retained.length) state[isLive ? 'ranges' : 'preparedRanges'] = retained;
        if (!isLive || !scope) break;
        const delta = shift(scope.start, scope.end);
        const coversEdit = retained.length && retained.length === live.length && covers(scope, start, oldEnd);
        if (delta === null && !(coversEdit && (prepared === live || migrated && prepared.every(item => migrated.has(item))))) break;
        Object.assign(state, { prepared: cached.prepared, scope: { start: scope.start + (delta ?? 0), end: scope.end + (delta ?? change) } });
        if (!migrated) state.preparedRanges = prepared === live ? retained : undefined;
      }
    }
  }
  connect(pages = []) {
    if (!Array.isArray(pages)) return this.#connectPage(pages);
    const prior = this.prepared, full = this.#fullIndex || prior?.full;
    const targets = new Set([full, ...pages, ...(this.environment.getTargets?.() || [])].filter(Boolean));
    if (prior && prior.pdf === this.pdf && prior.full === full
      && prior.pages.length === targets.size && prior.pages.every((page, i) => targets.has(page) && this.targetConnections(page) === prior.connections[i])) return prior;

    for (const page of targets) {
      if (page === prior?.full) continue;
      if (page === full && !full.sourcePages) full.#connectPage(this);
      const entry = matchingPage(full, page), projected = entry && full.sourcePages?.length > 1 ? new Set() : null;
      for (const pair of entry ? this.targetConnections(full) : noConnections) {
        const from = Math.max(entry.start, pair.targetStart), to = Math.min(entry.end, pair.targetEnd);
        if (from >= to) continue;
        const hit = from === pair.targetStart && to === pair.targetEnd ? pair : this.range(full, from, to, true, pair);
        const mapping = hit && this.remember(hit.start, hit.end, page, from - entry.start, to - entry.start, hit === pair && { connection: pair });
        if (mapping) projected?.add(mapping);
      }
      if (!projected?.size) { this.#connectPage(page); continue; }
      const state = this.connections.get(page), ranges = state.ranges.filter(item => projected.has(item));
      Object.assign(state, { prepared: true, preparedRanges: ranges, scope: connectionBounds(ranges) });
    }
    const allPages = [...targets], pairs = this.targetConnections(allPages);
    const connections = allPages.map(page => {
      const state = this.connections.get(page);
      if (!page.pages && state) for (const ranges of new Set([state.ranges, state.preparedRanges])) {
        if (!ranges?.length) continue;
        const kept = ranges.filter(item => !pairs.some(other => other.target !== page && !other.target.pages
          && (other.start < item.start || other.end > item.end) && covers(other, item.start, item.end)));
        if (kept.length !== ranges.length)
          for (const key of ['ranges', 'preparedRanges']) if (state[key] === ranges) state[key] = kept;
      }
      return this.targetConnections(page);
    });
    return this.prepared = { pdf: this.pdf, full, pages: allPages, connections, pairs };
  }
  #connectPage(page) {
    const state = this.connections.get(page) || this.connections.set(page, {}).get(page);
    if (state.prepared) return state.scope;
    const pageEnd = page.raw.length;
    const pageCount = page.sourcePages?.length, partial = page.layer && this.environment.getSourcePages?.()?.length > 1;
    const multiPage = pageCount > 1;
    const horizontal = page.horizontal || page.pages?.some(entry => entry.horizontal), recover = !!(pageCount || page.layer);
    // Use detected passages as boundaries, since physical page turns can split words.
    const blocks = page.pages?.some(entry => entry.breaks?.length) ? page.pages.flatMap(p => [p.start, ...(p.breaks || []), p.end])
      : (page.layer || horizontal) && page.breaks?.length ? [0, ...page.breaks, pageEnd] : null;
    const reverse = page.targetConnections(this, false);
    for (const pair of reverse)
      this.remember(pair.targetStart, pair.targetEnd, page, pair.start, pair.end, { connection: pair, reverse: true });
    let scope = reverse.some(pair => pair.start === 0 && pair.end === pageEnd)
      ? connectionBounds(reverse, true) : state.ranges?.find(item => item.targetStart === 0 && item.targetEnd === pageEnd);
    if (!blocks && !partial && recover) scope ||= this.remember(0, this.raw.length, page, 0, pageEnd, { recover });
    const [hit, duplicate] = scope || blocks ? noConnections : this.matches([page.raw], undefined, { limit: 2 });
    if (hit && !duplicate) scope = this.remember(hit.start, hit.end, page, 0, pageEnd) || hit;

    const sourceBegin = this.raw.length - this.raw.trimStart().length;
    const pdf = page.normalized, html = this.normalized;
    const word = blocks ? null : undefined;
    let previous;
    for (const range of scope ? noConnections : this.matches([pdf.text], html, { page, blocks, contextual: horizontal, align: true })) {
      const { block, begin, stop } = range;
      const text = pdf.text.slice(begin, stop);
      const blockStart = blocks?.[block], blockEnd = blocks?.[block + 1];
      let [pdfStart, htmlStart] = extendPageRange(text, html.text, range.at - begin, range.start, -1, false, word);
      let [pdfStop, htmlStop] = extendPageRange(text, html.text, range.targetEnd - begin, range.end, 1, false, word);
      pdfStart += begin;
      pdfStop += begin;
      const pdfLine = lineStart(page.raw, pdf.starts[pdfStart]);
      const pdfLead = Math.max(begin, lowerBound(pdf.starts, pdfLine));
      const htmlLead = lowerBound(html.starts, lineStart(this.raw, html.starts[htmlStart]));
      const lead = pdfStart > pdfLead && pdfStart - pdfLead <= 32 && htmlStart - htmlLead <= 32
        ? html.text.slice(htmlLead, htmlStart) : '';
      if ((/\p{L}/u.test(lead) || /\p{N}/u.test(lead) && !/\p{L}/u.test(pdf.text.slice(pdfLead, pdfStart)))
        && !/[\r\n]/.test(page.raw.slice(pdf.starts[pdfStart], pdf.ends[pdfStart]) + this.raw.slice(html.starts[htmlStart], html.ends[htmlStart])))
        [pdfStart, htmlStart] = [pdfLead, htmlLead];
      if (!blocks && multiPage && /\p{L}/u.test(pdf.text[pdfStop] || '') && /\p{L}/u.test(html.text[htmlStop] || '')) {
        const pdfNextLine = lineStart(page.raw, pdf.starts[pdfStop]), htmlNextLine = lineStart(this.raw, html.starts[htmlStop]);
        if (pdfNextLine > pdf.starts[range.targetEnd - 1] && htmlNextLine > html.starts[range.end - 1]
          && !/\p{L}{2}/u.test(page.raw.slice(pdfNextLine, pdf.ends[pdfStop - 1]) + ' ' + this.raw.slice(htmlNextLine, html.ends[htmlStop - 1])))
          [pdfStop, htmlStop] = [lowerBound(pdf.starts, pdfNextLine - 1), lowerBound(html.starts, htmlNextLine - 1)];
      }
      let start = html.starts[htmlStart], end = html.ends[htmlStop - 1];
      let targetStart = pdf.starts[pdfStart], targetEnd = pdf.ends[pdfStop - 1];
      for (const leading of blocks ? [true, false] : noConnections) {
        const edge = leading ? Math.max(blockStart, pdfLine) : blockEnd;
        const lineEnd = leading ? -1 : page.raw.indexOf('\n', targetEnd), bound = lineEnd < 0 ? edge : Math.min(lineEnd, edge);
        const fragment = leading ? significantText(page.raw.slice(bound, targetStart))
          : bound - targetEnd <= 48 ? letters(page.raw.slice(targetEnd, bound)) : null;
        if (fragment === null || leading && (!fragment || fragment.length > 32)) continue;
        const first = leading ? Math.max(0, htmlStart - fragment.length - 8) : end;
        const stop = leading ? htmlStart : Math.min(this.raw.length, end + 49);
        let limit = Math.max(Number(leading), Math.floor(fragment.length / 4));
        for (const { index } of (leading ? html.text : this.raw).slice(first, stop).matchAll(leading ? /./gs : /\s+|$/gu)) {
          const at = first + index;
          if (leading ? Math.abs(stop - at - fragment.length) > 4 && html.text[at] !== ' '
            : !(at < stop || at === this.raw.length)) continue;
          const text = leading ? significantText(html.text.slice(at, stop)) : letters(this.raw.slice(first, at));
          const { distance } = textDiff(text, fragment, false, limit);
          if (distance > limit) continue;
          if (leading) [start, targetStart] = [html.starts[at], bound];
          else [end, targetEnd] = [at, bound];
          if (!distance) break;
          limit = distance - 1;
        }
      }
      if (horizontal && blockEnd - targetEnd <= 48) {
        const tail = page.raw.slice(targetEnd, blockEnd).trimEnd();
        const continuation = /^[^\S\r\n]*\r?\n([^\r\n]+)$/u.exec(tail);
        if (continuation) {
          const text = ' ' + normalized(continuation[1]).text.trim();
          const next = normalized(this.raw.slice(end, end + 49), undefined, end);
          if (next.text.startsWith(text) && !/[\p{L}\p{M}\p{N}]/u.test(next.text[text.length] || ''))
            [end, targetEnd] = [next.ends[text.length - 1], targetEnd + tail.length];
        }
      }
      const sourceEnd = previous?.end ?? sourceBegin, pdfEnd = previous?.targetEnd ?? 0;
      const gap = !blocks && !partial && (previous ? start > sourceEnd && targetStart > pdfEnd : pageCount && start <= 2048)
        && this.remember(sourceEnd, start, page, pdfEnd, targetStart, { recover });
      const next = this.remember(start, end, page, targetStart, targetEnd, { adjacent: previous, blockStart });
      if (!recover && gap === null && next) previous.gap = { next, connection: null };
      previous = next;
    }
    if (!blocks && pageCount && previous) {
      let start = previous.end;
      if (multiPage) {
        const stop = previous.targetStart + /^\s*/u.exec(page.raw.slice(previous.targetStart))[0].length;
        for (const item of this.targetConnections(page, false)
          .filter(pair => !pair.recovered && pair.targetStart < previous.targetStart && pair.targetEnd <= stop)
          .sort((a, b) => a.start - b.start)) {
          if (item.start <= start) start = Math.max(start, item.end);
        }
      }
      if (this.raw.length - start <= 2048 && significantText(this.raw.slice(start)))
        this.remember(start, this.raw.trimEnd().length, page, previous.targetEnd, page.raw.trimEnd().length, { recover });
    }
    const pages = blocks || multiPage || partial ? page.pages || (blocks && [{ start: 0, end: pageEnd, breaks: page.breaks }]) : null;
    this.#recoverPageGaps(page, pages, sourceBegin);
    const ranges = state.ranges || noConnections;
    Object.assign(state, { prepared: true, preparedRanges: ranges,
      scope: ranges.length && (!scope || blocks) ? connectionBounds(ranges) : scope || null });
    return state.scope;
  }
  #recoverPageGaps(page, pages, sourceBegin) {
    const sourceGaps = () => connectionGaps(this.targetConnections(page, false).toSorted((a, b) => a.start - b.start), 0, this.raw.length);
    const gaps = [...sourceGaps()];
    let recovered = false;
    for (const [from, end, next] of gaps) {
      const start = Math.max(from, sourceBegin);
      if (!next || end <= start || end - start > 32) continue;
      const hit = page.search({ text: this.raw.slice(start, end), before: '',
        after: this.raw.slice(end, Math.min(next.end, end + 24))
      }, { start: Math.max(0, next.targetStart - (end - start) - 32), end: next.targetEnd });
      if (hit && hit.end <= next.targetStart && this.remember(start, end, page, hit)) recovered = true;
    }
    const byTarget = pages && gaps.length && this.targetConnections(page, false).toSorted((a, b) => a.targetStart - b.targetStart);
    if (!byTarget?.length) return;
    const stops = [];
    let first = 0, scanned = 0;
    for (const passage of pages) {
      while (byTarget[first]?.targetEnd <= passage.start) first++;
      const touching = byTarget.slice(first, lowerBound(byTarget, passage.end, item => item.targetStart));
      for (const [from, to] of connectionGaps(touching, touching[0]?.targetEnd ?? passage.breaks?.at(-1) ?? passage.end, passage.end, true)) {
        const raw = page.raw.slice(from, to), view = compact(normalized(raw, undefined, from));
        let last = 0;
        for (const mark of raw.matchAll(/[\r\n–—-]|$/gu)) {
          const stop = lowerBound(view.ends, from + mark.index + 1);
          if (stop === last) continue;
          last = stop;
          const end = view.ends[stop - 1], line = lineStart(page.raw, end);
          const label = line >= from && /^[^\S\r\n]*\S+[^\S\r\n]+/u.exec(page.raw.slice(line, end));
          stops.push({ from, view, length: stop, end, body: label ? lowerBound(view.starts, line + label[0].length) : -1 });
        }
      }
    }

    if (!stops.length) return;
    const lines = /\S[^\r\n]*/gu, proposed = [];
    for (const [from, to] of recovered ? sourceGaps() : gaps) {
      lines.lastIndex = Math.max(scanned, lineStart(this.raw, from));
      for (let line; (line = lines.exec(this.raw)) && line.index < to; scanned = lines.lastIndex) {
        const text = line[0].trimEnd(), end = line.index + text.length, space = text.search(/\s/u);
        if (line.index < from || end > to) continue;
        for (const bodyStart of space > 0 ? [line.index, line.index + space] : [line.index]) {
          const needle = normalized(this.raw.slice(bodyStart, end)).text.replace(/[\s\-\u00ad\u2010\u2011]/gu, '');
          if (needle.length < 8 || !/\p{L}.*\p{L}.*\p{L}/u.test(needle)) continue;
          let hit, best = Math.min(3, Math.floor(needle.length / 4));
          for (const stop of stops) {
            const suffix = stop.length - needle.length;
            const exact = suffix >= 0 && stop.view.text.startsWith(needle, suffix);
            const i = exact ? suffix : bodyStart > line.index ? stop.body : -1;
            if (i < 0) continue;
            const at = stop.view.starts[i];
            const distance = exact ? 0 : textDiff(needle, stop.view.text.slice(i, stop.length), false, best).distance;
            if (distance > best || /^\p{L}/u.test(needle) && /\p{L}/u.test(page.raw[at - 1] || '')) continue;
            hit = hit === undefined || distance < best ? { stop, at, start: line.index, end, bodyStart } : null;
            best = distance;
            if (best === 0 && hit === null) break;
          }
          if (hit === undefined) continue;
          if (hit) proposed.push(hit);
          break;
        }
      }
    }
    for (const [i, { stop, at, start, end, bodyStart }] of proposed.sort((a, b) => a.at - b.at).entries()) {
      const prior = proposed[i - 1], from = prior?.stop.view === stop.view ? prior.stop.end : stop.from;
      if (prior?.stop.end > at || proposed[i + 1]?.at < stop.end) continue;
      const label = bodyStart > start && /(?:^|\s)\S+\s*$/u.exec(page.raw.slice(from, at));
      this.remember(start, end, page, label ? at - label[0].trimStart().length : at, stop.end);
    }
  }
  get livePairs() { return this.targetConnections(this.prepared?.pages || [], false); }
  compare(connection, textOnly = false) {
    let diff = connection.editorDiff ??= textDiff(connection.html, connection.pdf, true, Infinity, true);
    diff.reliable ??= diff.distance <= 256 || !diff.parts.some(part => part.inconsistent
      && (significantText(part.html).length > 256 || significantText(part.pdf).length > 256));
    const target = connection.target, context = diff.fontContext, version = this.textVersion;
    if (textOnly || context && connection.comparisonVersion === version
      && target?.parts === context.parts && target?.pages === context.pages && target?.fontVersion === context.fontVersion)
      return diff.reliable ? diff : null;
    // A migrated text diff can be shared while its HTML formats have diverged.
    if (context && connection.comparisonVersion !== version)
      diff = connection.editorDiff = new diffIndex(diff.html, diff.pdf, diff.start, diff.targetStart, diff.changed, diff);
    if (!diff.reviewRanges) {
      const left = this.normalized, right = connection.target?.normalized;
      const h = connection.spans && lowerBound(left.starts, connection.start);
      const p = connection.spans && lowerBound(right.starts, connection.targetStart);
      const reversed = connection.reversedSpans;
      diff.reviewRanges = (connection.spans || diff.parts).flatMap(span => {
        if (!connection.spans) return span.inconsistent ? [span] : [];
        if (!span.changed) return [];
        const i = h + (reversed ? span.targetStart : span.start), j = p + (reversed ? span.start : span.targetStart);
        const a = left.starts[i] ?? left.ends.at(-1), x = right.starts[j] ?? right.ends.at(-1);
        const b = (reversed ? span.pdf : span.html).length, y = (reversed ? span.html : span.pdf).length;
        const html = this.raw.slice(a, b ? left.ends[i + b - 1] : a);
        const pdf = connection.target.raw.slice(x, y ? right.ends[j + y - 1] : x);
        return significantText(html) === significantText(pdf) ? []
          : [new diffIndex(html, pdf, a - connection.start, x - connection.targetStart, true)];
      });
    }
    const fonts = [], base = connection.start, targetBase = connection.targetStart;
    const runs = this.formats && target?.fontRuns(targetBase, connection.targetEnd);
    for (const part of runs?.length ? diff.parts : noConnections) {
      const start = base + part.start, left = targetBase + part.targetStart, right = targetBase + part.targetEnd;
      const from = lowerBound(runs, left + Number(left < right), font => font.end);
      const to = lowerBound(runs, right + Number(left === right), font => font.start);
      for (let i = from; i < to; i++) {
        let font = runs[i];
        if (part.changed) {
          font = { ...font, start: left, end: right };
          for (; ++i < to;) for (const key of fontKeys) if (runs[i][key] !== font[key]) font[key] = null;
        }
        if (fontKeys.every(key => typeof font[key] !== 'boolean')) continue;
        const end = part.changed ? base + part.end : start + Math.min(right, font.end) - left;
        let at = start + Math.max(left, font.start) - left;
        while (at < end) {
          const htmlFont = this.formats[at];
          let stop = at + 1;
          while (stop < end && this.formats[stop] === htmlFont) stop++;
          if (htmlFont && fontKeys.some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key])) {
            const text = this.raw.slice(at, stop).trimStart();
            const from = stop - text.length - base;
            if (text) fonts.push({ start: from, end: from + text.trimEnd().length, font });
          }
          at = stop;
        }
      }
    }
    diff.fontItems = fonts;
    connection.comparisonVersion = version;
    Object.defineProperty(diff, 'fontContext', { configurable: true, value:
      { parts: target?.parts, pages: target?.pages, fontVersion: target?.fontVersion } });
    return diff.reliable ? diff : null;
  }
  remember(start, end, target, targetStart, targetEnd, alignment) {
    if (targetStart && typeof targetStart === 'object') {
      alignment = targetEnd;
      ({ start: targetStart, end: targetEnd } = targetStart);
    }
    if (start > end || targetStart > targetEnd) return null;
    const { adjacent, blockStart, previous, connection: aligned, extend, recover, reverse, change } = alignment || {};
    if (adjacent) {
      const sourceGap = start - adjacent.end, pdfGap = targetStart - adjacent.targetEnd;
      const merge = blockStart === undefined ? (sourceGap < 0 ? pdfGap === 0 : pdfGap < 0)
        : adjacent.targetStart >= blockStart && adjacent.start <= start && adjacent.targetStart <= targetStart
          && Math.abs(sourceGap) <= 8 && Math.abs(pdfGap) <= 8;
      const joined = merge && this.remember(adjacent.start, Math.max(adjacent.end, end), target,
        adjacent.targetStart, Math.max(adjacent.targetEnd, targetEnd), { extend: adjacent });
      if (joined) return joined;
    }
    const state = this.connections.get(target) || {};
    const existing = state.ranges?.find(item => item.start === start && item.end === end
      && item.targetStart === targetStart && item.targetEnd === targetEnd);
    if (existing) {
      const at = extend && extend !== existing ? state.ranges.indexOf(extend) : -1;
      if (at >= 0) state.ranges.splice(at, 1);
      return existing;
    }
    let diff;
    if (!aligned) {
      const left = normalizedRange(this, start, end), right = normalizedRange(target, targetStart, targetEnd);
      const html = left.text, pdf = right.text;
      if (!html && !pdf) return null;
      diff = textDiff(html, pdf, true, !recover || Math.max(html.length, pdf.length) <= 128 ? Infinity : 128, recover);
      if (diff.distance > 128 && diff.parts.some(part => part.changed && Math.max(part.html.length, part.pdf.length) > 128)
        || recover && diff.distance > 32 && !diff.parts.some(part => !part.changed && /[\p{L}\p{N}]{2}/u.test(part.html))) {
        if (!recover) return null;
        const words = html.includes('...') || pdf.includes('...') ? /\S+?\.(?=\.|\s|$)|\S+\s*|\s+/gu : /\S+\s*|\s+/gu;
        const body = /[\p{L}\p{N}]{3}/u;
        for (const part of localTextDiff(html.match(words) || [], pdf.match(words) || [], true, 512, undefined, false).parts) {
          if (!body.test(part.html) || part.changed && !textDiff(part.html, part.pdf, true).parts
            .some(span => !span.changed && body.test(span.html))) continue;
          const [b, y] = extendPageRange(html, pdf, part.end, part.targetEnd, 1, false, /^[\p{L}\p{N}\p{Pd}.]{2}$/u);
          const kept = this.remember(start + left.starts[part.start], start + left.ends[b - 1], target,
            targetStart + right.starts[part.targetStart], targetStart + right.ends[y - 1]);
          if (kept) kept.recovered = true;
        }
        return null;
      }
    }
    const connection = extend || diffIndex.between(this, start, end, target, targetStart, targetEnd, previous);
    if (extend) {
      extend.editorDiff = extend.gap = extend.recovered = undefined;
      extend.append(this.raw.slice(extend.end, end), target.raw.slice(extend.targetEnd, targetEnd), end, targetEnd);
      extend.changed = extend.html !== extend.pdf;
    }
    Object.assign(connection, { distance: (aligned || diff).distance, spans: aligned ? aligned.spans : diff.parts,
      reversedSpans: !!aligned && !!aligned.reversedSpans !== !!reverse });
    if (previous?.editorDiff) {
      connection.editorDiff = textDiff(connection.html, connection.pdf, true, Infinity, true, change);
      this.compare(connection);
    }
    const ranges = state.ranges = (state.ranges === state.preparedRanges ? state.ranges?.slice() : state.ranges) || [];
    for (let i = ranges.length - 1; i >= 0; i--)
      if (ranges[i] === connection || ranges[i].start === start && ranges[i].end === end) ranges.splice(i, 1);
    ranges.unshift(connection);
    ranges.length = Math.min(ranges.length, Math.max(16, this.raw.length));
    this.connections.set(target, state);
    return connection;
  }
  range(target, start, end, reverse = false, connection, marked = false) {
    if (start > end) return null;
    const keys = reverse ? reverseRangeKeys : forwardRangeKeys, [begin, stop, mappedBegin, mappedEnd] = keys;
    const containing = item => covers(item, start, end, keys);
    let connections = connection ? noConnections : this.targetConnections(target, false);
    connection ||= start < end && connections.find(containing);
    if (!connection) {
      const ordered = start < end ? connections.toSorted((a, b) => a[begin] - b[begin]) : noConnections;
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1], b = ordered[i];
        if (a[stop] >= end || b[begin] <= Math.max(start, a[stop]) || a.end > b.start || a.targetEnd > b.targetStart
          || Math.max(b.start - a.end, b.targetStart - a.targetEnd) > 2048) continue;
        if (a.gap?.next !== b) a.gap = { next: b, connection: this.remember(a.end, b.start, target, a.targetEnd, b.targetStart) };
        if (a.gap.connection && containing(a.gap.connection)) connection = a.gap.connection;
      }
    }
    if (!connection) {
      if (target.normalized) this.#connectPage(target);
      connections = this.targetConnections(target, false).toSorted((a, b) => a[begin] - b[begin]).flatMap((b, i, ordered) => {
        const gap = ordered[i - 1]?.gap;
        return gap?.next === b && gap.connection ? [gap.connection, b] : [b];
      });
      connection = start < end && connections.find(containing);
    }
    let first = Infinity, last = -1, covered = start;
    for (const item of connection ? [connection] : connections) {
      if (!connection && !(start === end ? containing(item) : overlaps(item, start, end, keys))) continue;
      const diff = this.compare(item, true);
      if (!diff) continue;
      if (item[begin] > covered) return null;
      covered = Math.max(covered, item[stop]);
      const hit = mapDiffRange(diff, start - item[begin], end - item[begin], reverse, marked);
      if (!hit) continue;
      first = Math.min(first, item[mappedBegin] + hit.start);
      last = Math.max(last, item[mappedBegin] + hit.end);
      // An overlapping match may end here before the connection containing the insertion.
      if (start === end && last >= first) { connection = item; break; }
    }
    if (covered < end || last < first || last === first && reverse) return null;
    const source = (reverse ? target : this).raw.slice(start, end), destination = (reverse ? this : target).raw.slice(first, last);
    return { start: first, end: last, connection, approximate: source !== destination && significantText(source) !== significantText(destination) };
  }
  // Resolve either direction through the confirmed mapping and the same bounded search.
  locate(target, entry, reverse = false, scope, marked = false, { visiblePage = false } = {}) {
    const explicit = !visiblePage && entry.range, destination = reverse ? this : target;
    const mapped = !explicit && this.range(target, entry.start, entry.end, reverse, undefined, marked);
    if (visiblePage && !mapped) return null;
    if (mapped && (visiblePage && entry.text !== this.raw.slice(entry.start, entry.end)
      ? significantText(entry.text) === significantText(destination.raw.slice(mapped.start, mapped.end)) : !mapped.approximate)) return mapped;
    const hit = explicit || destination.search(entry, scope) || mapped;
    if (!hit || hit === mapped || visiblePage) return hit || null;
    return { ...hit, connection: reverse ? this.remember(hit.start, hit.end, target, entry.start, entry.end)
      : this.remember(entry.start, entry.end, target, hit) };
  }

  // The same confirmed edges locate missing text for the queue and for PDF selections.
  missingRange(target, start, end = start, record) {
    const prepared = this.prepared?.differences?.items?.missingRanges;
    const ranges = prepared?.index ? prepared : this.candidates([target], undefined, true).missingRanges;
    const { index } = ranges;
    if (start === undefined || !index) return ranges;
    const hit = record?.sourceStart !== undefined ? record : ranges.find(range => !range.resolved && range.sourceStart <= start && range.sourceEnd >= end);
    let anchor = hit?.anchor;
    if (!anchor && hit?.edge !== undefined) {
      const { edge } = hit, parts = ranges.parts ||= index.parts || index.pages?.flatMap(page => page.parts) || [];
      for (let i = edge ? lowerBound(parts, edge, part => part.start) - 1 : 0; parts[i]; i += edge ? -1 : 1) {
        const part = parts[i], text = index.raw.slice(part.start, Math.min(edge || part.end, part.end));
        if (!text.trim()) continue;
        const at = part.start + (edge ? text.trimEnd().length : text.length - text.trimStart().length);
        anchor = { start: at, end: at, endBias: edge > 0 };
        break;
      }
    }
    if (!anchor) return null;
    if (target === index) return { ...anchor };
    const page = matchingPage(index, target);
    return page && anchor.start >= page.start && anchor.end <= page.end && !(anchor.endBias && anchor.start === page.start)
      ? { ...anchor, start: anchor.start - page.start, end: anchor.end - page.start } : null;
  }
  candidates(targets = this.prepared?.pages || [], connections, missingOnly = false, { items: cached, fonts, fontSpans = fonts && [] } = {}) {
    connections ??= targets === this.prepared?.pages ? this.pairs : this.targetConnections(targets);
    const target = !cached && (missingOnly ? targets[0] : targets.find(page => page?.sourcePages?.length)
      || connections.find(connection => connection.target?.sourcePages?.length)?.target);
    const live = cached || connections.length ? connections : this.livePairs;
    const compared = live.length || !missingOnly ? live : this.targetConnections(target?.layer ? this.prepared?.full : target);
    const full = target?.layer ? this.prepared?.full || this.#fullIndex : target;
    const index = !target?.layer || matchingPage(full, target) ? full : undefined;
    const items = cached ?? [], ranges = [], edges = [], ordered = [];
    const collectFonts = fontSpans && connections.length;
    const addCandidate = item => {
      const { sourceStart: from, sourceEnd: end } = item;
      const at = lowerBound(items, from, item => item.sourceStart), next = items[at];
      if (!(items[at - 1]?.sourceEnd > from || next &&
        (end === from ? next.sourceStart === from : next.sourceStart < end && next.sourceEnd > from))) items.splice(at, 0, item);
    };
    const prepared = this.connections.get(target)?.prepared, number = /^[^\p{L}\d]*(\d+)[^\p{L}\d]*$/u;
    let gaps = missingOnly || prepared;
    const scanText = !cached && (!target || index);
    for (const connection of scanText ? compared : collectFonts ? connections : noConnections) {
      gaps ||= scanText && connections.length && connection.target === target && connection.recovered;
      const diff = this.compare(connection);
      if (!diff) continue;
      if (collectFonts) for (const part of diff.fontItems) fontSpans.push({
        sourceStart: connection.start + part.start, sourceEnd: connection.start + part.end, font: part.font });
      if (!scanText) continue;
      const base = !index || connection.target === index || connection.target?.layer && !index.pages?.length
        ? 0 : matchingPage(index, connection.target)?.start ?? null;
      let first, last;
      if (index && base !== null) ordered.push(connection);
      for (const { start, end, targetStart, sourceEdge, targetEdge, changed, pdf } of base === null ? noConnections : diff.parts) {
        if (sourceEdge > start && targetEdge > targetStart)
          edges.push({ sourceEnd: connection.start + sourceEdge, targetEnd: base + connection.targetStart + targetEdge });
        if (!diff.reviewRanges.length || changed || !/\p{L}/u.test(pdf)) continue;
        first ??= start;
        last = end;
      }
      review: for (const part of diff.reviewRanges) {
        const { html, pdf } = part, left = number.exec(html), right = number.exec(pdf), digits = left && right;
        const from = connection.start + part.start + (digits ? html.indexOf(left[1]) : 0);
        const end = from + (digits ? left[1] : html).length;
        const outside = base !== null && (first === undefined || part.end <= first || part.start >= last);
        const value = significantText(this.raw.slice(from, end));
        const insideWord = outside && connection.target.sourcePages?.length > 1 && /^\p{L}+$/u.test(value)
          && (from > connection.start && /\p{L}/u.test(this.raw[from - 1]) || end < connection.end && /\p{L}/u.test(this.raw[end]));
        const missing = outside && !insideWord && /[\p{L}\p{N}]/u.test(html) && (!pdf.trim() || /\p{L}/u.test(html) && !/\p{L}/u.test(pdf));
        if (missingOnly && !missing) continue;
        let owner;
        for (const other of value || !missing ? compared : noConnections) {
          if (other !== connection && !(covers(other, from, end) && (other.end > from || other.start === from))) continue;
          owner ??= other;
          if (!missing && owner !== connection || value && other !== connection &&
            this.range(other.target, from, end, false, other)?.approximate === false) continue review;
          if (!value) break;
        }
        if (missing) ranges.push({ sourceStart: from, sourceEnd: end });
        else {
          const comparison = digits ? { html: left[1], pdf: right[1] } : { html, pdf };
          const hunk = diff.hunks?.get(part.targetStart);
          if (hunk?.distance <= 128 && hunk.html === comparison.html && hunk.pdf === comparison.pdf)
            Object.defineProperty(comparison, 'comparisonDiff', { value: hunk, writable: true });
          addCandidate({ sourceStart: from, sourceEnd: end, comparison });
        }
      }
    }
    if (gaps && index) for (const [sourceStart, sourceEnd] of connectionGaps(ordered.sort((a, b) => a.start - b.start),
      this.raw.length - this.raw.trimStart().length, this.raw.trimEnd().length)) {
      const hit = prepared && this.range(target, sourceStart, sourceEnd, false, undefined, true);
      ranges.push({ sourceStart, sourceEnd, resolved: !!(hit && !hit.approximate && /[\p{L}\p{N}]/u.test(target.raw.slice(hit.start, hit.end))) });
    }
    edges.sort((a, b) => a.sourceEnd - b.sourceEnd);
    let at = 0, edge = edges.length ? 0 : undefined;
    for (const range of ranges.sort(sourceOrder)) {
      while (at < edges.length && edges[at].sourceEnd <= range.sourceStart) edge = edges[at++].targetEnd;
      range.edge = edge;
      const html = this.raw.slice(range.sourceStart, range.sourceEnd);
      if (range.resolved || !significantText(html)) continue;
      const [anchor, duplicate] = index?.matches([html], undefined, { limit: 2 }) || noConnections;
      // Comparison copies expose only the text used by review notices.
      Object.defineProperties(range, { anchor: { value: duplicate ? undefined : anchor, writable: true },
        sourceStart: { enumerable: false }, sourceEnd: { enumerable: false }, edge: { enumerable: false },
        resolved: { enumerable: false } });
      if (!missingOnly) addCandidate({ sourceStart: range.sourceStart, sourceEnd: range.sourceEnd, missing: true,
        comparison: Object.assign(range, { html, pdf: '' }) });
    }
    if (!cached) Object.defineProperty(items, 'missingRanges', { value: Object.assign(ranges, { index }) });
    return fonts ? this.fontCandidates(items, fontSpans.sort(sourceOrder), fonts, !!cached) : cached ? items.slice() : items;
  }
  fontCandidates(items, spans, fonts, copy = false) {
    if (!spans.length) return copy ? items.slice() : items;
    const absent = items.filter(item => item.missing).sort(sourceOrder);
    const disabled = fontKeys.filter(key => !fonts.includes(key));
    // Merge adjacent format changes, or bridge punctuation with the same mismatch.
    const candidates = [];
    let last, previous, nearby, missingAt = 0, missingEnd = -Infinity;
    for (const span of spans) {
      const { sourceStart, sourceEnd, font: pdfFont } = span;
      if (last?.sourceStart === sourceStart && last.sourceEnd === sourceEnd) continue;
      const htmlFont = this.formats[sourceStart];
      if (disabled.length && !fonts.some(key => typeof pdfFont[key] === 'boolean' && pdfFont[key] !== htmlFont[key])) continue;
      last = span;
      while (absent[missingAt]?.sourceStart <= sourceStart) missingEnd = Math.max(missingEnd, absent[missingAt++].sourceEnd);
      if (missingEnd > sourceStart || absent[missingAt]?.sourceStart < sourceEnd) continue;
      const font = { ...pdfFont };
      for (const key of disabled) font[key] = null;
      const gap = previous && this.raw.slice(previous.sourceEnd, sourceStart);
      const joins = previous && sourceStart >= previous.sourceEnd && !/[\r\n]/.test(gap)
        && previous.htmlFont.tags === htmlFont.tags
        && fontKeys.every(key => previous.font[key] === font[key] && previous.htmlFont[key] === htmlFont[key])
        && (!gap.trim() || !(/\s/u.test(gap) && /[\p{L}\p{N}]/u.test(gap)) && fontKeys.some(key =>
          typeof previous.font[key] === 'boolean'
          && this.formats.slice(previous.sourceEnd, sourceStart).every((style, i) =>
            /\s/u.test(gap[i]) || (style && style[key] !== previous.font[key]))));
      if (!joins) {
        nearby = items[lowerBound(items, sourceStart, range => range.sourceEnd)];
        candidates.push(previous = { sourceStart, sourceEnd, font, htmlFont, formats: [] });
      }
      previous.sourceEnd = sourceEnd;
      previous.formats.push({ font, htmlFont });
      previous.reviewStart = nearby?.sourceStart <= previous.sourceEnd ? nearby.sourceStart : previous.sourceStart;
    }
    if (!candidates.length) return copy || last ? items.slice() : items;
    return items.concat(candidates).sort((a, b) =>
      (a.reviewStart ?? a.sourceStart) - (b.reviewStart ?? b.sourceStart) || Number(!!a.font) - Number(!!b.font));
  }
  matches(queries, haystack = this.normalized, options = {}) {
    if (!options.sample && !options.align) return findMatches(this, queries, haystack, options);
    const { page, blocks, contextual = false, align = false, wholeWords = this.options?.wholeWords,
      sample = blocks ? contextual ? 12 : 16 : 24, step = align ? 8 : 0, anchors = align && !wholeWords } = options;
    const pdf = page?.normalized, connections = pdf && this.targetConnections(page, false);
    const matches = [], query = [''], exact = { anchors, wholeWords, limit: 2 };
    const useContext = blocks && contextual;
    const passages = blocks ? blocks.length - 1 : queries?.length ?? 1;
    let stop = blocks?.length ? lowerBound(pdf.starts, blocks[0]) : 0;
    for (let block = 0; block < passages; block++) {
      const passage = blocks || !queries ? pdf.text : queries[block];
      const begin = blocks ? stop : 0;
      stop = blocks ? lowerBound(pdf.starts, blocks[block + 1]) : passage.length;
      const span = stop - begin, last = span - sample;
      if (last < 0) continue;
      const shortContext = useContext && last >= 8 && span <= 32;
      const found = align ? [] : matches, first = found.length, scope = { block, begin, stop };
      for (let i = 0, count = step ? Math.ceil(last / step) : Math.min(last, 4); i <= count; i++) {
        const at = begin + (step ? Math.min(i * step, last) : Math.floor(last * i / (count || 1)));
        query[0] = passage.slice(at, at + sample);
        if (blocks && !/\p{L}{2}/u.test(query[0])) continue;
        const start = pdf?.starts[at], end = pdf?.ends[at + sample - 1];
        const pair = connections?.find(item => covers(item, start, end, reverseRangeKeys));
        let hit = pair && this.range(page, start, end, true, pair), duplicate;
        if (!hit || hit.approximate) [hit, duplicate] = findMatches(this, query, haystack, exact);
        if (duplicate) {
          if (!useContext) continue;
          const left = passage.slice(Math.max(begin, at - 32), at);
          const right = passage.slice(at + sample, Math.min(stop, at + sample + 32));
          const before = shortContext ? left : left.trim(), after = shortContext ? right : right.trim();
          if (!shortContext && before.length + after.length < sample) continue;
          hit = findMatches(this, query, haystack, { anchors, wholeWords, before, after, best: true, contextual: shortContext });
          if (hit?.approximate || !shortContext && !(hit?.score >= sample)) continue;
        }
        if (hit) found.push({ at, start: lowerBound(haystack.starts, hit.start),
          end: lowerBound(haystack.starts, hit.end), ...(blocks && { context: hit.score }), ...(blocks && !align && scope) });
      }
      const only = blocks && found.length === first + 1 && found[first];
      if (only) {
        query[0] = shortContext && only.context !== undefined
          ? passage.slice(begin, stop).trim() : passage.slice(only.at, only.at + sample);
        if (findMatches(page, query, pdf, { anchors: true }).length > 1) found.pop();
      }
      if (!align || !found.length) continue;

      let range;
      for (let i = 0, count = found.length - Number(!blocks); i < count;) {
        const anchor = found[i++], following = found[i] ?? anchor;
        const extraGap = following.start - anchor.start - (following.at - anchor.at);
        let nextIndex = i;
        if (blocks && extraGap > 32) for (let k = i + 1; found[k]?.at <= anchor.at + sample * 4; k++) {
          const start = found[k].start;
          if (start <= anchor.start || start >= following.start) continue;
          nextIndex = k;
          break;
        }
        const next = found[nextIndex] ?? anchor, end = next.end, targetEnd = next.at + sample;
        const length = targetEnd - anchor.at;
        if (length > 2048 || next !== anchor && next.start <= anchor.start) continue;
        const distanceFrom = (pdfStart, htmlStart, budget) =>
          textDiff(passage.slice(pdfStart, targetEnd), haystack.text.slice(htmlStart, end), false, budget).distance;
        const limit = Math.min(32, Math.max(12, Math.floor(length * .2)));
        const distance = distanceFrom(anchor.at, anchor.start, limit);
        if (distance > limit) continue;
        i = nextIndex;
        let merged = Infinity;
        if (range && range.targetEnd >= anchor.at && range.end >= anchor.start) {
          const budget = 128 - range.distance;
          const suffix = end >= range.end ? distanceFrom(range.targetEnd, range.end, budget) : Infinity;
          merged = suffix <= budget ? range.distance + suffix : distanceFrom(range.at, range.start, 128);
        }
        if (merged <= 128) Object.assign(range, { targetEnd, end, distance: merged });
        else matches.push(range = { ...anchor, ...scope, targetEnd, end, distance });
      }
    }
    return matches;
  }
  search(entry, scope = null) {
    const offset = scope?.start || 0, haystack = scope ? normalizedRange(this, offset, scope.end, offset) : this.normalized;
    const before = normalized(entry.before).text.trim(), after = normalized(entry.after).text.trim();
    return this.matches([entry.text], haystack, { before, after, best: true }) || this.matches([significantText(entry.text)],
      compact(haystack), { before: significantText(before), after: significantText(after), best: true });
  }
  locateSource(chunks) {
    const first = chunks[0], last = chunks.at(-1);
    const { items } = this.getDifferences(chunks.map(chunk => chunk.index)), { full } = this.prepared;
    const entry = first.index.entry(first.start, first.end, undefined,
      chunks.map(({ index, start, end }) => index.raw.slice(start, end)).join("\n"));
    entry.after = last.index.raw.slice(last.end, last.end + 160);
    const left = this.connections.get(first.index)?.scope, right = this.connections.get(last.index)?.scope;
    const scope = left && right && left.start <= right.start ? { start: left.start, end: right.end } : null;
    const from = matchingPage(full, first.index), to = matchingPage(full, last.index);
    const start = from && from.start + first.start, end = to && to.start + last.end;
    const mapped = from && to && start < end
      && (first === last || significantText(full.raw.slice(start, end)) === significantText(entry.text))
      && this.range(full, start, end, true, this.targetConnections(full).find(pair => covers(pair, start, end, reverseRangeKeys)));
    const hit = mapped && (mapped.connection || !mapped.approximate) ? mapped
      : first === last ? this.locate(first.index, entry, true, scope) : this.search(entry, scope);
    const item = start < end && from === to && items.find(({ missing, comparison, sourceStart, sourceEnd }) =>
      missing && (comparison.anchor?.start <= start && comparison.anchor.end >= end
        || hit && !hit.approximate && sourceStart <= hit.start && sourceEnd >= hit.end));
    if (item) {
      const { sourceStart, sourceEnd, comparison } = item;
      comparison.anchor ||= { start, end };
      return { hit: { start: sourceStart, end: sourceEnd }, range: this.missingRange(first.index, sourceStart, sourceEnd, comparison),
        difference: { ...comparison, missing: true } };
    }
    const html = hit && this.raw.slice(hit.start, hit.end);
    const difference = !hit ? { message: "No reliable HTML match" } : html !== entry.text ? { html, pdf: entry.text } : null;
    return { hit, difference };
  }
  locateLayer(queries, targets = []) {
    const hits = new Map();
    let focusHit = null;
    const addHit = hit => {
      const key = hit.start + ':' + hit.end;
      if (!hits.has(key) || hit.difference?.missing) hits.set(key, hit);
    };
    for (const target of targets) {
      const hit = target.range && (!target.layer || target.layer === this.layer) ? { ...target.range }
        : target.index ? target.index.locate(this, target.layer ? { ...target, range: null } : target, false, undefined, true) : this.search(target);
      if (!hit) { if (!target.marked && !target.index) this.matches([target.text]).forEach(addHit); continue; }
      hit.difference = target.difference || (hit.approximate ? { html: target.text, pdf: this.raw.slice(hit.start, hit.end) } : null);
      hit.source = target.source || target.index && { index: target.index, start: target.start, end: target.end };
      focusHit ||= hit;
      addHit(hit);
    }
    this.matches(queries).forEach(addHit);
    return { hits: [...hits.values()], focusHit };
  }
}
Object.assign(window.PdfSelectionDiff, { PdfConnections, documentIndex, shiftRanges });
