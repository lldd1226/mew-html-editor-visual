import { fontKeys, textDiff, localTextDiff, changedRange, normalized, lowerBound, significantText, extendPageRange, comparisonParts, documentIndex, findMatches } from './pdf-selection-diff.js';
// One index owns text, source coordinates, live mappings and prepared text/font comparisons.
class PdfConnections {
  connections = new WeakMap();
  prepared = null;
  pairs = [];
  targets = null;
  reviewAnchors;
  constructor({ environment, documents, document, pdf, options }, values) {
    if (typeof values === 'string') values = new window.MewEditorCore.DocumentModel({ text: values });
    Object.assign(this, { environment, documents, document, pdf, options }, values?.parse?.(document) ?? values);
    if (this.normalized !== null) this.normalized ||= normalized(this.raw);
  }
  entry(start, end, marked, text = this.raw.slice(start, end)) {
    return { index: this, start, end, marked, text,
      before: this.raw.slice(Math.max(0, start - 160), start), after: this.raw.slice(end, end + 160) };
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
      const left = adjacent(true), candidate = adjacent(false);
      const right = candidate && (!left || candidate.open === left.open) ? candidate : null;
      if (left || right) {
        const a = left ? left.fontCloseStart : sourceStart, b = right ? right.openEnd : sourceEnd;
        const text = (left ? this.source.slice(left.closeEnd, sourceStart) : right.open)
          + this.source.slice(sourceStart, sourceEnd)
          + (right ? this.source.slice(sourceEnd, right.start) : left.closing);
        return [{ start: a, end: b, expected: this.source.slice(a, b), text }];
      }
    }
    let a = sourceStart, b = sourceEnd;
    // Include complete wrappers, including whitespace at their edges.
    for (const tag of tags) {
      if (!this.raw.slice(tag.rawStart, start).trim()) a = Math.min(a, tag.start);
      if (!this.raw.slice(end, tag.rawEnd).trim()) b = Math.max(b, tag.closeEnd);
    }
    const removed = tags.flatMap(tag => [[tag.start, tag.openEnd], [tag.fontCloseStart, tag.closeEnd]]);
    const strip = (start, end) => new window.MewEditorCore.DocumentModel({ text: this.source.slice(start, end) })
      .applyEdits(removed.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => ({ start: a - start, end: b - start, text: '' }))).source;
    let text = strip(sourceStart, sourceEnd);
    for (const key of keys) if (font[key]) {
      const name = key === 'italic' ? 'i' : 'b';
      text = `<${name}>${text}</${name}>`;
    }
    text = strip(a, sourceStart) + text + strip(sourceEnd, b);
    // Keep the portions of enclosing wrappers outside the selected words.
    let left = '', right = '';
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
    return segments;
  }
  textEdits(start, end, replacement) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start
      || end > this.raw.length || typeof replacement !== 'string') throw new Error('无效的可见文字替换范围');
    const segments = this.sourceSegments(start, end, !this.raw.slice(start, end).trim());
    if (!segments.length) {
      const at = this.starts[start] ?? this.ends[start - 1] ?? 0;
      segments.push({ start: at, end: at });
    }
    const text = replacement.replace(/[&<>]/g, char => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;');
    return segments.map((segment, i) => ({ ...segment, text: i ? '' : text,
      expected: this.source.slice(segment.start, segment.end) }));
  }
  // Compare this snapshot; the caller selects the current editor index explicitly.
  getDifferences() {
    this.update();
    const versions = this.prepared.fontVersions;
    if (!this.prepared.differences || !versions || this.formats !== versions[0] || this.prepared.pages.some((page, i) =>
      page.parts !== versions[1 + i * 3] || page.pages !== versions[2 + i * 3] || page.fontVersion !== versions[3 + i * 3])) {
      this.prepared.differences = { index: this, connections: this.pairs, items: this.candidates(null, true) };
      this.prepared.fontVersions = [this.formats, ...this.prepared.pages.flatMap(page => [page.parts, page.pages, page.fontVersion])];
    }
    return this.prepared.differences;
  }
  update(pages = this.targets || [], pdf = this.environment.getPdf?.() || this.prepared?.pdf) {
    this.targets = pages;
    const targets = new Set([...pages, ...(this.environment.getTargets?.() || [])].filter(Boolean));
    pages = [...targets];
    const full = documentIndex(this.documents, pdf, this.environment.getSourcePages?.());
    if (!this.prepared || this.prepared.pdf !== pdf || this.prepared.full !== full || this.prepared.pages?.length !== pages.length
      || this.prepared.pages.some((page, i) => !targets.has(page) || this.connections.get(page)?.ranges !== this.prepared.connections[i])) {
      if (full && !full.sourcePages && this.prepared?.document !== full) full.scope(this, true);
      for (const page of new Set([full, ...pages])) if (page && page !== this.prepared?.document) {
        // Rendered pages reuse confirmed document mappings, including changed page tails.
        const entry = page.layer && full?.pages?.find(entry => entry.number === Number(page.layer.closest('.page')?.dataset.pageNumber));
        if (entry && full.raw.slice(entry.start, entry.end) === page.raw)
          for (const connection of (this.connections.get(full)?.preparedRanges || this.connections.get(full)?.ranges || [])) {
            const start = Math.max(entry.start, connection.targetStart), end = Math.min(entry.end, connection.targetEnd);
            if (start >= end) continue;
            const hit = this.range(full, start, end, true, connection);
            if (hit) this.remember(hit.start, hit.end, page, { start: start - entry.start, end: end - entry.start });
          }
        this.scope(page, true);
      }
      // Prefer whole-passage mappings over shorter quotations on adjacent pages.
      const ordered = [...pages].sort((x, y) => Number(!!x.pages) - Number(!!y.pages) || Number(!!y.layer) - Number(!!x.layer));
      const collect = () => ordered.flatMap(page => {
        const state = this.connections.get(page);
        return state?.preparedRanges || state?.ranges || [];
      });
      const connections = collect();
      for (const page of pages) {
        const state = this.connections.get(page), previous = state?.ranges || [];
        const retain = item => page.pages || !connections.some(other => other.target !== page
          // Keep extracted mappings across rendered-layer disposal, and retain rendered fonts.
          && !other.target.pages
          && other.start <= item.start && other.end >= item.end
          && other.end - other.start > item.end - item.start);
        const retained = previous.filter(retain);
        if (state?.preparedRanges) state.preparedRanges = state.preparedRanges === previous ? retained : state.preparedRanges.filter(retain);
        if (retained.length !== previous.length) state.ranges = retained;
      }
      this.prepared = { pdf, full, document: full || this.prepared?.document, pages, connections: pages.map(page => this.connections.get(page)?.ranges), ordered };
      this.pairs = collect();
      for (const connection of this.pairs) this.compare(connection);
    }
    return this.prepared;
  }
  get livePairs() {
    return (this.prepared?.ordered || (this.targets || []).filter(Boolean)
      .sort((x, y) => Number(!!x.pages) - Number(!!y.pages) || Number(!!y.layer) - Number(!!x.layer)))
      .flatMap(target => this.connections.get(target)?.ranges || []);
  }
  compare(connection, diff = connection?.editorDiff) {
    const target = connection?.target;
    diff ||= connection.editorDiff = textDiff(this.raw.slice(connection.start, connection.end),
      target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true);
    const refreshText = !diff.context || diff.context[0] !== this.formats;
    if (!refreshText && diff.context[1] === target?.parts && diff.context[2] === target?.pages
      && diff.context[3] === target?.fontVersion) return diff.reliable ? diff : null;
    let left = 0, right = 0;
    diff.ranges ||= (diff.parts || []).map(part => [left, left += part.html.length, right, right += part.pdf.length,
      { ...part, significant: [significantText(part.html), significantText(part.pdf)], blank: [!part.html.trim(), !part.pdf.trim()] }]);
    Object.assign(diff, { context: [this.formats, target?.parts, target?.pages, target?.fontVersion], reliable: true,
      textRanges: refreshText ? [] : diff.textRanges, fontItems: [] });
    const runs = this.formats && target ? target.fontRuns(connection.targetStart, connection.targetEnd) : [];
    for (const range of connection ? diff.ranges : []) {
      const [a, b, from, to, part] = range;
      const [html, pdf] = part.significant, start = connection.start + a, pdfStart = connection.targetStart + from, pdfEnd = connection.targetStart + to;
      // A footnote omitted by OCR is tolerated; a number inserted elsewhere is a relocation.
      const comparable = /\d/.test(part.html) ? significantText(part.html, this, start) : html;
      if (refreshText && part.changed && (comparable !== pdf || comparable !== html && diff.ranges.some(([, , , , other]) =>
        other.changed && !other.significant[0] && other.significant[1] === html))) diff.textRanges.push(range);
      if (!(diff.distance <= 128) && part.changed && html !== pdf && Math.max(html.length, pdf.length) > 128) diff.reliable = false;
      let compared = runs.slice(lowerBound(runs, pdfStart + Number(from < to), font => font.end),
        lowerBound(runs, pdfEnd + Number(from === to), font => font.start));
      if (part.changed && compared.length) {
        const font = { ...compared[0], start: pdfStart, end: pdfEnd };
        for (const key of fontKeys) if (!compared.every(value => value[key] === font[key])) font[key] = null;
        compared = [font];
      }
      for (const font of compared) {
        let at = part.changed ? start : start + Math.max(pdfStart, font.start) - pdfStart;
        const end = part.changed ? connection.start + b : start + Math.min(pdfEnd, font.end) - pdfStart;
        while (at < end) {
          const htmlFont = this.formats[at];
          let stop = at + 1;
          while (stop < end && this.formats[stop] === htmlFont) stop++;
          if (htmlFont && fontKeys.some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key])) {
            const text = this.raw.slice(at, stop), sourceStart = at + (text.match(/^\s*/)?.[0].length || 0),
              sourceEnd = stop - (text.match(/\s*$/)?.[0].length || 0);
            if (sourceStart < sourceEnd) diff.fontItems.push({ sourceStart, sourceEnd, font, htmlFont });
          }
          at = stop;
        }
      }
    }
    return diff.reliable ? diff : null;
  }
  scope(page, connect = false) {
    const state = this.connections.get(page) || {};
    if (state.scope !== undefined && (!connect || state.prepared)) return state.scope;
    this.connections.set(page, state);
    const source = this.normalized, target = page.normalized;
    const reverse = connect && page?.connections.get(this)?.ranges;
    for (const item of reverse || []) this.remember(item.targetStart, item.targetEnd, page, { start: item.start, end: item.end }, {
      diff: { distance: item.distance, parts: item.spans.map(span => ({ html: span.pdf, pdf: span.html, changed: span.changed })) }
    });
    const connection = reverse?.some(item => item.start === 0 && item.end === page.raw.length) ? { start: Math.min(...reverse.map(item => item.targetStart)), end: Math.max(...reverse.map(item => item.targetEnd)) }
      : (state.ranges || []).find(item => item.targetStart === 0 && item.targetEnd === page.raw.length)
        || connect && (page.sourcePages?.length || page.layer) && this.remember(0, this.raw.length, page, { start: 0, end: page.raw.length }, { recover: true });
    const matches = state.matches || { 0: connection ? [] : this.matches([page.raw]) };
    let scope = connection || (matches[0].length === 1 ? matches[0][0] : null);
    if (scope && connect && !connection) scope = this.remember(scope.start, scope.end, page, { start: 0, end: page.raw.length }) || scope;
    for (let prepare = Number(connect); !scope && prepare >= 0; prepare--) {
      const size = Math.min(prepare ? 24 : 96, target.text.length);
      // Overlap prepared anchors so nearby OCR errors cannot hide a clean passage between samples.
      const anchors = !state.ranges && matches[size] || (matches[size] = size < 24 ? [] : this.matches([target.text], source, { sample: size, step: prepare ? 8 : 0, anchors: prepare && !this.options.wholeWords, page }));
      if (prepare) {
        const confirmed = [];
        for (let i = 1; i < anchors.length; i++) {
          const a = anchors[i - 1], b = anchors[i];
          const left = target.text.slice(a.at, b.at + size);
          const limit = Math.min(32, Math.max(12, Math.floor(left.length * .2)));
          if (b.start <= a.start || left.length > 2048
            || textDiff(left, source.text.slice(a.start, b.end), false, limit).distance > limit) continue;
          const previous = confirmed.at(-1);
          // Use the connection budget on the union: overlapping samples must not count the same OCR errors twice.
          if (!previous || previous.b < a.at || previous.y < a.start
            || textDiff(target.text.slice(previous.a, b.at + size), source.text.slice(previous.x, b.end), false, 128).distance > 128)
            confirmed.push({ a: a.at, x: a.start });
          Object.assign(confirmed.at(-1), { b: b.at + size, y: b.end });
        }
        let previous = null;
        for (const range of confirmed) {
          let [a, x] = extendPageRange(target.text, source.text, range.a, range.x, -1);
          const aa = lowerBound(target.starts, page.raw.lastIndexOf('\n', target.starts[a] - 1) + 1);
          const xx = lowerBound(source.starts, this.raw.lastIndexOf('\n', source.starts[x] - 1) + 1);
          if (a > aa && x > xx && a - aa <= 32 && x - xx <= 32
            && /[\p{L}\p{N}]/u.test(source.text.slice(xx, x))
            && (!/\p{L}/u.test(target.text.slice(aa, a)) || /\p{L}/u.test(source.text.slice(xx, x)))
            && !/[\r\n]/.test(page.raw.slice(target.starts[a], target.ends[a]) + this.raw.slice(source.starts[x], source.ends[x]))) [a, x] = [aa, xx];
          const [b, y] = extendPageRange(target.text, source.text, range.b, range.y, 1);
          const start = source.starts[x], end = source.ends[y - 1], targetStart = target.starts[a], targetEnd = target.ends[b - 1];
          // Edge expansion can make adjacent anchor groups overlap. Compare their union
          // so a joined OCR word is not counted twice and selections can cross the seam.
          const merged = previous && (previous.end <= start && previous.targetEnd > targetStart
            || previous.end > start && previous.targetEnd === targetStart)
            && this.remember(previous.start, Math.max(previous.end, end), page,
              { start: previous.targetStart, end: Math.max(previous.targetEnd, targetEnd) });
          if (merged) state.ranges = state.ranges.filter(item => item !== previous);
          if (previous ? previous.end < start && previous.targetEnd < targetStart
            : page.sourcePages?.length && start <= 2048)
            this.remember(previous?.end ?? this.raw.length - this.raw.trimStart().length, start, page,
              { start: previous?.targetEnd ?? 0, end: targetStart }, { recover: !!(page.sourcePages?.length || page.layer) });
          previous = merged || this.remember(start, end, page, { start: targetStart, end: targetEnd });
        }
        if (page.sourcePages?.length && previous && this.raw.length - previous.end <= 2048 && significantText(this.raw.slice(previous.end)))
          this.remember(previous.end, this.raw.trimEnd().length, page, { start: previous.targetEnd, end: page.raw.trimEnd().length }, { recover: true });
      }
      if (anchors.length < 2 || !anchors.every((anchor, i) => !i || anchor.start > anchors[i - 1].start)) continue;
      const first = anchors[0], last = anchors.at(-1);
      // Context padding must stay within the PDF pages confirmed by the anchors.
      const firstPage = this.pages?.find(page => source.starts[first.start] >= page.start && source.starts[first.start] < page.end);
      const lastPage = this.pages?.find(page => source.starts[last.end - 1] >= page.start && source.starts[last.end - 1] <= page.end);
      scope = {
        start: Math.max(source.starts[Math.max(0, first.start - first.at - 32)], firstPage?.start ?? 0),
        end: Math.min(source.ends[Math.min(source.text.length, last.end + target.text.length - last.at - size + 32) - 1], lastPage?.end ?? this.raw.length)
      };
    }
    let end = this.raw.length - this.raw.trimStart().length;
    for (const next of connect ? [...(state.ranges || [])].sort((a, b) => a.start - b.start) : []) {
      if (next.start > end && next.start - end <= 32) {
        const hit = page.search({ text: this.raw.slice(end, next.start), before: '',
          after: this.raw.slice(next.start, Math.min(next.end, next.start + 24)) },
          { start: Math.max(0, next.targetStart - (next.start - end) - 32), end: next.targetEnd });
        if (hit && hit.end <= next.targetStart) this.remember(end, next.start, page, hit);
      }
      end = Math.max(end, next.end);
    }
    Object.assign(state, { scope, matches, prepared: connect, preparedRanges: connect ? state.ranges || [] : undefined });
    return scope;
  }
  remember(start, end, target, hit, alignment) {
    if (start > end || hit.start > hit.end) return null;
    const state = this.connections.get(target) || {};
    const existing = state.ranges?.find(item => item.start === start && item.end === end
      && item.targetStart === hit.start && item.targetEnd === hit.end);
    if (existing) return existing;
    const left = normalized(this, { start, end }), right = normalized(target, hit);
    if (!left.text && !right.text) return null;
    const previous = alignment?.previous;
    // Recompare the affected connection: old hunk boundaries can change the optimal alignment.
    // Unchanged connections are retained by inherit().
    const diff = alignment?.diff || textDiff(left.text, right.text, true, alignment?.recover ? 128 : Infinity);
    if (diff.distance > 128 && diff.parts.some(part => part.changed && Math.max(part.html.length, part.pdf.length) > 128)
      || alignment?.recover && diff.distance > 32 && !diff.parts.some(part => !part.changed && /[\p{L}\p{N}]{2}/u.test(part.html))) {
      if (!alignment?.recover) return null;
      // Recover word runs, keeping bounded OCR differences in the normal diff path.
      const words = left.text.includes('...') || right.text.includes('...') ? /\S+?\.(?=\.|\s|$)|\S+\s*|\s+/gu : /\S+\s*|\s+/gu;
      let a = 0, b = 0;
      for (const part of localTextDiff(left.text.match(words) || [], right.text.match(words) || [], true, 512, undefined, false).parts) {
        const x = a, y = b;
        a += part.html.length; b += part.pdf.length;
        if (!/[\p{L}\p{N}]{3}/u.test(part.html) || part.changed && !textDiff(part.html, part.pdf, true).parts
          .some(span => !span.changed && /[\p{L}\p{N}]{3}/u.test(span.html))) continue;
        const [bb, yy] = extendPageRange(left.text, right.text, a, b, 1, false, /^[\p{L}\p{N}\p{Pd}.]{2}$/u);
        const connection = this.remember(start + left.starts[x], start + left.ends[bb - 1], target,
          { start: hit.start + right.starts[y], end: hit.start + right.ends[yy - 1] });
        if (connection) connection.recovered = true;
      }
      return null;
    }
    const connection = Object.defineProperty({ ...previous, start, end, targetStart: hit.start, targetEnd: hit.end, distance: diff.distance, spans: diff.parts }, 'target', { value: target });
    if (previous?.editorDiff) connection.editorDiff = textDiff(this.raw.slice(start, end), target.raw.slice(hit.start, hit.end), true, Infinity, true);
    state.ranges = [connection, ...(state.ranges || []).filter(item => item.start !== start || item.end !== end)].slice(0, Math.max(16, this.raw.length));
    this.connections.set(target, state);
    return connection;
  }
  range(target, start, end, reverse = false, connection, marked = false) {
    if (start > end) return null;
    const side = Number(reverse), x = side * 2, y = 2 - x;
    const begin = reverse ? 'targetStart' : 'start', stop = reverse ? 'targetEnd' : 'end';
    let connections = connection ? [connection] : this.connections.get(target)?.ranges || [];
    connection ||= start < end && connections.find(item => start >= item[begin] && end <= item[stop]);
    // Reuse bounded gap results, including failures, while confirmed neighbours stay unchanged.
    if (!connection && start < end) connections = [...connections].sort((a, b) => a[begin] - b[begin]).flatMap((b, i, ordered) => {
      const a = ordered[i - 1];
      const gap = a && a[stop] < Math.min(end, b[begin]) && b[begin] > start
        && a.end <= b.start && a.targetEnd <= b.targetStart
        && Math.max(b.start - a.end, b.targetStart - a.targetEnd) <= 2048
        && (a.gap?.next === b ? a.gap.connection : (a.gap = { next: b,
          connection: this.remember(a.end, b.start, target, { start: a.targetEnd, end: b.targetStart }) }).connection);
      if (gap && start >= gap[begin] && end <= gap[stop]) connection ||= gap;
      return gap ? [gap, b] : [b];
    });
    if (!connection && target.normalized && !this.connections.get(target)?.prepared) {
      this.scope(target, true);
      return this.range(target, start, end, reverse, connection, marked);
    }
    let first = Infinity, last = -1, covered = start;
    for (const item of connection ? [connection] : connections) {
      if (!connection && (start === end ? start < item[begin] || end > item[stop]
        : start >= item[stop] || end <= item[begin])) continue;
      const diff = this.compare(item);
      if (!diff) continue;
      if (item[begin] > covered) return null;
      covered = Math.max(covered, item[stop]);
      const a = start - item[begin], b = end - item[begin], offset = reverse ? item.start : item.targetStart;
      for (let i = lowerBound(diff.ranges, a, span => span[x + 1]); i < diff.ranges.length && diff.ranges[i][x] <= b; i++) {
        const range = diff.ranges[i], part = range[4], left = range[x], right = range[x + 1], targetLeft = range[y], targetRight = range[y + 1];
        if (a === b ? !part.changed || a < left || a > right || left !== right
          && !(marked && part.blank[side] && part.significant[1 - side])
          : left === right && part.significant[1 - side]
            ? left < a || left > b : right <= a || left >= b) continue;
        first = Math.min(first, offset + (part.changed ? targetLeft : targetLeft + Math.max(a, left) - left));
        last = Math.max(last, offset + (part.changed ? targetRight : targetLeft + Math.min(b, right) - left));
      }
      // An overlapping match may end here before the connection containing the insertion.
      if (start === end && last >= first) { connection = item; break; }
    }
    if (covered < end || last < first || last === first && reverse) return null;
    return { start: first, end: last, connection,
      approximate: significantText((reverse ? target : this).raw.slice(start, end)) !== significantText((reverse ? this : target).raw.slice(first, last)) };
  }
  // Resolve either direction through the same mapping, bounded search and confirmation path.
  locate(target, entry, reverse = false, scope, marked = false) {
    const mapped = this.range(target, entry.start, entry.end, reverse, undefined, marked);
    const hit = entry.range ? { ...entry.range } : mapped || (reverse ? this : target).search(entry, scope);
    if (!hit || mapped) return hit;
    return { ...hit, connection: this.remember(reverse ? hit.start : entry.start, reverse ? hit.end : entry.end, target,
      reverse ? { start: entry.start, end: entry.end } : hit) };
  }

  candidates(notice = null, fonts = false, edits = true, text = true, targets = notice ? [] : this.prepared?.pages || [],
    connections = targets === this.prepared?.pages ? this.pairs : targets.filter(Boolean)
      .slice().sort((x, y) => Number(!!x.pages) - Number(!!y.pages) || Number(!!y.layer) - Number(!!x.layer))
      .flatMap(target => this.connections.get(target)?.preparedRanges || this.connections.get(target)?.ranges || [])) {
    const items = [];
    const add = (start, diff, connection = null, missing = false) => {
      if (!diff) return;
      if (!connection) this.compare(null, diff);
      const mapped = connection && diff.ranges.filter(([, , , , part]) => !part.changed && /\p{L}/u.test(part.pdf));
      for (const [a, b, , , part] of connection ? diff.textRanges : diff.ranges) {
        const from = start + a, end = start + b;
        const absent = missing || connection && (part.blank[1] || /\p{L}/u.test(part.html) && !/\p{L}/u.test(part.pdf)) && (!mapped.length || b <= mapped[0][0] || a >= mapped.at(-1)[1]);
        // Explicit review selections retain footnote digits suppressed in default comparisons.
        if (!connection && (!part.changed || significantText(part.html, !notice ? this : null, from) === significantText(part.pdf))) continue;
        if (connection && connections.find(other => other === connection || other.start <= from && other.end >= end
          && (from < end || other.end > from || other.start === from)) !== connection) continue;
        const low = lowerBound(items, from, item => item.sourceStart);
        if (items[low]?.sourceStart === from && (items[low].sourceEnd > from || end === from) || low && items[low - 1].sourceEnd > from
          || items[low] && items[low].sourceStart < end && items[low].sourceEnd > from) continue;
        items.splice(low, 0, {
          id: `${from}:${end}`, sourceStart: from, sourceEnd: end, ...(absent ? { missing: true } : {}),
          comparison: { html: part.html, pdf: part.pdf }, options: [
            { id: 'pdf', label: '替换', edits: edits && !absent
              && !(this.starts?.[from] < this.ends?.[from - 1] || this.starts?.[end] < this.ends?.[end - 1])
              ? this.textEdits(from, end, part.pdf) : [] }
          ]
        });
      }
    };
    for (const connection of text ? connections : [])
      add(connection.start, this.compare(connection), connection);
    if (text && notice?.source && this.raw.slice(notice.source.start, notice.source.end) === notice.html)
      add(notice.source.start, { parts: comparisonParts(notice) });
    // Missing text is the significant remainder outside confirmed OCR mappings.
    const target = text && (targets.length ? targets : connections.map(connection => connection.target)).find(target => target?.sourcePages?.length);
    if (target && (this.connections.get(target)?.prepared || connections.some(connection => connection.target === target && connection.recovered))) {
      const ordered = connections.filter(connection => (connection.target === target || connection.target.layer)
        && this.compare(connection)).sort((a, b) => a.start - b.start);
      let start = this.raw.length - this.raw.trimStart().length;
      for (const range of [...ordered, { start: this.raw.trimEnd().length }]) {
        if (range.start > start) add(start, { parts: [{ html: this.raw.slice(start, range.start), pdf: '', changed: true }] }, null, true);
        start = Math.max(start, range.end ?? range.start);
      }
    }
    return this.formatDifferences(items, fonts, edits, connections);
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
  missingRange(target, start) {
    const index = target.layer ? this.prepared?.full : target;
    const page = target.layer && index?.pages.find(page => page.number === Number(target.layer.closest('.page')?.dataset.pageNumber));
    if (!index || target.layer && (!page || index.raw.slice(page.start, page.end) !== target.raw)) return null;
    let a = 0, matched = false;
    // Both page and document requests use the same confirmed diff and word rules.
    const connections = this.connections.get(index)?.preparedRanges || this.connections.get(index)?.ranges || [];
    for (const connection of connections)
      for (const [, to, , right, part] of this.compare(connection)?.ranges || []) {
        if (!part.html.trim() || !part.pdf.trim()) continue;
        matched = true;
        if (connection.start + to <= start) a = Math.max(a, connection.targetStart + right);
      }
    if (!matched) return null;
    const parts = index.fontRuns(0, index.raw.length, true);
    // Missing HTML has no PDF box: use the last paired edge, never unrelated OCR in the gap.
    const part = a ? parts.findLast(part => part.start < a && index.raw.slice(part.start, Math.min(a, part.end)).trim())
      : parts.find(part => index.raw.slice(part.start, part.end).trim());
    if (!part) return null;
    const from = a ? part.start + index.raw.slice(part.start, Math.min(a, part.end)).trimEnd().length
      : part.start + index.raw.slice(part.start, part.end).length - index.raw.slice(part.start, part.end).trimStart().length;
    const endBias = a > 0, offset = page?.start || 0;
    if (page && (from < page.start || from > page.end || endBias && from === page.start)) return null;
    return { start: from - offset, end: from - offset, endBias };
  }
  matches(queries, haystack = this.normalized, { anchors = false, sample = 0, step = 0, fuzzy = false, before = '', after = '', page } = {}) {
    // Sample each anchor independently; only its unique hit can establish page order.
    if (sample) return queries.flatMap(query => [...new Set(step
      ? Array.from({ length: Math.ceil((query.length - sample) / step) + 1 }, (_, i) => Math.min(i * step, query.length - sample))
      : [0, .25, .5, .75, 1].map(ratio => Math.floor((query.length - sample) * ratio)))].flatMap(at => {
      const start = page?.normalized.starts[at], end = page?.normalized.ends[at + sample - 1];
      const connection = (page && this.connections.get(page)?.ranges || []).find(item => item.targetStart <= start && item.targetEnd >= end);
      const hit = connection && this.range(page, start, end, true, connection);
      const hits = hit && !hit.approximate ? [hit] : this.matches([query.slice(at, at + sample)], haystack, { anchors });
      return hits.length === 1 ? [{ at, start: lowerBound(haystack.starts, hits[0].start), end: lowerBound(haystack.starts, hits[0].end) }] : [];
    }));
    return findMatches(this, queries, haystack, { anchors, fuzzy, before, after, wholeWords: this.options.wholeWords });
  }
  // Search within this index without creating a source/target connection.
  search(entry, scope = null) {
    const offset = scope?.start || 0, haystack = scope ? scope.normalized ||= normalized(this, { start: offset, end: scope.end }) : this.normalized;
    const before = normalized(entry.before).text.trim(), after = normalized(entry.after).text.trim();
    for (let fuzzy = 0; fuzzy < 2; fuzzy++) {
      const hits = this.matches([entry.text], haystack, { fuzzy: !!fuzzy, before, after });
      let best = null, tied = false;
      for (const hit of hits) {
        const begin = lowerBound(haystack.starts, hit.start), end = lowerBound(haystack.starts, hit.end);
        const left = haystack.text.slice(Math.max(0, begin - 400), begin).trim();
        const right = haystack.text.slice(end, end + 400).trim();
        let a = 0, b = 0;
        while (a < before.length && a < left.length && before.at(-a - 1) === left.at(-a - 1)) a++;
        while (b < after.length && b < right.length && after[b] === right[b]) b++;
        const score = a + b;
        if (!best || score > best.score) { best = { ...hit, score }; tied = false; }
        else if (score === best.score) tied = true;
      }
      if (!best || best.score < Math.min(24, before.length + after.length)) continue;
      return tied ? null : { ...best, start: best.start + offset, end: best.end + offset };
    }
    return null;
  }
  locateSource(chunks, pdf) {
    const first = chunks[0], last = chunks.at(-1);
    this.update(chunks.map(chunk => chunk.index), pdf);
    const entry = first.index.entry(first.start, first.end, undefined,
      chunks.map(({ index, start, end }) => index.raw.slice(start, end)).join("\n"));
    entry.after = last.index.raw.slice(last.end, last.end + 160);
    const left = this.connections.get(first.index)?.scope, right = this.connections.get(last.index)?.scope;
    const scope = left === right ? left : left && right && left.start <= right.start ? { start: left.start, end: right.end } : null;
    const hit = chunks.length === 1
      ? this.locate(first.index, entry, true, scope)
      : this.search(entry, scope);
    const html = hit && this.raw.slice(hit.start, hit.end);
    const differs = hit && significantText(html, this, hit.start) !== significantText(entry.text);
    const difference = !hit ? { message: "No reliable HTML match" } : differs ? { html, pdf: entry.text } : null;
    return { hit, difference };
  }
  locateLayer(queries, targets = []) {
    const hits = new Map();
    const append = matches => {
      for (const hit of matches) {
        const key = `${hit.start}:${hit.end}`;
        if (!hits.has(key) || hit.difference?.missing) hits.set(key, hit);
      }
    };
    let focusHit = null;
    for (const target of targets) {
      // Reuse ranges only in their original text layer; never mutate cached targets.
      const hit = target.range && (!target.layer || target.layer === this.layer) ? { ...target.range }
        : target.index ? target.index.locate(this, target.layer ? { ...target, range: null } : target, false, undefined, true) : this.search(target);
      if (hit) {
        hit.difference = target.difference || (hit.approximate ? { html: target.text, pdf: this.raw.slice(hit.start, hit.end) } : null);
        hit.source = target.source || target.index && { index: target.index, start: target.start, end: target.end };
        if (!focusHit) focusHit = hit;
      }
      // Unconfirmed default differences must not highlight unrelated occurrences.
      append(hit ? [hit] : target.marked || target.index ? [] : this.matches([target.text]));
    }
    append(this.matches(queries));
    return { hits: [...hits.values()], focusHit };
  }
  inherit(previous) {
    const { start, oldEnd, newEnd } = changedRange(previous.raw, this.raw), change = newEnd - oldEnd;
    const shift = range => range && (range.end <= start ? 0 : range.start >= oldEnd ? change : null);
    // Keep confirmed, unchanged passages; only edited passages need a new diff.
    for (const target of new Set([...this.targets, ...(this.environment.getTargets?.() || []),
      documentIndex(this.documents, this.environment.getPdf?.() || this.pdf, this.environment.getSourcePages?.())].filter(Boolean))) {
      const cached = previous.connections.get(target), original = cached?.ranges || [];
      const state = this.connections.get(target) || {};
      this.connections.set(target, state);
      const retain = item => {
        const delta = start === oldEnd && item.end === start && item.start < start ? null : shift(item);
        if (delta !== null) {
          const kept = Object.defineProperty({ ...item, start: item.start + delta, end: item.end + delta }, 'target', { value: target }), diff = item.editorDiff;
          if (diff?.context?.[0] === previous.formats && this.formats.slice(kept.start, kept.end).every((style, i) => {
            const at = item.start + i, old = previous.formats[at];
            return style.italic === old.italic && style.bold === old.bold && style.name === old.name
              && style.definition?.open === old.definition?.open
              && (!i || (style === this.formats[kept.start + i - 1]) === (old === previous.formats[at - 1]));
          })) kept.editorDiff = { ...diff, context: [this.formats, ...diff.context.slice(1)],
            fontItems: diff.fontItems.map(value => ({ ...value, sourceStart: value.sourceStart + delta,
              sourceEnd: value.sourceEnd + delta, htmlFont: this.formats[value.sourceStart + delta] })) };
          return kept;
        }
        if (item.start > start || item.end < oldEnd || !item.editorDiff || item.editorDiff.reliable === false) return null;
        // Keep unchanged missing tails outside the edited comparison. Otherwise a changed
        // final word can be aligned with repeated letters in an unrelated footnote.
        const last = item.editorDiff.ranges?.findLast(([, , , , part]) => part.pdf.trim());
        const end = last && item.start + last[1] >= oldEnd ? item.start + last[1] : item.end;
        return this.remember(item.start, end + change, target,
          { start: item.targetStart, end: item.targetEnd }, { previous: item });
      };
      const migrated = new Map(), retained = original.map(item => {
        const next = retain(item); migrated.set(item, next); return next;
      }).filter(Boolean);
      if (retained.length) state.ranges = retained;
      const reverseScope = target.connections.get(previous);
      const reverse = (reverseScope?.ranges || []).flatMap(item => {
        const delta = shift({ start: item.targetStart, end: item.targetEnd });
        return delta === null ? [] : [Object.defineProperty({ ...item, targetStart: item.targetStart + delta, targetEnd: item.targetEnd + delta }, 'target', { value: this })];
      });
      if (reverse.length || previous.raw === this.raw && reverseScope?.scope !== undefined)
        target.connections.set(this, { ...(previous.raw === this.raw ? reverseScope : {}), ranges: reverse.length ? reverse : undefined });
      const delta = shift(cached?.scope);
      if (cached?.scope && delta !== null) Object.assign(state, { matches: cached.matches, prepared: cached.prepared,
        scope: { ...cached.scope, start: cached.scope.start + delta, end: cached.scope.end + delta },
        preparedRanges: cached.preparedRanges === original ? retained : cached.preparedRanges?.map(item => migrated.has(item) ? migrated.get(item) : retain(item)).filter(Boolean)
      });
      else if (retained.length && retained.length === original.length
        && cached?.scope?.start <= start && cached.scope.end >= oldEnd && cached.preparedRanges?.every(item => original.includes(item)))
        Object.assign(state, { prepared: cached.prepared,
          scope: { start: cached.scope.start, end: cached.scope.end + change },
          preparedRanges: cached.preparedRanges.map(item => migrated.get(item)) });
    }
  }
}
window.PdfSelectionDiff.PdfConnections = PdfConnections;
