import { diffIndex, fontKeys, textDiff, localTextDiff, extendPageRange, changedRange, normalized, lowerBound, significantText, closestEdge, findMatches, mapDiffRange, forwardRangeKeys, reverseRangeKeys } from './pdf-selection-diff.js';
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
// One index owns text, source coordinates, live mappings and prepared text/font comparisons.
class PdfConnections {
  connections = new WeakMap();
  prepared = null;
  constructor({ environment, documents, document, pdf, options }, values) {
    if (typeof values === 'string') values = new window.MewEditorCore.DocumentModel({ text: values });
    Object.assign(this, { environment, documents, document, pdf, options }, values?.parse?.(document) ?? values);
    if (this.normalized !== null) this.normalized ||= normalized(this.raw);
  }
  get pairs() { return this.prepared?.pairs || []; }
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
      : this.pages?.filter(page => start < page.end && end > page.start).flatMap(page => page.parts) || [];
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
      const key = keys[0], opening = key === 'italic' ? /^<(i|em)>$/i : /^<(b|strong)>$/i;
      const adjacent = before => {
        let at = before ? start - 1 : end;
        while (at >= 0 && at < this.raw.length && /[^\S\r\n]/u.test(this.raw[at])) at += before ? -1 : 1;
        return this.formats[at]?.tags?.findLast(tag => tag[key] === true
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
    const segments = this.sourceSegments(start, end, !this.raw.slice(start, end).trim() && !replacement.trim());
    const text = replacement.replace(/[&<>]/g, char => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;');
    return segments.map((segment, i) => ({ ...segment, text: i ? '' : text,
      expected: this.source.slice(segment.start, segment.end) }));
  }
  // Compare this snapshot; the caller selects the current editor index explicitly.
  getDifferences(pages = [], update) {
    this.connect(pages, update);
    if (!this.prepared.differences || !this.fontsCurrent) {
      this.prepared.differences = { index: this, connections: this.prepared.pairs, items: this.candidates() };
      this.prepared.fonts = this.prepared.pages.map(({ parts, pages, fontVersion }) => ({ parts, pages, fontVersion }));
    }
    return this.prepared.differences;
  }
  connect(pages = [], update) {
    const scoped = pages !== null && !Array.isArray(pages), prepare = pages !== null && update?.prepare !== false;
    const previousState = this.prepared;
    const full = scoped ? null : documentIndex(this.documents, this.pdf, this.environment.getSourcePages?.()) || previousState?.full;
    const targets = new Set((scoped ? [pages] : [full, ...(pages || []), ...(this.environment.getTargets?.() || [])]).filter(Boolean));
    const previous = !this.change && update?.previous;
    if (previous) this.change = { ...(update.change || changedRange(previous.raw, this.raw)), before: previous.raw };
    if (!previous && prepare && !scoped && previousState?.pdf === this.pdf && previousState.full === full && previousState.pages?.length === targets.size
      && previousState.pages.every((page, i) => targets.has(page) && this.targetConnections(page) === previousState.connections[i])) return previousState;
    for (const page of targets) {
      const preparePage = prepare && (scoped || page !== previousState?.full);
      if (!previous && !preparePage) continue;
      const state = this.connections.get(page) || {};
      this.connections.set(page, state);
      const cached = previous && previous.connections.get(page), original = cached?.ranges || noConnections;
      const { preparedRanges: prepared, scope } = cached || {};
      const migrated = scope && prepared && prepared !== original ? new Map() : null;
      for (const items of migrated ? [original, prepared] : previous ? [original] : noConnections) {
        const { start, oldEnd, newEnd } = this.change, change = newEnd - oldEnd;
        const shift = (a, b) => b <= start ? 0 : a >= oldEnd ? change : null;
        const live = items === original, retained = [];
        for (const item of items) {
          let kept = live ? undefined : migrated.get(item);
          if (kept === undefined) {
            const delta = start === oldEnd && item.end === start && item.start < start ? null : shift(item.start, item.end);
            if (delta !== null) {
              kept = item.copy(this, delta);
              kept.gap = undefined;
              if (kept.comparisonContext && kept.comparisonVersion === previous.textVersion
                && this.formats?.slice(kept.start, kept.end).every((style, i) => {
                  const at = item.start + i, old = previous.formats[at];
                  return style.italic === old.italic && style.bold === old.bold && style.name === old.name
                    && style.definition?.open === old.definition?.open
                    && (!i || (style === this.formats[kept.start + i - 1]) === (old === previous.formats[at - 1]));
                })) kept.comparisonVersion = this.textVersion;
            } else if (!(item.start > start || item.end < oldEnd)) {
              // A prepared pair can reach an edit before its raw-text comparison is read.
              if (!item.editorDiff && previous.pairs.includes(item)) previous.compare(item, undefined, { textOnly: true });
              const diff = item.editorDiff;
              if (diff && diff.reliable !== false) {
                // Keep unchanged missing tails out of the new alignment.
                const last = diff.parts?.findLast(part => part.pdf.trim());
                const end = last && item.start + last.end >= oldEnd ? item.start + last.end : item.end;
                kept = this.remember(item.start, end + change, page, item.targetStart, item.targetEnd,
                  { previous: item, change: { start: start - item.start, newEnd: newEnd - item.start, previous: diff } });
              }
            }
            if (live) migrated?.set(item, kept ?? null);
          }
          if (kept) retained.push(kept);
        }
        if (!live || retained.length) state[live ? 'ranges' : 'preparedRanges'] = retained;
        if (!live) break;
        const reverseScope = page.connections.get(previous);
        const reverse = (reverseScope?.ranges || []).flatMap(item => {
          const delta = shift(item.targetStart, item.targetEnd);
          return delta === null ? [] : [Object.assign(item.copy(this, delta, true), { gap: undefined })];
        });
        const unchanged = previous.raw === this.raw;
        if (reverse.length || unchanged && reverseScope?.scope !== undefined)
          page.connections.set(this, { ...(unchanged ? reverseScope : {}), ranges: reverse.length ? reverse : undefined });
        if (!scope) break;
        const { start: a, end: b } = scope, delta = shift(a, b);
        if (delta === null && !(retained.length && retained.length === original.length && a <= start && b >= oldEnd
          && (prepared === original || prepared?.every(item => migrated.has(item))))) break;
        Object.assign(state, { prepared: cached.prepared, scope: { start: a + (delta ?? 0), end: b + (delta ?? change) } });
        if (!migrated) state.preparedRanges = prepared === original ? retained : undefined;
      }
      if (preparePage) this.#connectPage(page, state, full);
    }
    if (scoped) return this.connections.get(pages)?.scope;
    if (!prepare) return previousState;
    pages = [...targets];
    const pairs = this.targetConnections(pages), snapshots = [];
    for (const page of pages) {
      const state = this.connections.get(page);
      if (!page.pages && state) {
        const shared = state.preparedRanges === state.ranges;
        for (const key of shared ? ['ranges'] : ['ranges', 'preparedRanges']) {
          const ranges = state[key];
          const kept = ranges?.filter(item => !pairs.some(other => other.target !== page && !other.target.pages
            && covers(other, item.start, item.end)
            && (other.start < item.start || other.end > item.end)));
          if (kept?.length !== ranges?.length) state[key] = kept;
        }
        if (shared) state.preparedRanges = state.ranges;
      }
      snapshots.push(this.targetConnections(page));
    }
    this.prepared = { pdf: this.pdf, full, pages, connections: snapshots, pairs };
    return this.prepared;
  }
  #connectPage(page, state, full) {
    if (page === full && !full.sourcePages) full.connect(this);
    const entry = matchingPage(full, page), projected = entry && full.sourcePages?.length > 1 ? new Set() : null;
    if (entry) {
      for (const pair of this.targetConnections(full)) {
        const from = Math.max(entry.start, pair.targetStart), to = Math.min(entry.end, pair.targetEnd);
        if (from >= to) continue;
        const hit = from === pair.targetStart && to === pair.targetEnd ? pair : this.range(full, from, to, true, pair);
        const mapping = hit && this.remember(hit.start, hit.end, page, from - entry.start, to - entry.start,
          hit === pair && { connection: pair });
        if (mapping) projected?.add(mapping);
      }
    }
    const projectedRanges = projected?.size && state.ranges.filter(item => projected.has(item));
    if (projectedRanges) {
      Object.assign(state, { prepared: true, preparedRanges: projectedRanges, scope: connectionBounds(projectedRanges) });
    }
    if (state.prepared) return;

    const htmlRaw = this.raw, pdfRaw = page.raw, pageEnd = pdfRaw.length;
    const source = this.normalized, target = page.normalized;
    const pageCount = page.sourcePages?.length, partial = page.layer && this.environment.getSourcePages?.()?.length > 1;
    const horizontal = page.horizontal || page.pages?.some(entry => entry.horizontal), recover = !!(pageCount || page.layer);
    // Use detected passages as boundaries, since physical page turns can split words.
    const blocks = page.pages?.some(entry => entry.breaks?.length) ? page.pages.flatMap(p => [p.start, ...(p.breaks || []), p.end])
      : (page.layer || horizontal) && page.breaks?.length ? [0, ...page.breaks, pageEnd] : null;
    const reverse = page.targetConnections(this, false);
    for (const pair of reverse)
      this.remember(pair.targetStart, pair.targetEnd, page, pair.start, pair.end, { connection: pair, reverse: true });
    let scope = reverse.some(pair => pair.start === 0 && pair.end === pageEnd)
      ? connectionBounds(reverse, true) : state.ranges?.find(item => item.targetStart === 0 && item.targetEnd === pageEnd);
    if (!blocks && !partial && recover) scope ||= this.remember(0, htmlRaw.length, page, 0, pageEnd, { recover });
    const [hit, duplicate] = scope || blocks ? noConnections : this.matches([pdfRaw], source, { limit: 2 });
    if (hit && !duplicate) scope = this.remember(hit.start, hit.end, page, 0, pageEnd) || hit;

    const size = blocks ? horizontal ? 12 : 16 : 24;
    const sourceBegin = htmlRaw.length - htmlRaw.trimStart().length;
    const anchors = !scope && target.text.length >= size ? this.matches(page, source, size, blocks, horizontal) : [];
    let groups = 0, previous;
    // Store merged ranges in the part of the anchor array already scanned.
    for (let i = 0, count = anchors.length - Number(!blocks); i < count; i++) {
      const anchor = anchors[i], following = anchors[i + 1], range = anchors[groups - 1];
      let next = following && following.block === anchor.block ? following : anchor;
      if (blocks && next.start - anchor.start - (next.at - anchor.at) > 32)
        next = anchors.slice(i + 2, lowerBound(anchors, anchor.at + size * 4 + 1, item => item.at))
          .find(item => item.block === anchor.block && item.start > anchor.start && item.start < next.start) || next;
      const targetEnd = next.at + size, length = Math.min(targetEnd, target.text.length) - anchor.at;
      if (next !== anchor && next.start <= anchor.start || length > 2048) continue;
      const cost = (at, start, budget) => textDiff(
        target.text.slice(at, targetEnd), source.text.slice(start, next.end), false, budget).distance;
      const limit = Math.min(32, Math.max(12, Math.floor(length * .2))), adjacent = cost(anchor.at, anchor.start, limit);
      if (adjacent > limit) continue;
      if (next !== anchor) i = anchors.indexOf(next, i + 1) - 1;
      if (range && range.block === anchor.block && range.targetEnd >= anchor.at && range.end >= anchor.start) {
        const budget = 128 - range.distance, suffix = next.end >= range.end ? cost(range.targetEnd, range.end, budget) : Infinity;
        const distance = suffix <= budget ? range.distance + suffix : cost(range.at, range.start, 128);
        if (distance <= 128) {
          Object.assign(range, { targetEnd, end: next.end, distance });
          continue;
        }
      }
      anchors[groups++] = { ...anchor, targetEnd, end: next.end, distance: adjacent };
    }

    for (const range of anchors.slice(0, groups)) {
      const begin = range.begin ?? 0;
      const passage = blocks ? target.text.slice(begin, range.stop) : target.text, word = blocks ? null : undefined;
      let [pdfStart, htmlStart] = extendPageRange(passage, source.text, range.at - begin, range.start, -1, false, word);
      let [pdfStop, htmlStop] = extendPageRange(passage, source.text, range.targetEnd - begin, range.end, 1, false, word);
      pdfStart += begin;
      pdfStop += begin;
      const pdfLine = lineStart(pdfRaw, target.starts[pdfStart]), htmlLine = lineStart(htmlRaw, source.starts[htmlStart]);
      const pdfLead = Math.max(begin, lowerBound(target.starts, pdfLine)), htmlLead = lowerBound(source.starts, htmlLine);
      const lead = pdfStart > pdfLead && pdfStart - pdfLead <= 32 && htmlStart - htmlLead <= 32 ? source.text.slice(htmlLead, htmlStart) : '';
      if (/[\p{L}\p{N}]/u.test(lead) && (!/\p{L}/u.test(target.text.slice(pdfLead, pdfStart)) || /\p{L}/u.test(lead))
        && !/[\r\n]/.test(pdfRaw.slice(target.starts[pdfStart], target.ends[pdfStart])
          + htmlRaw.slice(source.starts[htmlStart], source.ends[htmlStart]))) {
        [pdfStart, htmlStart] = [pdfLead, htmlLead];
      }
      if (!blocks && pageCount > 1 && /\p{L}/u.test(target.text[pdfStop] || '') && /\p{L}/u.test(source.text[htmlStop] || '')) {
        const pdfNextLine = lineStart(pdfRaw, target.starts[pdfStop]), htmlNextLine = lineStart(htmlRaw, source.starts[htmlStop]);
        if (pdfNextLine > target.starts[range.targetEnd - 1] && htmlNextLine > source.starts[range.end - 1]
          && !/\p{L}{2}/u.test(pdfRaw.slice(pdfNextLine, target.ends[pdfStop - 1]) + ' '
            + htmlRaw.slice(htmlNextLine, source.ends[htmlStop - 1]))) {
          [pdfStop, htmlStop] = [lowerBound(target.starts, pdfNextLine - 1), lowerBound(source.starts, htmlNextLine - 1)];
        }
      }
      let start = source.starts[htmlStart], end = source.ends[htmlStop - 1];
      let targetStart = target.starts[pdfStart], targetEnd = target.ends[pdfStop - 1];
      if (blocks) {
        for (const leading of [true, false]) {
          const edge = leading ? Math.max(blocks[range.block], pdfLine) : blocks[range.block + 1];
          const lineEnd = leading ? -1 : pdfRaw.indexOf('\n', targetEnd), bound = lineEnd < 0 ? edge : Math.min(lineEnd, edge);
          const fragment = leading ? significantText(pdfRaw.slice(bound, targetStart))
            : bound - targetEnd <= 48 ? letters(pdfRaw.slice(targetEnd, bound)) : null;
          if (fragment === null || leading && (!fragment || fragment.length > 32)) continue;
          const first = Math.max(0, htmlStart - fragment.length - 8), stop = Math.min(htmlRaw.length, end + 49);
          const edges = leading ? Array.from({ length: htmlStart - first }, (_, i) => first + i)
            .filter(at => Math.abs(htmlStart - at - fragment.length) <= 4 || source.text[at] === ' ')
            : Array.from(htmlRaw.slice(end, stop).matchAll(/\s+|$/gu), match => end + match.index)
              .filter(at => at < stop || at === htmlRaw.length);
          const at = closestEdge(fragment, edges, at => leading ? significantText(source.text.slice(at, htmlStart)) : letters(htmlRaw.slice(end, at)),
            Math.max(Number(leading), Math.floor(fragment.length / 4)));
          if (at !== undefined && leading) [start, targetStart] = [source.starts[at], bound];
          else if (at !== undefined) [end, targetEnd] = [at, bound];
        }
      }
      const sourceEnd = previous?.end ?? sourceBegin, pdfEnd = previous?.targetEnd ?? 0;
      const gap = !blocks && !partial && (previous ? start > sourceEnd && targetStart > pdfEnd : pageCount && start <= 2048)
        && this.remember(sourceEnd, start, page, pdfEnd, targetStart, { recover });
      const next = this.remember(start, end, page, targetStart, targetEnd, { adjacent: previous, blockStart: blocks?.[range.block] });
      if (!recover && gap === null && next) previous.gap = { next, connection: null };
      previous = next;
    }
    if (!blocks && pageCount && previous) {
      let start = previous.end;
      const stop = pageCount > 1 ? previous.targetStart + /^\s*/u.exec(pdfRaw.slice(previous.targetStart))[0].length : pageEnd;
      if (pageCount > 1) {
        for (const item of state.ranges
          .filter(pair => !pair.recovered && pair.targetStart < previous.targetStart && pair.targetEnd <= stop)
          .sort((a, b) => a.start - b.start)) {
          if (item.start <= start) start = Math.max(start, item.end);
        }
      }
      if (htmlRaw.length - start <= 2048 && significantText(htmlRaw.slice(start)))
        this.remember(start, htmlRaw.trimEnd().length, page, previous.targetEnd, pdfRaw.trimEnd().length, { recover });
    }
    let bySource = [...(state.ranges || noConnections)].sort((a, b) => a.start - b.start);
    for (const [start, end, next] of connectionGaps(bySource, sourceBegin)) {
      if (end - start <= 32) {
        const hit = page.search({
          text: htmlRaw.slice(start, end),
          before: '',
          after: htmlRaw.slice(end, Math.min(next.end, end + 24))
        }, { start: Math.max(0, next.targetStart - (end - start) - 32), end: next.targetEnd });
        if (hit && hit.end <= next.targetStart && this.remember(start, end, page, hit)) bySource = null;
      }
    }

    const ranges = state.ranges || noConnections, stops = [], proposed = [];
    const pages = (blocks || (pageCount > 1 || partial) && page.pages) && (page.pages || [{ start: 0, end: pageEnd, breaks: page.breaks }]);
    const byTarget = pages && [...ranges].sort((a, b) => a.targetStart - b.targetStart);
    let first = 0, scanned = 0;
    for (const { start, end, breaks } of ranges.length && pages || noConnections) {
      while (byTarget[first]?.targetEnd <= start) first++;
      const touching = byTarget.slice(first, lowerBound(byTarget, end, item => item.targetStart));
      const footer = touching[0]?.targetEnd ?? breaks?.at(-1);
      for (const [from, to] of connectionGaps(touching, footer ?? end, end, true)) {
        const raw = pdfRaw.slice(from, to), view = compact(normalized(raw, undefined, from));
        const ends = new Set(Array.from(raw.matchAll(/[\r\n–—-]|$/gu),
          mark => lowerBound(view.ends, from + mark.index + 1)));
        for (const stop of ends) {
          if (!stop) continue;
          const end = view.ends[stop - 1], line = lineStart(pdfRaw, end);
          const label = line >= from && /^[^\S\r\n]*\S+[^\S\r\n]+/u.exec(pdfRaw.slice(line, end));
          stops.push({ from, view, stop, end, body: label ? lowerBound(view.starts, line + label[0].length) : -1 });
        }
      }
    }

    const lines = /\S[^\r\n]*/gu;
    const gaps = stops.length
      ? connectionGaps(bySource ?? [...ranges].sort((a, b) => a.start - b.start), 0, htmlRaw.length)
      : noConnections;
    for (const [from, to] of gaps) {
      lines.lastIndex = Math.max(scanned, lineStart(htmlRaw, from));
      for (let line; (line = lines.exec(htmlRaw)) && line.index < to; scanned = lines.lastIndex) {
        const start = line.index, text = line[0].trimEnd(), end = start + text.length, space = text.search(/\s/u);
        if (start < from || end > to) continue;
        for (const bodyStart of space > 0 ? [start, start + space] : [start]) {
          const needle = normalized(htmlRaw.slice(bodyStart, end)).text.replace(/[\s\-\u00ad\u2010\u2011]/gu, '');
          if (needle.length < 8 || !/\p{L}.*\p{L}.*\p{L}/u.test(needle)) continue;
          let hit, best = Math.min(3, Math.floor(needle.length / 4));
          for (const stop of stops) {
            const { view, stop: length, body } = stop, suffix = length - needle.length;
            const exact = suffix >= 0 && view.text.startsWith(needle, suffix);
            const i = exact ? suffix : bodyStart > start ? body : -1;
            if (i < 0) continue;
            const at = view.starts[i], distance = exact ? 0 : textDiff(needle, view.text.slice(i, length), false, best).distance;
            if (distance > best || /^\p{L}/u.test(needle) && /\p{L}/u.test(pdfRaw[at - 1] || '')) continue;
            hit = hit === undefined || distance < best ? { stop, at, start, end, bodyStart } : null;
            best = distance;
            if (best === 0 && hit === null) break;
          }
          if (hit !== undefined) {
            if (hit) proposed.push(hit);
            break;
          }
        }
      }
    }
    for (const [i, { stop, at, start, end, bodyStart }] of proposed.sort((a, b) => a.at - b.at).entries()) {
      const prior = proposed[i - 1], from = prior?.stop.view === stop.view ? prior.stop.end : stop.from;
      if (prior?.stop.end > at || proposed[i + 1]?.at < stop.end) continue;
      const label = bodyStart > start && /(?:^|\s)\S+\s*$/u.exec(pdfRaw.slice(from, at));
      this.remember(start, end, page, label ? at - label[0].trimStart().length : at, stop.end);
    }
    const preparedRanges = state.ranges || noConnections;
    Object.assign(state, {
      prepared: true,
      preparedRanges,
      scope: preparedRanges.length && (!scope || blocks) ? connectionBounds(preparedRanges) : scope || null
    });
  }
  get livePairs() { return this.targetConnections(this.prepared?.pages || [], false); }
  compare(connection, update, { textOnly = false } = {}) {
    const { target, comparisonContext: context } = connection;
    if (!update && context && connection.comparisonVersion === this.textVersion && connection.editorDiff === context[0]
      && target?.parts === context[1] && target?.pages === context[2] && target?.fontVersion === context[3])
      return connection.editorDiff.reliable ? connection.editorDiff : null;
    if (!connection.editorDiff || update) connection.editorDiff = textDiff(connection.html ?? this.raw.slice(connection.start, connection.end),
      connection.pdf ?? target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true, update);
    const diff = connection.editorDiff, parts = diff.parts ||= [];
    diff.reliable ??= diff.distance <= 256 || !parts.some(part => part.inconsistent
      && (significantText(part.html).length > 256 || significantText(part.pdf).length > 256));
    if (textOnly) return diff.reliable ? diff : null;
    if (!diff.reviewRanges) {
      diff.reviewRanges = connection.spans ? [] : parts.filter(part => part.inconsistent);
      if (connection.spans) {
        const left = this.normalized, right = target.normalized;
        const h = lowerBound(left.starts, connection.start), p = lowerBound(right.starts, connection.targetStart);
        const reversed = connection.reversedSpans;
        const [start, , from] = reversed ? reverseRangeKeys : forwardRangeKeys;
        const html = reversed ? 'pdf' : 'html', pdf = reversed ? 'html' : 'pdf';
        for (const span of connection.spans) if (span.changed) {
          const i = h + span[start], j = p + span[from];
          const a = left.starts[i] ?? left.ends.at(-1), x = right.starts[j] ?? right.ends.at(-1);
          const b = span[html] ? left.ends[i + span[html].length - 1] : a;
          const y = span[pdf] ? right.ends[j + span[pdf].length - 1] : x;
          const sourceText = this.raw.slice(a, b), targetText = target.raw.slice(x, y);
          if (significantText(sourceText) !== significantText(targetText))
            diff.reviewRanges.push(new diffIndex(sourceText, targetText, a - connection.start, x - connection.targetStart, true));
        }
      }
    }
    connection.comparisonVersion = this.textVersion;
    connection.comparisonContext = [diff, target?.parts, target?.pages, target?.fontVersion];
    connection.fontItems = [];
    const runs = this.formats && target ? target.fontRuns(connection.targetStart, connection.targetEnd) : [];
    for (const part of runs.length ? diff.parts : []) {
      const start = connection.start + part.start, pdfStart = connection.targetStart + part.targetStart, pdfEnd = connection.targetStart + part.targetEnd;
      let i = lowerBound(runs, pdfStart + Number(pdfStart < pdfEnd), font => font.end);
      const last = lowerBound(runs, pdfEnd + Number(pdfStart === pdfEnd), font => font.start);
      while (i < last) {
        let font = runs[i++];
        if (part.changed) {
          font = { ...font, start: pdfStart, end: pdfEnd };
          for (; i < last; i++) for (const key of fontKeys) if (runs[i][key] !== font[key]) font[key] = null;
        }
        if (!fontKeys.some(key => typeof font[key] === 'boolean')) continue;
        const end = part.changed ? connection.start + part.end : start + Math.min(pdfEnd, font.end) - pdfStart;
        for (let at = start + Math.max(pdfStart, font.start) - pdfStart; at < end;) {
          const htmlFont = this.formats[at];
          let stop = at + 1;
          while (stop < end && this.formats[stop] === htmlFont) stop++;
          if (htmlFont && fontKeys.some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key])) {
            const text = this.raw.slice(at, stop).trimStart(), sourceStart = stop - text.length - connection.start;
            if (text) connection.fontItems.push({ start: sourceStart, end: sourceStart + text.trimEnd().length, font });
          }
          at = stop;
        }
      }
    }
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
      const rejected = diff.distance > 128 && diff.parts.some(part => part.changed && Math.max(part.html.length, part.pdf.length) > 128)
        || recover && diff.distance > 32 && !diff.parts.some(part => !part.changed && /[\p{L}\p{N}]{2}/u.test(part.html));
      if (rejected) {
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
      extend.editorDiff = extend.comparisonContext = extend.fontItems = extend.gap = extend.recovered = undefined;
      extend.append(extend.index.raw.slice(extend.end, end), extend.target.raw.slice(extend.targetEnd, targetEnd), end, targetEnd);
      extend.changed = extend.html !== extend.pdf;
    }
    connection.distance = (aligned || diff).distance;
    connection.spans = aligned ? aligned.spans : diff.parts;
    connection.reversedSpans = !!aligned && !!aligned.reversedSpans !== !!reverse;
    if (previous?.editorDiff) this.compare(connection, change || {});
    const ranges = state.ranges = (state.ranges === state.preparedRanges ? state.ranges?.slice() : state.ranges) || [];
    for (let i = ranges.length - 1; i >= 0; i--) {
      const item = ranges[i];
      if (item === connection || item.start === start && item.end === end) ranges.splice(i, 1);
    }
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
      const ordered = start < end ? [...connections].sort((a, b) => a[begin] - b[begin]) : noConnections;
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1], b = ordered[i];
        if (a[stop] >= end || b[begin] <= Math.max(start, a[stop]) || a.end > b.start || a.targetEnd > b.targetStart
          || Math.max(b.start - a.end, b.targetStart - a.targetEnd) > 2048) continue;
        if (a.gap?.next !== b) a.gap = { next: b, connection: this.remember(a.end, b.start, target, a.targetEnd, b.targetStart) };
        if (a.gap.connection && containing(a.gap.connection)) connection = a.gap.connection;
      }
    }
    if (!connection) {
      if (target.normalized && !this.connections.get(target)?.prepared) this.connect(target);
      connections = [...this.targetConnections(target, false)].sort((a, b) => a[begin] - b[begin]).flatMap((b, i, ordered) => {
        const gap = ordered[i - 1]?.gap;
        return gap?.next === b && gap.connection ? [gap.connection, b] : [b];
      });
      connection = start < end && connections.find(containing);
    }
    let first = Infinity, last = -1, covered = start;
    for (const item of connection ? [connection] : connections) {
      if (!connection && !(start === end ? containing(item) : overlaps(item, start, end, keys))) continue;
      const diff = this.compare(item, undefined, { textOnly: true });
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
  // Resolve either direction through the same mapping, bounded search and confirmation path.
  locate(target, entry, reverse = false, scope, marked = false, { visiblePage = false } = {}) {
    const explicit = !visiblePage && entry.range, destination = reverse ? this : target;
    const mapped = !explicit && this.range(target, entry.start, entry.end, reverse, undefined, marked);
    if (visiblePage && !mapped) return null;
    if (mapped) {
      const exact = visiblePage && entry.text !== this.raw.slice(entry.start, entry.end)
        ? significantText(entry.text) === significantText(destination.raw.slice(mapped.start, mapped.end)) : !mapped.approximate;
      if (exact) return mapped;
    }
    const hit = explicit || destination.search(entry, scope) || mapped;
    if (!hit || hit === mapped || visiblePage) return hit || null;
    return { ...hit, connection: reverse ? this.remember(hit.start, hit.end, target, entry.start, entry.end)
      : this.remember(entry.start, entry.end, target, hit) };
  }

  // The same confirmed edges locate missing text for the queue and for PDF selections.
  missingRange(target, start, end = start) {
    let ranges = this.prepared?.differences?.items?.missingRanges;
    if (!ranges?.context) ranges = this.candidates([target], undefined, true).missingRanges;
    const { context } = ranges;
    if (start === undefined || !context) return ranges;
    const hit = ranges.find(range => !range.resolved && range.sourceStart <= start && range.sourceEnd >= end), a = hit?.edge;
    if (!hit?.matched) return null;
    const parts = ranges.parts ||= context.index.parts || context.index.pages?.flatMap(page => page.parts) || [];
    let position = a ? lowerBound(parts, a, part => part.start) - 1 : 0, from;
    for (; position >= 0 && position < parts.length; position += a ? -1 : 1) {
      const part = parts[position], text = context.index.raw.slice(part.start, Math.min(a || part.end, part.end));
      if (!text.trim()) continue;
      from = part.start + (a ? text.trimEnd().length : text.length - text.trimStart().length);
      break;
    }
    if (from === undefined) return null;
    const endBias = a > 0;
    if (context.page && (from < context.page.start || from > context.page.end || endBias && from === context.page.start)) return null;
    return { start: from - context.offset, end: from - context.offset, endBias };
  }
  #addCandidate(start, html, pdf, items, ranges, compared, missingOnly, connection, outside) {
    const number = /^[^\p{L}\d]*(\d+)[^\p{L}\d]*$/u;
    const left = number.exec(html), right = number.exec(pdf), digits = left && right;
    const from = start + (digits ? html.indexOf(left[1]) : 0), end = from + (digits ? left[1] : html).length;
    let missing = !connection;
    if (connection) {
      const value = significantText(this.raw.slice(from, end));
      let first;
      for (const other of value || !missingOnly ? compared : noConnections) {
        if (other !== connection && !(covers(other, from, end)
          && (from < end || other.end > from || other.start === from))) continue;
        first ??= other;
        if (!value) break;
        if (other !== connection && this.range(other.target, from, end, false, other)?.approximate === false) return;
      }
      const insideWord = connection.target.sourcePages?.length > 1 && /^\p{L}+$/u.test(value)
        && (from > connection.start && /\p{L}/u.test(this.raw[from - 1]) || end < connection.end && /\p{L}/u.test(this.raw[end]));
      missing = outside && !insideWord && /[\p{L}\p{N}]/u.test(html)
        && (!pdf.trim() || /\p{L}/u.test(html) && !/\p{L}/u.test(pdf));
      if (missing) ranges.push({ sourceStart: from, sourceEnd: end, connection });
      if (!missingOnly && first !== connection) return;
    }
    if (missingOnly) return;
    const at = lowerBound(items, from, item => item.sourceStart), next = items[at];
    if (at && items[at - 1].sourceEnd > from
      || next && (end === from ? next.sourceStart === from : next.sourceStart < end && next.sourceEnd > from)) return;
    items.splice(at, 0, { sourceStart: from, sourceEnd: end, ...(missing && { missing: true }),
      comparison: digits ? { html: left[1], pdf: right[1] } : { html, pdf } });
  }
  // One traversal collects review items, uncovered intervals and their PDF edges.
  candidates(targets = this.prepared?.pages || [], connections, missingOnly = false) {
    connections ??= targets === this.prepared?.pages ? this.pairs : this.targetConnections(targets);
    const target = missingOnly ? targets[0] : (targets.find(page => page?.sourcePages?.length)
      || connections.find(connection => connection.target?.sourcePages?.length)?.target);
    const live = connections.length ? connections : this.livePairs;
    const compared = live.length || !missingOnly ? live : this.targetConnections(target?.layer ? this.prepared?.full : target);
    const index = target?.layer
      ? this.prepared?.full || documentIndex(this.documents, this.pdf, this.environment.getSourcePages?.()) : target;
    const page = target?.layer && matchingPage(index, target);
    const context = target && index && (!target.layer || page) ? { index, page, offset: page?.start || 0 } : null;
    const items = [], ranges = [], edges = [], ordered = [];
    const prepared = this.connections.get(target)?.prepared;
    let gaps = missingOnly || prepared;
    for (const connection of (!target || context) ? compared : []) {
      gaps ||= connections.length > 0 && connection.target === target && connection.recovered;
      const mapped = connection.target;
      const base = !context || mapped === index || mapped?.layer && !index.pages?.length
        ? 0 : matchingPage(index, mapped)?.start ?? null;
      const diff = this.compare(connection);
      if (!diff) continue;
      let first, last;
      if (base !== null) {
        ordered.push(connection);
        for (const part of diff.parts) {
          const { sourceEdge, targetEdge } = part;
          if (sourceEdge > part.start && targetEdge > part.targetStart)
            edges.push({ sourceEnd: connection.start + sourceEdge, targetEnd: base + connection.targetStart + targetEdge });
          if (diff.reviewRanges.length && !part.changed && /\p{L}/u.test(part.pdf)) {
            first ??= part;
            last = part;
          }
        }
      }
      for (const { start, end, html, pdf } of diff.reviewRanges) {
        const outside = base !== null && (!first || end <= first.start || start >= last.end);
        this.#addCandidate(connection.start + start, html, pdf, items, ranges, compared, missingOnly, connection, outside);
      }
    }
    if (gaps && context) for (const [sourceStart, sourceEnd] of connectionGaps(ordered.sort((a, b) => a.start - b.start),
      this.raw.length - this.raw.trimStart().length, this.raw.trimEnd().length)) ranges.push({ sourceStart, sourceEnd });
    edges.sort((a, b) => a.sourceEnd - b.sourceEnd);
    let at = 0, edge = 0;
    for (const range of ranges.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      while (at < edges.length && edges[at].sourceEnd <= range.sourceStart) edge = edges[at++].targetEnd;
      const hit = !range.connection && target && prepared
        && this.range(target, range.sourceStart, range.sourceEnd, false, undefined, true);
      const resolved = !!(hit && !hit.approximate && /[\p{L}\p{N}]/u.test(target.raw.slice(hit.start, hit.end)));
      range.edge = edge; range.matched = !!edges.length; range.resolved = resolved;
      const html = this.raw.slice(range.sourceStart, range.sourceEnd);
      if (!resolved && significantText(html))
        this.#addCandidate(range.sourceStart, html, '', items, ranges, compared, missingOnly);
    }
    Object.defineProperty(items, 'missingRanges', { value: Object.assign(ranges, { context }) });
    return items;
  }
  matches(queries, haystack = this.normalized, options = {}, blocks, contextual = false) {
    let sample, page, step = 8, wholeWords = this.options?.wholeWords, anchors = !wholeWords;
    if (typeof options === 'number') {
      sample = options;
      page = queries;
      queries = null;
    } else {
      if (!options.sample) return findMatches(this, queries, haystack, options);
      ({ sample, step = 0, anchors = false, wholeWords = this.options?.wholeWords, page, blocks, contextual = false } = options);
    }
    const target = page?.normalized, connections = target && this.targetConnections(page, false), matches = [];
    const passages = blocks ? blocks.length - 1 : queries?.length ?? 1;
    let stop = blocks?.length ? lowerBound(target.starts, blocks[0]) : 0;
    for (let block = 0; block < passages; block++) {
      const passage = blocks || !queries ? target.text : queries[block];
      const begin = blocks ? stop : 0;
      stop = blocks ? lowerBound(target.starts, blocks[block + 1]) : passage.length;
      const last = stop - begin - sample;
      if (last < 0) continue;
      const shortContext = blocks && contextual && last >= 8 && stop - begin <= 32;
      const first = matches.length, count = step ? Math.ceil(last / step) + 1 : 5;
      for (let i = 0, previous = -1; i < count; i++) {
        const at = begin + (step ? Math.min(i * step, last) : Math.floor(last * i / 4));
        if (at === previous) continue;
        previous = at;
        const fragment = passage.slice(at, at + sample);
        if (blocks && !/\p{L}{2}/u.test(fragment)) continue;
        const start = target?.starts[at], end = target?.ends[at + sample - 1];
        const pair = connections?.find(item => covers(item, start, end, reverseRangeKeys));
        const mapped = pair && this.range(page, start, end, true, pair);
        const hits = mapped && !mapped.approximate ? null : findMatches(this, [fragment], haystack, { anchors, wholeWords, limit: 2 });
        let hit = !hits ? mapped : hits.length === 1 ? hits[0] : null;
        if (hits?.length > 1 && blocks && contextual) {
          const left = passage.slice(Math.max(begin, at - 32), at);
          const right = passage.slice(at + sample, Math.min(stop, at + sample + 32));
          const before = shortContext ? left : left.trim(), after = shortContext ? right : right.trim();
          if (shortContext || before.length + after.length >= sample) {
            const match = findMatches(this, [fragment], haystack, { anchors, wholeWords, before, after, best: true, contextual: shortContext });
            if (match && !match.approximate && (shortContext || match.score >= sample)) hit = match;
          }
        }
        if (hit) matches.push({ at, start: lowerBound(haystack.starts, hit.start),
          end: lowerBound(haystack.starts, hit.end), ...(blocks && { block, begin, stop, context: hit.score }) });
      }
      if (blocks && matches.length === first + 1) {
        const { at, context } = matches[first];
        const anchor = shortContext && context !== undefined ? passage.slice(begin, stop).trim() : passage.slice(at, at + sample);
        if (findMatches(page, [anchor], target, { anchors: true }).length > 1) matches.pop();
      }
    }
    return matches;
  }
  // Search within this index without creating a source/target connection.
  search(entry, scope = null) {
    const offset = scope?.start || 0, haystack = scope ? normalizedRange(this, offset, scope.end, offset) : this.normalized;
    const before = normalized(entry.before).text.trim(), after = normalized(entry.after).text.trim();
    return this.matches([entry.text], haystack, { before, after, best: true }) || this.matches([significantText(entry.text)],
      compact(haystack), { before: significantText(before), after: significantText(after), best: true });
  }
  locateSource(chunks) {
    const first = chunks[0], last = chunks.at(-1);
    this.connect(chunks.map(chunk => chunk.index));
    const entry = first.index.entry(first.start, first.end, undefined,
      chunks.map(({ index, start, end }) => index.raw.slice(start, end)).join("\n"));
    entry.after = last.index.raw.slice(last.end, last.end + 160);
    const left = this.connections.get(first.index)?.scope, right = this.connections.get(last.index)?.scope;
    const scope = left && right && left.start <= right.start ? { start: left.start, end: right.end } : null;
    const hit = chunks.length === 1
      ? this.locate(first.index, entry, true, scope)
      : this.search(entry, scope);
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
Object.assign(window.PdfSelectionDiff, { PdfConnections, documentIndex });
