import { ConnectionIndex, fontKeys, textDiff, localTextDiff, changedRange, normalized, lowerBound, significantText, anchorRanges, recoverWordRanges, comparisonParts, documentIndex, findMatches } from './pdf-selection-diff.js';
const forwardRangeKeys = ['start', 'end', 'targetStart', 'targetEnd'];
const reverseRangeKeys = ['targetStart', 'targetEnd', 'start', 'end'];
const covers = (range, start, end, [begin, stop] = forwardRangeKeys) => range[begin] <= start && range[stop] >= end;
const overlaps = (range, start, end, [begin, stop] = forwardRangeKeys) => range[begin] < end && range[stop] > start;

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
  get fullIndex() { return this.prepared?.full || documentIndex(this.documents, this.pdf, this.environment.getSourcePages?.()); }
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
  entry(start, end, marked, text = this.raw.slice(start, end)) {
    return { index: this, start, end, marked, text,
      before: this.raw.slice(Math.max(0, start - 160), start), after: this.raw.slice(end, end + 160) };
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
    const styles = this.formats.slice(start, end), keys = fontKeys.filter(key => typeof font[key] === 'boolean'
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
    const prepared = this.connect(pages, update);
    if (!prepared.differences || !this.fontsCurrent) {
      prepared.differences = { index: this, connections: this.pairs, items: this.candidates(null, true) };
      prepared.fonts = prepared.pages.map(({ parts, pages, fontVersion }) => ({ parts, pages, fontVersion }));
    }
    return prepared.differences;
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
      if (previous) {
        const { start, oldEnd, newEnd } = this.change, change = newEnd - oldEnd;
        const shift = (startAt, endAt) => endAt <= start ? 0 : startAt >= oldEnd ? change : null;
        const cached = previous.connections.get(page), original = cached?.ranges || [];
        const retain = item => {
          const delta = start === oldEnd && item.end === start && item.start < start ? null : shift(item.start, item.end);
          if (delta !== null) {
            const kept = item.copy(this, delta), diff = kept.editorDiff;
            if (diff?.context && diff.context[0] === previous.textVersion && this.formats?.slice(kept.start, kept.end).every((style, i) => {
              const at = item.start + i, old = previous.formats[at];
              return style.italic === old.italic && style.bold === old.bold && style.name === old.name
                && style.definition?.open === old.definition?.open
                && (!i || (style === this.formats[kept.start + i - 1]) === (old === previous.formats[at - 1]));
            })) {
              diff.context = [this.textVersion, ...diff.context.slice(1)];
              diff.fontItems = diff.fontItems.map(value => ({ ...value, sourceStart: value.sourceStart + delta,
                sourceEnd: value.sourceEnd + delta, htmlFont: this.formats[value.sourceStart + delta] }));
            }
            return kept;
          }
          if (item.start > start || item.end < oldEnd || !item.editorDiff || item.editorDiff.reliable === false) return null;
          // Keep unchanged missing tails outside the edited comparison. Otherwise a changed
          // final word can be aligned with repeated letters in an unrelated footnote.
          const last = item.start + item.editorDiff.lastPdfEnd;
          const end = last >= oldEnd ? last : item.end;
          return this.remember(item.start, end + change, page,
            { start: item.targetStart, end: item.targetEnd }, { previous: item, change: { start: start - item.start, oldEnd: oldEnd - item.start, newEnd: newEnd - item.start } });
        };
        const prepared = cached?.preparedRanges, migrated = prepared && prepared !== original ? new Map() : null;
        const retained = [];
        for (const item of original) {
          const kept = retain(item);
          migrated?.set(item, kept);
          if (kept) retained.push(kept);
        }
        if (retained.length) state.ranges = retained;
        const reverseScope = page.connections.get(previous);
        const reverse = (reverseScope?.ranges || []).flatMap(item => {
          const delta = shift(item.targetStart, item.targetEnd);
          return delta === null ? [] : [item.copy(this, delta, true)];
        });
        if (reverse.length || previous.raw === this.raw && reverseScope?.scope !== undefined)
          page.connections.set(this, { ...(previous.raw === this.raw ? reverseScope : {}), ranges: reverse.length ? reverse : undefined });
        const scope = cached?.scope, delta = scope && shift(scope.start, scope.end);
        if (scope && (delta !== null || retained.length && retained.length === original.length
          && covers(scope, start, oldEnd) && (prepared === original || prepared?.every(item => migrated.has(item))))) Object.assign(state, {
          prepared: cached.prepared, scope: { start: scope.start + (delta ?? 0), end: scope.end + (delta ?? change) },
          preparedRanges: prepared === original ? retained : prepared?.map(item => migrated.has(item) ? migrated.get(item) : retain(item)).filter(Boolean)
        });
      }
      if (!preparePage) continue;
      if (page === full && !full.sourcePages) full.connect(this);
      // Rendered pages reuse confirmed document mappings, including changed page tails.
      const entry = matchingPage(full, page);
      if (entry) {
        const projected = new Set();
        for (const connection of this.targetConnections(full)) {
          const start = Math.max(entry.start, connection.targetStart), end = Math.min(entry.end, connection.targetEnd);
          if (start >= end) continue;
          const hit = start === connection.targetStart && end === connection.targetEnd
            ? connection : this.range(full, start, end, true, connection);
          const mapping = hit && this.remember(hit.start, hit.end, page, { start: start - entry.start, end: end - entry.start },
            hit === connection && { connection });
          if (mapping) projected.add(mapping);
        }
        // A rendered page with identical text can reuse the cross-page alignment.
        if (full.sourcePages?.length > 1 && projected.size) {
          const preparedRanges = state.ranges.filter(item => projected.has(item));
          Object.assign(state, { scope: connectionBounds(preparedRanges), prepared: true, preparedRanges });
          continue;
        }
      }
      if (update?.range) {
        const { start, end, reverse } = update.range;
        const keys = reverse ? reverseRangeKeys : forwardRangeKeys, [begin, stop] = keys;
        const ordered = start < end ? [...this.targetConnections(page, false)].sort((a, b) => a[begin] - b[begin]) : noConnections;
        let mapped = false;
        for (let i = 0; i < ordered.length; i++) {
          const a = ordered[i - 1], b = ordered[i];
          mapped ||= covers(b, start, end, keys);
          if (!a || a[stop] >= end || b[begin] <= Math.max(start, a[stop]) || a.end > b.start || a.targetEnd > b.targetStart
            || Math.max(b.start - a.end, b.targetStart - a.targetEnd) > 2048) continue;
          if (a.gap?.next !== b) a.gap = { next: b, connection: this.remember(a.end, b.start, page, { start: a.targetEnd, end: b.targetStart }) };
          if (a.gap.connection) mapped ||= covers(a.gap.connection, start, end, keys);
        }
        if (!page.normalized || mapped) continue;
      }
      if (state.prepared) continue;
      // Establish whole-passage or layout-bounded anchor connections.
      const partial = page.layer && this.environment.getSourcePages?.()?.length > 1;
      const horizontal = page.horizontal || page.pages?.some(entry => entry.horizontal);
      const pageCount = page.sourcePages?.length;
      const layout = pageCount > 1 || partial || this.tags?.pairs.some(tag => tag.name === 'aside');
      // A physical page turn alone can split a word or paragraph. Use layout boundaries
      // when PDF extraction identifies separate passages, such as a page-bottom note.
      const blocks = layout || horizontal ? (
        page.pages?.some(entry => entry.breaks?.length)
          ? page.pages.flatMap(entry => [entry.start, ...(entry.breaks || []), entry.end])
          : (partial || horizontal) && page.breaks?.length ? [0, ...page.breaks, page.raw.length] : null) : null;
      const pageEnd = page.raw.length, reverse = page.targetConnections(this, false);
      for (const item of reverse) {
        this.remember(item.targetStart, item.targetEnd, page, item, { connection: item, reverse: true });
      }
      let scope = reverse.some(({ start, end }) => start === 0 && end === pageEnd)
        ? connectionBounds(reverse, true)
        : state.ranges?.find(item => item.targetStart === 0 && item.targetEnd === pageEnd);
      const recover = !!(pageCount || page.layer);
      if (!scope && !blocks) {
        const wholePage = { start: 0, end: pageEnd };
        scope = !partial && recover && this.remember(0, this.raw.length, page, wholePage, { recover });
        if (!scope) {
          const [hit, duplicate] = this.matches([page.raw], this.normalized, { limit: 2 });
          if (hit && !duplicate) scope = this.remember(hit.start, hit.end, page, wholePage) || hit;
        }
      }
      const size = blocks ? horizontal ? 12 : 16 : 24;
      const sourceBegin = this.raw.length - this.raw.trimStart().length;
      if (!scope && page.normalized.text.length >= size) {
        const anchors = this.matches([page.normalized.text], this.normalized,
          { sample: size, step: 8, anchors: !this.options.wholeWords, page, blocks, contextual: horizontal });
        let previous = null;
        for (const { start, end, targetStart, targetEnd, block } of anchorRanges(this, page, anchors, size, blocks)) {
          // Edge expansion can make adjacent anchor groups overlap. Compare their union
          // so a joined OCR word is not counted twice and selections can cross the seam.
          const sourceEnd = previous?.end ?? sourceBegin, pdfEnd = previous?.targetEnd ?? 0;
          const sourceGap = start - sourceEnd, pdfGap = targetStart - pdfEnd;
          const canMerge = previous && (blocks
            ? previous.targetStart >= blocks[block] && previous.start <= start
              && previous.targetStart <= targetStart && Math.abs(sourceGap) <= 8 && Math.abs(pdfGap) <= 8
            : sourceGap < 0 ? pdfGap === 0 : pdfGap < 0);
          const gap = !canMerge && !blocks && !partial && (previous ? sourceGap > 0 && pdfGap > 0 : pageCount && start <= 2048)
            && this.remember(sourceEnd, start, page, { start: pdfEnd, end: targetStart }, { recover });
          const next = (canMerge && this.remember(previous.start, Math.max(sourceEnd, end), page,
            { start: previous.targetStart, end: Math.max(pdfEnd, targetEnd) }, { extend: previous }))
            || this.remember(start, end, page, { start: targetStart, end: targetEnd });
          if (!recover && gap === null && next) previous.gap = { next, connection: null };
          previous = next;
        }
        if (!blocks && pageCount && previous) {
          // Earlier PDF pages can already cover HTML notes placed after the final body passage.
          let start = previous.end;
          if (pageCount > 1) {
            const text = /\S/g;
            text.lastIndex = previous.targetStart;
            const whitespaceEnd = text.exec(page.raw)?.index ?? pageEnd;
            for (const range of [...state.ranges].sort((a, b) => a.start - b.start)) {
              if (range.start > start) break;
              if (!range.recovered && range.targetStart < previous.targetStart && range.targetEnd <= whitespaceEnd)
                start = Math.max(start, range.end);
            }
          }
          if (this.raw.length - start <= 2048 && significantText(this.raw.slice(start))) {
            const tail = { start: previous.targetEnd, end: page.raw.trimEnd().length };
            this.remember(start, this.raw.trimEnd().length, page, tail, { recover });
          }
        }
      }
      const orderedSource = [...(state.ranges || noConnections)].sort((a, b) => a.start - b.start);
      for (const [start, end, next] of connectionGaps(orderedSource, sourceBegin)) {
        const length = end - start;
        if (length > 32) continue;
        const after = this.raw.slice(end, Math.min(next.end, end + 24));
        const bounds = { start: Math.max(0, next.targetStart - length - 32), end: next.targetEnd };
        const hit = page.search({ text: this.raw.slice(start, end), before: '', after }, bounds);
        if (hit && hit.end <= next.targetStart) this.remember(start, end, page, hit);
      }
      const ranges = state.ranges || noConnections;
      if (layout && ranges.length && (page.pages || page.breaks?.length)) {
        const tags = this.tags?.pairs || [], labels = new Map();
        let tailStart = this.raw.length;
        for (const tag of tags.filter(tag => tag.name === 'aside' && tag.rawEnd !== undefined).sort((a, b) => b.rawEnd - a.rawEnd))
          if (tag.rawEnd <= tailStart && !this.raw.slice(tag.rawEnd, tailStart).trim()) tailStart = tag.rawStart;
        if (tailStart === this.raw.length) tailStart = connectionBounds(ranges).end;
        for (const tag of tags) if (tag.name === 'a' && /\bhref\s*=\s*["']#/iu.test(tag.open)) labels.set(tag.rawStart, tag.rawEnd);
        const ordered = [...ranges].sort((a, b) => a.targetStart - b.targetStart);
        const gaps = [], tail = this.raw.slice(tailStart).trimEnd();
        let first = 0;
        for (const entry of tail ? page.pages || [{ start: 0, end: page.raw.length, breaks: page.breaks }] : []) {
          while (first < ordered.length && ordered[first].targetEnd <= entry.start) first++;
          const touching = ordered.slice(first, lowerBound(ordered, entry.end, range => range.targetStart));
          const bodyEnd = touching.reduce((end, range) => range.start < tailStart ? Math.max(end, range.targetEnd) : end, entry.start);
          const footer = bodyEnd > entry.start ? bodyEnd : entry.breaks?.at(-1);
          if (footer === undefined) continue;
          for (const [start, end] of connectionGaps(touching, footer, entry.end, true)) {
            const raw = page.raw.slice(start, end), view = compact(normalized(raw));
            const stops = new Set(Array.from(raw.matchAll(/[\r\n–—-]|$/gu), match => lowerBound(view.ends, match.index + 1)));
            stops.delete(0);
            if (stops.size) gaps.push({ start, view, stops });
          }
        }
        const proposed = [];
        for (const line of gaps.length ? tail.matchAll(/\S[^\r\n]*/gu) : []) {
          const text = line[0].trimEnd(), start = tailStart + line.index, end = start + text.length;
          if (ranges.some(range => overlaps(range, start, end))) continue;
          // A backlink supplies the body boundary. For plain text, try the full line and
          // the suffix after its first token, irrespective of how that token is written.
          const labelEnd = labels.get(start), firstSpace = text.search(/\s/u);
          const bodies = labelEnd > start && labelEnd < end ? [labelEnd] : firstSpace > 0 ? [start, start + firstSpace] : [start];
          let hit;
          for (const bodyStart of bodies) {
            const needle = compact(normalized(this.raw.slice(bodyStart, end))).text;
            if (needle.length < 8 || (needle.match(/\p{L}/gu)?.length || 0) < 3) continue;
            const budget = Math.min(3, Math.floor(needle.length / 4));
            for (const gap of gaps) for (const stop of gap.stops) {
              const { text, starts, ends } = gap.view, to = gap.start + ends[stop - 1];
              let i = stop - needle.length, distance = 0;
              if (i < 0 || !text.startsWith(needle, i)) {
                // Compare the whole bounded body, including OCR insertions and deletions.
                const line = page.raw.lastIndexOf('\n', to - 1) + 1;
                const label = labelEnd === bodyStart && line >= gap.start
                  && /^[^\S\r\n]*\S+[^\S\r\n]+/u.exec(page.raw.slice(line, to));
                if (!label) continue;
                i = lowerBound(starts, line + label[0].length - gap.start);
                distance = textDiff(needle, text.slice(i, stop), false, budget).distance;
              }
              const at = gap.start + starts[i];
              if (distance > budget || /^\p{L}/u.test(needle) && /\p{L}/u.test(page.raw[at - 1] || '')) continue;
              if (!hit || distance < hit.distance) hit = { gap, at, to, start, end, bodyStart, distance };
              else if (distance === hit.distance) hit.tied = true;
            }
            if (hit) break; // A full-line match takes priority, including a tie.
          }
          if (hit && !hit.tied) proposed.push(hit);
        }
        for (const [i, hit] of proposed.sort((a, b) => a.at - b.at).entries()) {
          const previous = proposed[i - 1];
          if (previous?.to > hit.at || proposed[i + 1]?.at < hit.to) continue;
          const from = previous?.gap === hit.gap ? previous.to : hit.gap.start;
          // Include the adjacent label in the comparison only after the bodies agree.
          const label = hit.bodyStart > hit.start && /(?:^|\s)\S+\s*$/u.exec(page.raw.slice(from, hit.at));
          const start = label ? hit.at - label[0].trimStart().length : hit.at;
          this.remember(hit.start, hit.end, page, { start, end: hit.to });
        }
      }
      state.preparedRanges = state.ranges || noConnections;
      state.scope = state.preparedRanges.length && (!scope || blocks) ? connectionBounds(state.preparedRanges) : scope || null;
      state.prepared = true;
    }
    if (scoped) return this.connections.get(pages)?.scope;
    if (!prepare) return previousState;
    pages = [...targets];
    const connections = this.targetConnections(pages);
    const prune = (ranges, page) => {
      const kept = ranges?.filter(item => !connections.some(other => other.target !== page && !other.target.pages
        && covers(other, item.start, item.end) && other.end - other.start > item.end - item.start));
      return kept?.length === ranges?.length ? ranges : kept;
    };
    const snapshots = pages.map(page => {
      const state = this.connections.get(page);
      if (!page.pages && state) {
        const ranges = prune(state.ranges, page);
        state.preparedRanges = state.preparedRanges === state.ranges ? ranges : prune(state.preparedRanges, page);
        state.ranges = ranges;
      }
      return this.targetConnections(page);
    });
    this.prepared = { pdf: this.pdf, full, pages, connections: snapshots, pairs: connections };
    for (const connection of this.pairs) this.compare(connection);
    return this.prepared;
  }
  get livePairs() { return this.targetConnections(this.prepared?.pages || [], false); }
  compare(connection, diff = connection?.editorDiff, update) {
    const target = connection?.target;
    if (!diff || update) diff = connection.editorDiff = textDiff(connection.html ?? this.raw.slice(connection.start, connection.end),
      connection.pdf ?? target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true, update && { ...update, previous: diff });
    const context = [this.textVersion, target?.parts, target?.pages, target?.fontVersion];
    if (diff.context?.every((value, i) => value === context[i])) return diff.reliable ? diff : null;
    if (!diff.ranges) {
      diff.reliable = true; diff.edges = []; diff.reviewRanges = [];
      diff.ranges = diff.parts ||= [];
      let sourceEnd = 0, targetEnd = 0;
      for (const range of diff.ranges) {
        if (!(range instanceof ConnectionIndex)) {
          Object.setPrototypeOf(range, ConnectionIndex.prototype);
          range.start ??= sourceEnd; range.targetStart ??= targetEnd;
          range.end = range.start + range.html.length; range.targetEnd = range.targetStart + range.pdf.length;
        }
        sourceEnd = range.end; targetEnd = range.targetEnd;
        if (range.inconsistent) {
          if (!connection.spans) diff.reviewRanges.push(range);
          if (!(diff.distance <= 256) && range.significant.some(text => text.length > 256)) diff.reliable = false;
        }
        const [sourceBlank, targetBlank] = range.blank;
        if (!targetBlank) diff.lastPdfEnd = range.end;
        if (!sourceBlank && !targetBlank) diff.edges.push(range);
        if (!range.changed && /\p{L}/u.test(range.pdf)) {
          diff.mappedFirst ??= range.start;
          diff.mappedLast = range.end;
        }
      }
      if (connection?.spans) {
        const left = this.normalized, right = target.normalized;
        const h = lowerBound(left.starts, connection.start), p = lowerBound(right.starts, connection.targetStart);
        const bounds = (view, at, length) => {
          const start = view.starts[at] ?? view.ends.at(-1);
          return [start, length ? view.ends[at + length - 1] : start];
        };
        const reversed = connection.reversedSpans;
        const [start, , from] = reversed ? reverseRangeKeys : forwardRangeKeys;
        const html = reversed ? 'pdf' : 'html', pdf = reversed ? 'html' : 'pdf';
        for (const span of connection.spans) if (span.changed) {
          const [a, b] = bounds(left, h + span[start], span[html].length);
          const [x, y] = bounds(right, p + span[from], span[pdf].length);
          const range = new ConnectionIndex(this.raw.slice(a, b), target.raw.slice(x, y), a - connection.start, x - connection.targetStart, true);
          if (range.inconsistent) diff.reviewRanges.push(range);
        }
      }
    }
    diff.context = context;
    diff.fontItems = [];
    const runs = this.formats && target ? target.fontRuns(connection.targetStart, connection.targetEnd) : [];
    for (const part of runs.length ? diff.ranges : []) {
      const start = connection.start + part.start, pdfStart = connection.targetStart + part.targetStart, pdfEnd = connection.targetStart + part.targetEnd;
      let compared = runs.slice(lowerBound(runs, pdfStart + Number(part.targetStart < part.targetEnd), font => font.end),
        lowerBound(runs, pdfEnd + Number(part.targetStart === part.targetEnd), font => font.start));
      if (part.changed && compared.length) {
        const font = { ...compared[0], start: pdfStart, end: pdfEnd };
        for (const key of fontKeys) if (!compared.every(value => value[key] === font[key])) font[key] = null;
        compared = [font];
      }
      for (const font of compared) {
        if (!fontKeys.some(key => typeof font[key] === 'boolean')) continue;
        let at = part.changed ? start : start + Math.max(pdfStart, font.start) - pdfStart;
        const end = part.changed ? connection.start + part.end : start + Math.min(pdfEnd, font.end) - pdfStart;
        while (at < end) {
          const htmlFont = this.formats[at];
          let stop = at + 1;
          while (stop < end && this.formats[stop] === htmlFont) stop++;
          if (htmlFont && fontKeys.some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key])) {
            const text = this.raw.slice(at, stop), sourceStart = at + (text.match(/^\s*/)?.[0].length || 0), sourceEnd = stop - (text.match(/\s*$/)?.[0].length || 0);
            if (sourceStart < sourceEnd) diff.fontItems.push({ sourceStart, sourceEnd, font, htmlFont });
          }
          at = stop;
        }
      }
    }
    return diff.reliable ? diff : null;
  }
  remember(start, end, target, hit, alignment) {
    if (start > end || hit.start > hit.end) return null;
    const state = this.connections.get(target) || {};
    const previous = alignment?.previous, aligned = alignment?.connection, extend = alignment?.extend;
    const existing = state.ranges?.find(item => item.start === start && item.end === end
      && item.targetStart === hit.start && item.targetEnd === hit.end);
    if (existing) {
      const at = extend && extend !== existing ? state.ranges.indexOf(extend) : -1;
      if (at >= 0) state.ranges.splice(at, 1);
      return existing;
    }
    let diff;
    if (!aligned) {
      const left = normalizedRange(this, start, end), right = normalizedRange(target, hit.start, hit.end);
      if (!left.text && !right.text) return null;
      diff = alignment?.recover
        ? localTextDiff(left.text, right.text, true, Math.max(left.text.length, right.text.length) <= 128 ? Infinity : 128)
        : textDiff(left.text, right.text, true);
      if (diff.distance > 128 && diff.parts.some(part => part.changed && Math.max(part.html.length, part.pdf.length) > 128)
        || alignment?.recover && diff.distance > 32 && !diff.parts.some(part => !part.changed && /[\p{L}\p{N}]{2}/u.test(part.html))) {
        if (alignment?.recover) for (const [from, at, to, stop] of recoverWordRanges(left.text, right.text)) {
          const connection = this.remember(start + left.starts[from], start + left.ends[to - 1], target,
            { start: hit.start + right.starts[at], end: hit.start + right.ends[stop - 1] });
          if (connection) connection.recovered = true;
        }
        return null;
      }
    }
    if (extend) extend.editorDiff = extend.gap = extend.recovered = undefined;
    const connection = extend ? extend.extend(end, hit.end)
      : ConnectionIndex.between(this, start, end, target, hit.start, hit.end, previous);
    connection.distance = aligned ? aligned.distance : diff.distance;
    connection.spans = aligned ? aligned.spans : diff.parts;
    connection.reversedSpans = !!aligned && !!aligned.reversedSpans !== !!alignment.reverse;
    if (previous?.editorDiff) this.compare(connection, previous.editorDiff, alignment.change || {});
    state.ranges = (state.ranges === state.preparedRanges ? state.ranges?.slice() : state.ranges) || [];
    for (let i = state.ranges.length - 1; i >= 0; i--) {
      const item = state.ranges[i];
      if (item === connection || item.start === start && item.end === end) state.ranges.splice(i, 1);
    }
    state.ranges.unshift(connection);
    state.ranges.length = Math.min(state.ranges.length, Math.max(16, this.raw.length));
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
      this.connect(target, { range: { start, end, reverse } });
      connections = [...this.targetConnections(target, false)].sort((a, b) => a[begin] - b[begin]).flatMap((b, i, ordered) => {
        const gap = ordered[i - 1]?.gap;
        return gap?.next === b && gap.connection ? [gap.connection, b] : [b];
      });
      connection = start < end && connections.find(containing);
    }
    let first = Infinity, last = -1, covered = start;
    for (const item of connection ? [connection] : connections) {
      if (!connection && !(start === end ? containing(item) : overlaps(item, start, end, keys))) continue;
      const diff = this.compare(item);
      if (!diff) continue;
      if (item[begin] > covered) return null;
      covered = Math.max(covered, item[stop]);
      const a = start - item[begin], b = end - item[begin], offset = item[mappedBegin];
      const ranges = diff.ranges;
      let low = lowerBound(ranges, a, span => span[stop]), high = lowerBound(ranges, b + 1, span => span[begin]) - 1;
      const touches = span => {
        const left = span[begin], right = span[stop];
        if (a === b) return span.changed && (left === right || marked && span.blank[+reverse]);
        return left === right && span.significant[1 - +reverse] || (right > a && left < b);
      };
      while (low <= high && !touches(ranges[low])) low++;
      while (low <= high && !touches(ranges[high])) high--;
      if (low > high) continue;
      const left = ranges[low], right = ranges[high];
      first = Math.min(first, offset + left[mappedBegin] + (left.changed ? 0 : Math.max(0, a - left[begin])));
      last = Math.max(last, offset + (right.changed ? right[mappedEnd] : right[mappedBegin] + Math.min(b, right[stop]) - right[begin]));
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
    return { ...hit, connection: this.remember(reverse ? hit.start : entry.start, reverse ? hit.end : entry.end, target,
      reverse ? { start: entry.start, end: entry.end } : hit) };
  }

  // The same confirmed edges locate missing text for the queue and for PDF selections.
  missingRange(target, start, end = start) {
    let ranges = this.prepared?.differences?.items?.missingRanges;
    if (!ranges?.context) ranges = this.candidates(null, false, false, true, [target], undefined, true).missingRanges;
    const { context } = ranges;
    if (start === undefined || !context) return ranges;
    const hit = ranges.find(range => !range.resolved && range.sourceStart <= start && range.sourceEnd >= end), a = hit?.edge;
    if (!hit?.matched) return null;
    const parts = ranges.parts ||= context.index.fontRuns(0, context.index.raw.length, true);
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
  // One traversal collects review items, uncovered intervals and their PDF edges.
  addCandidate({ items, ranges, compared, missingOnly, edits }, start, part, connection, outside = false, missing = false) {
    const number = /^[^\p{L}\d]*(\d+)[^\p{L}\d]*$/u;
    const left = number.exec(part.html), right = number.exec(part.pdf), digits = left && right;
    const html = digits ? left[1] : part.html, pdf = digits ? right[1] : part.pdf;
    const from = start + (digits ? left[0].indexOf(html) : 0), end = from + html.length;
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
      missing = outside && !insideWord && /[\p{L}\p{N}]/u.test(part.html)
        && (!part.pdf.trim() || /\p{L}/u.test(part.html) && !/\p{L}/u.test(part.pdf));
      if (missing) ranges.push({ sourceStart: from, sourceEnd: end, connection });
      if (!missingOnly && first !== connection) return;
    }
    if (missingOnly) return;
    const at = lowerBound(items, from, item => item.sourceStart), next = items[at];
    if (at && items[at - 1].sourceEnd > from
      || next && (end === from ? next.sourceStart === from : next.sourceStart < end && next.sourceEnd > from)) return;
    const splitGlyph = this.starts?.[from] < this.ends?.[from - 1] || this.starts?.[end] < this.ends?.[end - 1];
    items.splice(at, 0, { id: `${from}:${end}`, sourceStart: from, sourceEnd: end, ...(missing && { missing: true }),
      comparison: { html, pdf }, options: [{ id: 'pdf', label: '替换', edits: edits && !missing && !splitGlyph ? this.textEdits(from, end, pdf) : [] }] });
  }
  candidates(notice = null, fonts = false, edits = true, text = true,
    targets = notice ? [] : this.prepared?.pages || [], connections, missingOnly = false) {
    connections ??= targets === this.prepared?.pages ? this.pairs : this.targetConnections(targets);
    const target = missingOnly ? targets[0] : text && (targets.find(page => page?.sourcePages?.length)
      || connections.find(connection => connection.target?.sourcePages?.length)?.target);
    const live = connections.length ? connections : this.livePairs;
    const compared = live.length || !missingOnly ? live : this.targetConnections(target?.layer ? this.prepared?.full : target);
    const index = target?.layer ? this.fullIndex : target, page = target?.layer && matchingPage(index, target);
    const context = target && index && (!target.layer || page) ? { index, page, offset: page?.start || 0 } : null;
    const items = [], ranges = [], edges = [], ordered = [];
    const review = { items, ranges, compared, missingOnly, edits };
    const prepared = this.connections.get(target)?.prepared;
    let gaps = missingOnly || prepared;
    for (const connection of text && (!target || context) ? compared : []) {
      gaps ||= connections.length > 0 && connection.target === target && connection.recovered;
      const mapped = connection.target;
      const base = !context || mapped === index || mapped?.layer && !index.pages?.length
        ? 0 : matchingPage(index, mapped)?.start ?? null;
      const diff = this.compare(connection);
      if (!diff) continue;
      if (base !== null) {
        ordered.push(connection);
        for (const edge of diff.edges) edges.push({ sourceEnd: connection.start + edge.sourceEdge,
          targetEnd: base + connection.targetStart + edge.targetEdge });
      }
      for (const part of diff.reviewRanges)
        this.addCandidate(review, connection.start + part.start, part, connection, base !== null && (diff.mappedFirst === undefined || part.end <= diff.mappedFirst || part.start >= diff.mappedLast));
    }
    if (text && gaps && context) for (const [sourceStart, sourceEnd] of connectionGaps(ordered.sort((a, b) => a.start - b.start),
      this.raw.length - this.raw.trimStart().length, this.raw.trimEnd().length)) ranges.push({ sourceStart, sourceEnd });
    edges.sort((a, b) => a.sourceEnd - b.sourceEnd);
    if (text && notice?.source && this.raw.slice(notice.source.start, notice.source.end) === notice.html)
      for (const part of comparisonParts(notice)) this.addCandidate(review, notice.source.start + part.start, part);
    let at = 0, edge = 0;
    for (const range of ranges.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      while (at < edges.length && edges[at].sourceEnd <= range.sourceStart) edge = edges[at++].targetEnd;
      const hit = !range.connection && target && prepared
        && this.range(target, range.sourceStart, range.sourceEnd, false, undefined, true);
      const resolved = !!(hit && !hit.approximate && /[\p{L}\p{N}]/u.test(target.raw.slice(hit.start, hit.end)));
      Object.assign(range, { edge, matched: !!edges.length, resolved });
      const html = this.raw.slice(range.sourceStart, range.sourceEnd);
      if (!resolved && significantText(html)) this.addCandidate(review, range.sourceStart, { html, pdf: '' }, undefined, false, true);
    }
    const result = missingOnly ? items : this.formatDifferences(items, fonts, edits, connections);
    Object.defineProperty(result, 'missingRanges', { value: Object.assign(ranges, { context }) });
    return result;
  }
  formatDifferences(candidates = [], keys = fontKeys, edits = true, connections = this.pairs) {
    keys = keys === true ? fontKeys : keys || [];
    const absent = candidates.filter(item => item.missing).sort((a, b) => a.sourceStart - b.sourceStart);
    let end = -Infinity;
    const ends = absent.map(item => end = Math.max(end, item.sourceEnd));
    const missing = item => ends[lowerBound(absent, item.sourceEnd, value => value.sourceStart) - 1] > item.sourceStart;
    candidates = candidates.filter(item => !item.font || keys.length === 2 && !missing(item));
    if (keys.length === 2 && candidates.some(item => item.font) || !this.formats || !keys.length) return candidates;
    const items = new Map();
    for (const connection of connections)
      for (const item of this.compare(connection)?.fontItems || []) {
        if (missing(item)) continue;
        const font = { ...item.font }, id = `font:${item.sourceStart}:${item.sourceEnd}`;
        for (const key of fontKeys) if (!keys.includes(key)) font[key] = null;
        if (!items.has(id) && keys.some(key => typeof font[key] === 'boolean' && font[key] !== item.htmlFont[key]))
          items.set(id, { ...item, font, formats: [{ font, htmlFont: item.htmlFont }] });
      }
    // Merge adjacent format changes, or bridge punctuation with the same mismatch.
    const formats = [];
    for (const item of [...items.values()].sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      const previous = formats.at(-1), gap = previous && this.raw.slice(previous.sourceEnd, item.sourceStart);
      const joins = previous && item.sourceStart >= previous.sourceEnd && !/[\r\n]/.test(gap)
        && previous.htmlFont.tags === item.htmlFont.tags
        && fontKeys.every(key => previous.font[key] === item.font[key] && previous.htmlFont[key] === item.htmlFont[key])
        && (!gap.trim() || !(/\s/u.test(gap) && /[\p{L}\p{N}]/u.test(gap)) && fontKeys.some(key =>
          typeof previous.font[key] === 'boolean'
          && this.formats.slice(previous.sourceEnd, item.sourceStart).every((style, i) =>
            /\s/u.test(gap[i]) || (style && style[key] !== previous.font[key]))));
      if (!joins) { formats.push(item); continue; }
      previous.sourceEnd = item.sourceEnd;
      previous.formats.push(...item.formats);
    }
    for (const item of formats) {
      Object.assign(item, { id: `font:${item.sourceStart}:${item.sourceEnd}`, text: this.raw.slice(item.sourceStart, item.sourceEnd),
        options: edits ? [{ id: 'format', edits: this.fontEdits(item.sourceStart, item.sourceEnd, item.font) }] : [] });
      const nearby = candidates[lowerBound(candidates, item.sourceStart, range => range.sourceEnd)];
      item.reviewStart = nearby && nearby.sourceStart <= item.sourceEnd ? nearby.sourceStart : item.sourceStart;
    }
    return candidates.concat(formats).sort((a, b) => (a.reviewStart ?? a.sourceStart) - (b.reviewStart ?? b.sourceStart) || Number(!!a.font) - Number(!!b.font));
  }
  matches(queries, haystack = this.normalized, options = {}) {
    if (!options.sample) return findMatches(this, queries, haystack, options);
    const { sample, step = 0, anchors = false, wholeWords = this.options?.wholeWords, page, blocks, contextual = false } = options;
    const target = page?.normalized, connections = target && this.targetConnections(page, false), matches = [];
    const boundaries = blocks?.map(raw => lowerBound(target.starts, raw));
    for (const [block, query] of (blocks ? blocks.slice(0, -1) : queries).entries()) {
      const passage = blocks ? target.text : query, begin = boundaries?.[block] ?? 0, stop = boundaries?.[block + 1] ?? passage.length;
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
        const hits = mapped && !mapped.approximate ? [mapped] : findMatches(this, [fragment], haystack, { anchors, wholeWords, limit: 2 });
        let hit = hits.length === 1 ? hits[0] : null;
        if (hits.length > 1 && blocks && contextual) {
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
Object.assign(window.PdfSelectionDiff, { PdfConnections, ConnectionIndex });
