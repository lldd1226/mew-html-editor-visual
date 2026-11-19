import { diffIndex, fontKeys, textDiff, localTextDiff, changedRange, normalized, lowerBound, significantText, extendPageRange, closestEdge, findMatches, mapDiffRange, forwardRangeKeys, reverseRangeKeys } from './pdf-selection-diff.js';
const covers = (range, start, end, [begin, stop] = forwardRangeKeys) => range[begin] <= start && range[stop] >= end;
const overlaps = (range, start, end, [begin, stop] = forwardRangeKeys) => range[begin] < end && range[stop] > start;

function documentIndex(documents, pdf, numbers) {
  const index = documents?.get(pdf)?.get(numbers ? `pages:${numbers.join(',')}` : '');
  return index?.normalized ? index : undefined;
}
const lineStart = (raw, at) => raw.lastIndexOf('\n', at - 1) + 1;
const letters = text => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

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
      if (previous) {
        const { start, oldEnd, newEnd } = this.change, change = newEnd - oldEnd;
        const shift = (startAt, endAt) => endAt <= start ? 0 : startAt >= oldEnd ? change : null;
        const cached = previous.connections.get(page), original = cached?.ranges || [];
        const retain = item => {
          const delta = start === oldEnd && item.end === start && item.start < start ? null : shift(item.start, item.end);
          if (delta !== null) {
            const kept = item.copy(this, delta);
            kept.gap = undefined;
            if (kept.comparisonContext && kept.comparisonVersion === previous.textVersion && this.formats?.slice(kept.start, kept.end).every((style, i) => {
              const at = item.start + i, old = previous.formats[at];
              return style.italic === old.italic && style.bold === old.bold && style.name === old.name
                && style.definition?.open === old.definition?.open
                && (!i || (style === this.formats[kept.start + i - 1]) === (old === previous.formats[at - 1]));
            })) kept.comparisonVersion = this.textVersion;
            return kept;
          }
          if (item.start > start || item.end < oldEnd || !item.editorDiff || item.editorDiff.reliable === false) return null;
          // Keep unchanged missing tails outside the edited comparison. Otherwise a changed
          // final word can be aligned with repeated letters in an unrelated footnote.
          const last = item.editorDiff.parts?.findLast(part => part.pdf.trim());
          const end = last && item.start + last.end >= oldEnd ? item.start + last.end : item.end;
          return this.remember(item.start, end + change, page, item.targetStart, item.targetEnd,
            { previous: item, change: { start: start - item.start, newEnd: newEnd - item.start, previous: item.editorDiff } });
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
          return delta === null ? [] : [Object.assign(item.copy(this, delta, true), { gap: undefined })];
        });
        if (reverse.length || previous.raw === this.raw && reverseScope?.scope !== undefined)
          page.connections.set(this, { ...(previous.raw === this.raw ? reverseScope : {}), ranges: reverse.length ? reverse : undefined });
        const scope = cached?.scope;
        if (scope) {
          const delta = shift(scope.start, scope.end);
          const keepsScope = delta !== null || (
            retained.length > 0 && retained.length === original.length
            && covers(scope, start, oldEnd)
            && (prepared === original || prepared?.every(item => migrated.has(item)))
          );
          if (keepsScope) {
            state.prepared = cached.prepared;
            state.scope = { start: scope.start + (delta ?? 0), end: scope.end + (delta ?? change) };
            state.preparedRanges = prepared === original ? retained
              : prepared?.map(item => migrated.has(item) ? migrated.get(item) : retain(item)).filter(Boolean);
          }
        }
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
          const mapping = hit && this.remember(hit.start, hit.end, page, start - entry.start, end - entry.start,
            hit === connection && { connection });
          if (mapping) projected.add(mapping);
        }
        // A rendered page with identical text can reuse the cross-page alignment.
        if (full.sourcePages?.length > 1 && projected.size) {
          state.preparedRanges = state.ranges.filter(item => projected.has(item));
          state.scope = connectionBounds(state.preparedRanges);
          state.prepared = true;
          continue;
        }
      }
      if (update?.range) {
        const { start, end, reverse } = update.range;
        const keys = reverse ? reverseRangeKeys : forwardRangeKeys, [begin, stop] = keys;
        const ordered = start < end && state.ranges ? [...state.ranges].sort((a, b) => a[begin] - b[begin]) : noConnections;
        let mapped = false;
        for (let i = 0; i < ordered.length; i++) {
          const a = ordered[i - 1], b = ordered[i];
          mapped ||= covers(b, start, end, keys);
          if (!a || a[stop] >= end || b[begin] <= Math.max(start, a[stop]) || a.end > b.start || a.targetEnd > b.targetStart
            || Math.max(b.start - a.end, b.targetStart - a.targetEnd) > 2048) continue;
          if (a.gap?.next !== b) a.gap = { next: b, connection: this.remember(a.end, b.start, page, a.targetEnd, b.targetStart) };
          mapped ||= !!a.gap.connection && covers(a.gap.connection, start, end, keys);
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
        this.remember(item.targetStart, item.targetEnd, page, item.start, item.end, { connection: item, reverse: true });
      }
      let scope = reverse.some(({ start, end }) => start === 0 && end === pageEnd)
        ? connectionBounds(reverse, true)
        : state.ranges?.find(item => item.targetStart === 0 && item.targetEnd === pageEnd);
      const recover = !!(pageCount || page.layer);
      if (!scope && !blocks) {
        scope = !partial && recover && this.remember(0, this.raw.length, page, 0, pageEnd, { recover });
        if (!scope) {
          const [hit, duplicate] = this.matches([page.raw], this.normalized, { limit: 2 });
          if (hit && !duplicate) scope = this.remember(hit.start, hit.end, page, 0, pageEnd) || hit;
        }
      }
      const size = blocks ? horizontal ? 12 : 16 : 24;
      const sourceBegin = this.raw.length - this.raw.trimStart().length;
      if (!scope && page.normalized.text.length >= size) {
        const source = this.normalized, target = page.normalized;
        const anchors = this.matches(page, source, size, blocks, horizontal);
        const maxDistance = 32, count = blocks ? anchors.length : anchors.length - 1;
        let pending, previous = null;
        // Keep a normalized anchor group until the next match can no longer extend it.
        for (let i = 0; i <= count; i++) {
          const range = pending;
          if (i < count) {
            const anchor = anchors[i], following = anchors[i + 1];
            let next = following && following.block === anchor.block ? following : anchor, nextIndex = i + 1;
            if (blocks && next.start - anchor.start - (next.at - anchor.at) > maxDistance) {
              // A character difference can send an exact anchor to a later copy of the phrase.
              for (let j = i + 2; j < anchors.length; j++) {
                const candidate = anchors[j];
                if (candidate.block !== anchor.block || candidate.at - anchor.at > size * 4) break;
                if (candidate.start > anchor.start && candidate.start < next.start) {
                  next = candidate;
                  nextIndex = j;
                  break;
                }
              }
            }
            const anchorEnd = next.at + size;
            const length = Math.min(anchorEnd, target.text.length) - anchor.at;
            if (next !== anchor && next.start <= anchor.start || length > 2048) continue;
            const cost = (pdfStart, htmlStart, budget) => textDiff(
              target.text.slice(pdfStart, anchorEnd), source.text.slice(htmlStart, next.end), false, budget).distance;
            const limit = Math.min(maxDistance, Math.max(12, Math.floor(length * .2)));
            const adjacent = cost(anchor.at, anchor.start, limit);
            if (adjacent > limit) continue;
            i = nextIndex - 1;
            const overlaps = pending && pending.block === anchor.block && pending.targetEnd >= anchor.at && pending.end >= anchor.start;
            if (overlaps) {
              const budget = 128 - pending.distance;
              const suffix = next.end >= pending.end && pending.end >= pending.start
                ? cost(pending.targetEnd, pending.end, budget)
                : Infinity;
              const distance = suffix <= budget ? pending.distance + suffix : cost(pending.at, pending.start, 128);
              if (distance <= 128) {
                pending.targetEnd = anchorEnd; pending.end = next.end; pending.distance = distance;
                continue;
              }
            }
            pending = anchor;
            pending.targetEnd = anchorEnd; pending.end = next.end; pending.distance = adjacent;
          }
          // The final iteration also commits the last group.
          if (!range) continue;
          // Expand the completed anchor group before comparing it with the last connection.
          const begin = range.begin ?? 0, passage = blocks ? target.text.slice(begin, range.stop) : target.text;
          const word = blocks ? null : undefined;
          let [pdfStart, htmlStart] = extendPageRange(passage, source.text, range.at - begin, range.start, -1, false, word);
          let [pdfEnd, htmlEnd] = extendPageRange(passage, source.text, range.targetEnd - begin, range.end, 1, false, word);
          pdfStart += begin;
          pdfEnd += begin;
          const pdfLead = Math.max(begin, lowerBound(target.starts, lineStart(page.raw, target.starts[pdfStart])));
          const htmlLead = lowerBound(source.starts, lineStart(this.raw, source.starts[htmlStart]));
          const lineLead = pdfStart > pdfLead && htmlStart > htmlLead && pdfStart - pdfLead <= 32 && htmlStart - htmlLead <= 32
            ? source.text.slice(htmlLead, htmlStart) : '';
          if (/[\p{L}\p{N}]/u.test(lineLead) && (!/\p{L}/u.test(target.text.slice(pdfLead, pdfStart)) || /\p{L}/u.test(lineLead))
            && !/[\r\n]/.test(page.raw.slice(target.starts[pdfStart], target.ends[pdfStart])
              + this.raw.slice(source.starts[htmlStart], source.ends[htmlStart]))) [pdfStart, htmlStart] = [pdfLead, htmlLead];
          if (!blocks && page.sourcePages?.length > 1 && /\p{L}/u.test(target.text[pdfEnd] || '') && /\p{L}/u.test(source.text[htmlEnd] || '')) {
            const pdfLine = lineStart(page.raw, target.starts[pdfEnd]), htmlLine = lineStart(this.raw, source.starts[htmlEnd]);
            // Crossing into the next line requires matching words beyond the break.
            if (pdfLine > target.starts[range.targetEnd - 1] && htmlLine > source.starts[range.end - 1]
              && !/\p{L}{2}/u.test(page.raw.slice(pdfLine, target.ends[pdfEnd - 1]) + ' ' + this.raw.slice(htmlLine, source.ends[htmlEnd - 1]))) {
              pdfEnd = lowerBound(target.starts, pdfLine - 1); htmlEnd = lowerBound(source.starts, htmlLine - 1);
            }
          }
          let start = source.starts[htmlStart], end = source.ends[htmlEnd - 1];
          let targetStart = target.starts[pdfStart], targetEnd = target.ends[pdfEnd - 1];
          if (blocks) {
            // Use the confirmed passage as context for short unmatched line edges.
            const from = Math.max(blocks[range.block], lineStart(page.raw, targetStart));
            const lead = significantText(page.raw.slice(from, targetStart));
            if (lead && lead.length <= 32) {
              const first = Math.max(0, htmlStart - lead.length - 8);
              const edges = Array.from({ length: htmlStart - first }, (_, i) => first + i)
                .filter(at => Math.abs(htmlStart - at - lead.length) <= 4 || source.text[at] === ' ');
              const at = closestEdge(lead, edges, at => significantText(source.text.slice(at, htmlStart)), Math.max(1, Math.floor(lead.length / 4)));
              if (at !== undefined) { start = source.starts[at]; targetStart = from; }
            }
            const nextLine = page.raw.indexOf('\n', targetEnd);
            const to = nextLine < 0 ? blocks[range.block + 1] : Math.min(nextLine, blocks[range.block + 1]);
            if (to - targetEnd <= 48) {
              const tail = letters(page.raw.slice(targetEnd, to)), stop = Math.min(this.raw.length, end + 49);
              const edges = Array.from(this.raw.slice(end, stop).matchAll(/\s+|$/gu), match => end + match.index)
                .filter(at => at < stop || at === this.raw.length);
              const at = closestEdge(tail, edges, at => letters(this.raw.slice(end, at)), Math.floor(tail.length / 4));
              if (at !== undefined) { end = at; targetEnd = to; }
            }
          }

          // Edge expansion can make adjacent anchor groups overlap. Compare their union
          // so a joined OCR word is not counted twice and selections can cross the seam.
          const sourceEnd = previous?.end ?? sourceBegin, previousTargetEnd = previous?.targetEnd ?? 0;
          const sourceGap = start - sourceEnd, pdfGap = targetStart - previousTargetEnd;
          const canMerge = previous && (blocks
            ? previous.targetStart >= blocks[range.block] && previous.start <= start
              && previous.targetStart <= targetStart && Math.abs(sourceGap) <= 8 && Math.abs(pdfGap) <= 8
            : (sourceGap < 0 ? pdfGap === 0 : pdfGap < 0));
          const gap = !blocks && !partial
            && (previous ? sourceGap > 0 && pdfGap > 0 : pageCount && start <= 2048)
            && this.remember(sourceEnd, start, page, previousTargetEnd, targetStart, { recover });
          const merged = canMerge ? this.remember(previous.start, Math.max(sourceEnd, end), page,
            previous.targetStart, Math.max(previousTargetEnd, targetEnd), { extend: previous }) : null;
          const next = merged ?? this.remember(start, end, page, targetStart, targetEnd);
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
            this.remember(start, this.raw.trimEnd().length, page, previous.targetEnd, page.raw.trimEnd().length, { recover });
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
          this.remember(hit.start, hit.end, page, start, hit.to);
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
  compare(connection, update) {
    const { target, comparisonContext: context } = connection;
    if (!update && context && connection.comparisonVersion === this.textVersion && connection.editorDiff === context[0]
      && target?.parts === context[1] && target?.pages === context[2] && target?.fontVersion === context[3])
      return connection.editorDiff.reliable ? connection.editorDiff : null;
    if (!connection.editorDiff || update) connection.editorDiff = textDiff(connection.html ?? this.raw.slice(connection.start, connection.end),
      connection.pdf ?? target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true, update);
    const diff = connection.editorDiff;
    if (!diff.reviewRanges) {
      const parts = diff.parts ||= [];
      diff.reliable = diff.distance <= 256 || !parts.some(part => part.inconsistent
        && (significantText(part.html).length > 256 || significantText(part.pdf).length > 256));
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
          const range = new diffIndex(this.raw.slice(a, b), target.raw.slice(x, y), a - connection.start, x - connection.targetStart, true);
          if (range.inconsistent) diff.reviewRanges.push(range);
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
    if (start > end) return null;
    if (targetStart && typeof targetStart === 'object') {
      alignment = targetEnd;
      targetEnd = targetStart.end;
      targetStart = targetStart.start;
    }
    if (targetStart > targetEnd) return null;
    const state = this.connections.get(target) || {};
    const previous = alignment?.previous, aligned = alignment?.connection, extend = alignment?.extend;
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
      if (!left.text && !right.text) return null;
      diff = alignment?.recover
        ? localTextDiff(left.text, right.text, true, Math.max(left.text.length, right.text.length) <= 128 ? Infinity : 128)
        : textDiff(left.text, right.text, true);
      if (diff.distance > 128 && diff.parts.some(part => part.changed && Math.max(part.html.length, part.pdf.length) > 128)
        || alignment?.recover && diff.distance > 32 && !diff.parts.some(part => !part.changed && /[\p{L}\p{N}]{2}/u.test(part.html))) {
        if (!alignment?.recover) return null;
        const { text: html } = left, { text: pdf } = right;
        const words = html.includes('...') || pdf.includes('...') ? /\S+?\.(?=\.|\s|$)|\S+\s*|\s+/gu : /\S+\s*|\s+/gu;
        const substantial = /[\p{L}\p{N}]{3}/u;
        for (const part of localTextDiff(html.match(words) || [], pdf.match(words) || [], true, 512, undefined, false).parts) {
          if (!substantial.test(part.html) || part.changed && !textDiff(part.html, part.pdf, true).parts
            .some(span => !span.changed && substantial.test(span.html))) continue;
          const [sourceStop, targetStop] = extendPageRange(html, pdf, part.end, part.targetEnd, 1, false, /^[\p{L}\p{N}\p{Pd}.]{2}$/u);
          const connection = this.remember(start + left.starts[part.start], start + left.ends[sourceStop - 1], target,
            targetStart + right.starts[part.targetStart], targetStart + right.ends[targetStop - 1]);
          if (connection) connection.recovered = true;
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
    connection.distance = aligned ? aligned.distance : diff.distance;
    connection.spans = aligned ? aligned.spans : diff.parts;
    connection.reversedSpans = !!aligned && !!aligned.reversedSpans !== !!alignment.reverse;
    if (previous?.editorDiff) this.compare(connection, alignment.change || {});
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
      if (base !== null) {
        ordered.push(connection);
        for (const part of diff.parts) {
          const { sourceEdge, targetEdge } = part;
          if (sourceEdge > part.start && targetEdge > part.targetStart)
            edges.push({ sourceEnd: connection.start + sourceEdge, targetEnd: base + connection.targetStart + targetEdge });
        }
      }
      if (!diff.reviewRanges.length) continue;
      const matched = part => !part.changed && /\p{L}/u.test(part.pdf);
      const first = diff.parts.find(matched), last = first && diff.parts.findLast(matched);
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
