import { fontKeys, textDiff, localTextDiff, changedRange, normalized, lowerBound, significantText, anchorRanges, recoverWordRanges, comparisonParts, documentIndex, findMatches } from './pdf-selection-diff.js';
function connectionBounds(ranges, reverse = false) {
  const start = reverse ? 'targetStart' : 'start', end = reverse ? 'targetEnd' : 'end';
  const bounds = { start: Infinity, end: -Infinity };
  for (const range of ranges) {
    bounds.start = Math.min(bounds.start, range[start]); bounds.end = Math.max(bounds.end, range[end]);
  }
  return bounds;
}

function* connectionGaps(ordered, at, end = at, reverse = false) {
  const start = reverse ? 'targetStart' : 'start', stop = reverse ? 'targetEnd' : 'end';
  for (const next of ordered) {
    if (at < next[start]) yield [at, next[start], next];
    at = Math.max(at, next[stop]);
  }
  if (at < end) yield [at, end];
}

function compact(view) {
  const text = [], starts = [], ends = [];
  for (let i = 0; i < view.text.length; i++) if (!/[\s\-\u00ad\u2010\u2011]/u.test(view.text[i])) {
    text.push(view.text[i]); starts.push(view.starts[i]); ends.push(view.ends[i]);
  }
  return { text: text.join(''), starts, ends };
}
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
      return prepared && state?.preparedRanges || state?.ranges || [];
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
    // Include complete wrappers, including whitespace at their edges.
    for (const tag of tags) {
      if (!this.raw.slice(tag.rawStart, start).trim()) a = Math.min(a, tag.start);
      if (!this.raw.slice(end, tag.rawEnd).trim()) b = Math.max(b, tag.closeEnd);
    }
    const removed = tags.flatMap(tag => [[tag.start, tag.openEnd], [tag.fontCloseStart, tag.closeEnd]])
      .sort((a, b) => a[0] - b[0]);
    const strip = (start, end) => {
      let at = start, text = '';
      for (const [a, b] of removed) if (a >= start && b <= end) {
        text += this.source.slice(at, a);
        at = b;
      }
      return text + this.source.slice(at, end);
    };
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
    if (start === end) {
      let offset = this.starts[start] ?? this.ends[start - 1] ?? 0;
      const body = this.tags?.pairs.find(tag => tag.name === 'body');
      if (body) offset = Math.max(body.openEnd, Math.min(body.closeStart, offset));
      return [{ start: offset, end: offset }];
    }
    for (let at = start; at < end; at++) {
      const a = this.starts[at], b = this.ends[at], last = segments.at(-1);
      const text = this.source?.slice(a, b);
      if (/^</.test(text) || !includeWhitespace && /^\s*$/.test(text)) continue;
      if (last && a <= last.end) last.end = Math.max(last.end, b);
      else segments.push({ start: a, end: b });
    }
    return segments.length ? segments : this.sourceSegments(start, start);
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
  getDifferences(pages = []) {
    const prepared = this.update(pages);
    if (!prepared.differences || !this.fontsCurrent) {
      prepared.differences = { index: this, connections: this.pairs, items: this.candidates(null, true) };
      prepared.fonts = prepared.pages.map(({ parts, pages, fontVersion }) => ({ parts, pages, fontVersion }));
    }
    return prepared.differences;
  }
  update(pages = []) {
    const previousState = this.prepared;
    const full = documentIndex(this.documents, this.pdf, this.environment.getSourcePages?.()) || previousState?.full;
    const targets = new Set([full, ...pages, ...(this.environment.getTargets?.() || [])].filter(Boolean));
    pages = [...targets];
    if (!previousState || previousState.pdf !== this.pdf || previousState.full !== full || previousState.pages?.length !== pages.length
      || previousState.pages.some((page, i) => !targets.has(page) || this.targetConnections(page) !== previousState.connections[i])) {
      if (full && !full.sourcePages && previousState?.full !== full) full.scope(this, true);
      for (const page of pages) if (page !== previousState?.full) {
        // Rendered pages reuse confirmed document mappings, including changed page tails.
        const entry = page.layer && full?.pages?.find(entry => entry.number === Number(page.layer.closest('.page')?.dataset.pageNumber));
        if (entry && full.raw.slice(entry.start, entry.end) === page.raw) {
          const projected = new Set();
          for (const connection of this.targetConnections(full)) {
            const start = Math.max(entry.start, connection.targetStart), end = Math.min(entry.end, connection.targetEnd);
            if (start >= end) continue;
            const hit = start === connection.targetStart && end === connection.targetEnd
              ? connection : this.range(full, start, end, true, connection);
            const mapping = hit && this.remember(hit.start, hit.end, page, { start: start - entry.start, end: end - entry.start },
              hit === connection && { diff: { distance: connection.distance, parts: connection.spans } });
            if (mapping) projected.add(mapping);
          }
          // A rendered page with identical text can reuse the cross-page alignment.
          if (full.sourcePages?.length > 1 && projected.size) {
            const state = this.connections.get(page), preparedRanges = state.ranges.filter(item => projected.has(item));
            Object.assign(state, { scope: connectionBounds(preparedRanges), prepared: true, preparedRanges });
            continue;
          }
        }
        this.scope(page, true);
      }
      // Prefer whole-passage mappings over shorter quotations on adjacent pages.
      const connections = this.targetConnections(pages);
      for (const page of pages) {
        const state = this.connections.get(page);
        if (page.pages || !state?.ranges?.length && !state?.preparedRanges?.length) continue;
        const retain = item => !connections.some(other => other.target !== page && !other.target.pages
          && other.start <= item.start && other.end >= item.end
          && other.end - other.start > item.end - item.start);
        const prune = ranges => {
          const kept = ranges?.filter(retain);
          return kept?.length === ranges?.length ? ranges : kept;
        };
        const ranges = prune(state.ranges);
        state.preparedRanges = state.preparedRanges === state.ranges ? ranges : prune(state.preparedRanges);
        state.ranges = ranges;
      }
      this.prepared = { pdf: this.pdf, full, pages, connections: pages.map(page => this.targetConnections(page)), pairs: connections };
      for (const connection of this.pairs) this.compare(connection);
    }
    return this.prepared;
  }
  get livePairs() { return this.targetConnections(this.prepared?.pages || [], false); }
  reviewRanges(connection) {
    const target = connection.target, boundary = (view, at) => at < view.text.length ? view.starts[at] : view.ends.at(-1);
    let html = lowerBound(this.normalized.starts, connection.start), pdf = lowerBound(target.normalized.starts, connection.targetStart);
    return connection.spans.flatMap(span => {
      const from = boundary(this.normalized, html), to = span.html ? this.normalized.ends[html + span.html.length - 1] : from;
      const targetFrom = boundary(target.normalized, pdf), targetTo = span.pdf ? target.normalized.ends[pdf + span.pdf.length - 1] : targetFrom;
      html += span.html.length; pdf += span.pdf.length;
      const htmlText = this.raw.slice(from, to), pdfText = target.raw.slice(targetFrom, targetTo), blank = [!htmlText.trim(), !pdfText.trim()];
      const significant = [significantText(htmlText), significantText(pdfText)];
      return span.changed && significant[0] !== significant[1]
        ? [[from - connection.start, to - connection.start, targetFrom - connection.targetStart, targetTo - connection.targetStart,
          { html: htmlText, pdf: pdfText, changed: true, review: true, significant, blank }]] : [];
    });
  }
  compare(connection, diff = connection?.editorDiff) {
    const target = connection?.target;
    diff ||= connection.editorDiff = textDiff(this.raw.slice(connection.start, connection.end),
      target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true);
    const refreshText = !diff.context || diff.context[0] !== this.textVersion;
    if (!refreshText && diff.context[1] === target?.parts && diff.context[2] === target?.pages
      && diff.context[3] === target?.fontVersion) return diff.reliable ? diff : null;
    let left = 0, right = 0;
    diff.ranges ||= (diff.parts || []).map(part => [left, left += part.html.length, right, right += part.pdf.length,
      { ...part, significant: [significantText(part.html), significantText(part.pdf)], blank: [!part.html.trim(), !part.pdf.trim()] }]);
    diff.reviewRanges ||= connection?.spans ? this.reviewRanges(connection) : null;
    Object.assign(diff, { context: [this.textVersion, target?.parts, target?.pages, target?.fontVersion], reliable: true, fontItems: [] });
    const runs = this.formats && target ? target.fontRuns(connection.targetStart, connection.targetEnd) : [], unreliable = !(diff.distance <= 256);
    for (const range of diff.ranges) {
      const [a, b, from, to, part] = range;
      const [html, pdf] = part.significant;
      if (refreshText) part.review = part.changed && html !== pdf;
      if (!connection) continue;
      const start = connection.start + a, pdfStart = connection.targetStart + from, pdfEnd = connection.targetStart + to;
      if (unreliable && part.changed && html !== pdf && Math.max(html.length, pdf.length) > 256) diff.reliable = false;
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
            const text = this.raw.slice(at, stop), sourceStart = at + (text.match(/^\s*/)?.[0].length || 0), sourceEnd = stop - (text.match(/\s*$/)?.[0].length || 0);
            if (sourceStart < sourceEnd) diff.fontItems.push({ sourceStart, sourceEnd, font, htmlFont });
          }
          at = stop;
        }
      }
    }
    return diff.reliable ? diff : null;
  }
  completePage(page, layout) {
    const orderedSource = [...this.targetConnections(page, false)].sort((left, right) => left.start - right.start);
    for (const [start, end, next] of connectionGaps(orderedSource, this.raw.length - this.raw.trimStart().length)) {
      if (end - start > 32) continue;
      const hit = page.search({ text: this.raw.slice(start, end), before: '',
        after: this.raw.slice(end, Math.min(next.end, end + 24)) },
        { start: Math.max(0, next.targetStart - (end - start) - 32), end: next.targetEnd });
      if (hit && hit.end <= next.targetStart) this.remember(start, end, page, hit);
    }
    if (!layout || !page.pages && !page.breaks?.length) return;
    const ranges = this.targetConnections(page, false);
    if (!ranges.length) return;
    const tags = this.tags?.pairs || [];
    let asideStart = this.raw.length;
    for (const tag of tags.filter(tag => tag.name === 'aside' && tag.rawEnd !== undefined).sort((a, b) => b.rawEnd - a.rawEnd))
      if (tag.rawEnd <= asideStart && !this.raw.slice(tag.rawEnd, asideStart).trim()) asideStart = tag.rawStart;
    const tailStart = asideStart < this.raw.length ? asideStart : connectionBounds(ranges).end;
    if (!this.raw.slice(tailStart).trim()) return;
    const labels = new Map(tags.filter(tag => tag.name === 'a' && /\bhref\s*=\s*["']#/iu.test(tag.open))
      .map(tag => [tag.rawStart, tag.rawEnd]));
    const ordered = [...ranges].sort((a, b) => a.targetStart - b.targetStart);
    const gaps = [];
    for (const entry of page.pages || [{ start: 0, end: page.raw.length, breaks: page.breaks }]) {
      const touching = ordered.filter(range => range.targetStart < entry.end && range.targetEnd > entry.start);
      // Prefer the last connected body passage as the start of the footer. An indexed
      // layout break also covers a page that contains only the end of a known note.
      const bodyEnd = touching.reduce((end, range) => range.start < tailStart ? Math.max(end, range.targetEnd) : end, entry.start);
      const at = bodyEnd > entry.start ? bodyEnd : entry.breaks?.at(-1);
      if (at !== undefined) for (const [start, end] of connectionGaps(touching, at, entry.end, true)) gaps.push({ start, end });
    }
    if (!gaps.length) return;
    for (const gap of gaps) gap.view = compact(normalized(page.raw.slice(gap.start, gap.end)));
    const proposed = [];
    for (const line of this.raw.slice(tailStart).matchAll(/[^\r\n]+/gu)) {
      const value = line[0], text = value.trim();
      if (!text) continue;
      const start = tailStart + line.index + value.length - value.trimStart().length, end = start + text.length;
      if (ranges.some(range => range.start < end && range.end > start)) continue;
      // A backlink supplies the body boundary. For plain text, try the full line and
      // the suffix after its first token, irrespective of how that token is written.
      const labelEnd = labels.get(start), firstSpace = text.search(/\s/u);
      const bodies = labelEnd > start && labelEnd < end ? [labelEnd] : [start, ...(firstSpace > 0 ? [start + firstSpace] : [])];
      for (const bodyStart of bodies) {
        const body = this.raw.slice(bodyStart, end), needle = compact(normalized(body)).text;
        if (needle.length < 8 || !/\p{L}{4}/u.test(body)) continue;
        let hit, ambiguous = false;
        for (const gap of gaps) {
          const { text, starts, ends } = gap.view;
          for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
            const at = gap.start + starts[i], to = gap.start + ends[i + needle.length - 1];
            if (!/^[^\S\r\n]*(?:$|[\r\n–—-])/u.test(page.raw.slice(to, gap.end))
              || /^\p{L}/u.test(needle) && /\p{L}/u.test(page.raw[at - 1] || '')) continue;
            if (hit) { ambiguous = true; break; }
            hit = { gap, at, to, start, end, bodyStart };
          }
          if (ambiguous) break;
        }
        if (ambiguous) break;
        if (hit) { proposed.push(hit); break; }
      }
    }
    proposed.sort((a, b) => a.at - b.at);
    for (let i = 0; i < proposed.length; i++) {
      const hit = proposed[i], previous = proposed[i - 1];
      if (previous?.to > hit.at || proposed[i + 1]?.at < hit.to) continue;
      const from = previous?.gap === hit.gap ? previous.to : hit.gap.start;
      // Include the adjacent label in the comparison only after the bodies agree.
      const label = hit.bodyStart > hit.start && /(?:^|\s)\S+\s*$/u.exec(page.raw.slice(from, hit.at));
      this.remember(hit.start, hit.end, page, { start: label ? from + label.index + label[0].length - label[0].trimStart().length : hit.at, end: hit.to });
    }
  }
  scope(page, connect = false) {
    const state = this.connections.get(page) || {};
    if (state.scope !== undefined && (!connect || state.prepared)) return state.scope;
    this.connections.set(page, state);
    const source = this.normalized, target = page.normalized;
    const partial = page.layer && this.environment.getSourcePages?.()?.length > 1;
    const layout = page.sourcePages?.length > 1 || partial || this.tags?.pairs.some(tag => tag.name === 'aside');
    // A physical page turn alone can split a word or paragraph. Use layout boundaries
    // when PDF extraction identifies separate passages, such as a page-bottom note.
    const blocks = connect && layout ? (
      page.pages?.some(entry => entry.breaks?.length)
        ? page.pages.flatMap(entry => [entry.start, ...(entry.breaks || []), entry.end])
        : partial && page.breaks?.length ? [0, ...page.breaks, page.raw.length] : null) : null;
    const reverse = connect ? page.targetConnections(this, false) : [];
    for (const item of reverse) this.remember(item.targetStart, item.targetEnd, page, { start: item.start, end: item.end }, {
      diff: { distance: item.distance, parts: item.spans.map(({ html, pdf, changed }) => ({ html: pdf, pdf: html, changed })) }
    });
    let scope = reverse.some(item => item.start === 0 && item.end === page.raw.length) ? connectionBounds(reverse, true)
      : this.targetConnections(page, false).find(item => item.targetStart === 0 && item.targetEnd === page.raw.length);
    if (!scope && connect && !blocks && !partial && (page.sourcePages?.length || page.layer))
      scope = this.remember(0, this.raw.length, page, { start: 0, end: page.raw.length }, { recover: true });
    const matches = state.matches || { 0: scope || blocks ? [] : this.matches([page.raw], source, { limit: 2 }) };
    if (!scope && matches[0].length === 1) {
      scope = matches[0][0];
      if (connect) scope = this.remember(scope.start, scope.end, page, { start: 0, end: page.raw.length }) || scope;
    }
    const minimum = blocks ? 16 : 24;
    for (let prepare = Number(connect); !scope && prepare >= 0; prepare--) {
      const size = Math.min(prepare ? minimum : 96, target.text.length);
      if (size < minimum) continue;
      const layoutBlocks = prepare ? blocks : null;
      const anchors = !layoutBlocks && !state.ranges && matches[size] || this.matches([target.text], source,
        { sample: size, step: prepare ? 8 : 0, anchors: prepare && !this.options.wholeWords, page, blocks: layoutBlocks });
      if (!layoutBlocks && matches[size] !== anchors) matches[size] = anchors;
      if (prepare) this.connectAnchors(page, anchorRanges(this, page, anchors, size, blocks), blocks, partial);
      if (anchors.length < 2 || !anchors.every((anchor, i) => !i || anchor.start > anchors[i - 1].start)) continue;
      const first = anchors[0], last = anchors.at(-1);
      // Context padding stays within the PDF pages confirmed by the anchors.
      const firstPage = this.pages?.find(page => source.starts[first.start] >= page.start && source.starts[first.start] < page.end);
      const lastPage = this.pages?.find(page => source.starts[last.end - 1] >= page.start && source.starts[last.end - 1] <= page.end);
      scope = {
        start: Math.max(source.starts[Math.max(0, first.start - first.at - 32)], firstPage?.start ?? 0),
        end: Math.min(source.ends[Math.min(source.text.length, last.end + target.text.length - last.at - size + 32) - 1], lastPage?.end ?? this.raw.length)
      };
    }
    if (connect) this.completePage(page, layout);
    const ranges = this.targetConnections(page, false);
    if (blocks && ranges.length) scope = connectionBounds(ranges);
    Object.assign(state, { scope: scope || null, matches, prepared: connect, preparedRanges: connect ? ranges : undefined });
    return state.scope;
  }
  connectAnchors(page, confirmed, blocks, partial) {
    const state = this.connections.get(page), recover = !!(page.sourcePages?.length || page.layer);
    let previous = null;
    for (const { start, end, targetStart, targetEnd, block } of confirmed) {
      // Edge expansion can make adjacent anchor groups overlap. Compare their union
      // so a joined OCR word is not counted twice and selections can cross the seam.
      const merged = previous && (blocks
        ? previous.targetStart >= blocks[block] && previous.start <= start && previous.targetStart <= targetStart
          && Math.abs(previous.end - start) <= 8 && Math.abs(previous.targetEnd - targetStart) <= 8
        : previous.end <= start && previous.targetEnd > targetStart || previous.end > start && previous.targetEnd === targetStart)
        && this.remember(previous.start, Math.max(previous.end, end), page,
          { start: previous.targetStart, end: Math.max(previous.targetEnd, targetEnd) });
      if (merged) state.ranges = state.ranges.filter(item => item !== previous);
      const gap = !blocks && !partial && (previous ? previous.end < start && previous.targetEnd < targetStart
        : page.sourcePages?.length && start <= 2048)
        && this.remember(previous?.end ?? this.raw.length - this.raw.trimStart().length, start, page,
          { start: previous?.targetEnd ?? 0, end: targetStart }, { recover });
      const next = merged || this.remember(start, end, page, { start: targetStart, end: targetEnd });
      if (!recover && gap === null && next) previous.gap = { next, connection: null };
      previous = next;
    }
    if (!blocks && page.sourcePages?.length && previous) {
      // Earlier PDF pages can already cover HTML notes placed after the final body passage.
      let start = previous.end;
      if (page.sourcePages.length > 1) for (const range of [...state.ranges].sort((a, b) => a.start - b.start))
        if (!range.recovered && range.start <= start && range.targetStart < previous.targetStart
          && !/\S/u.test(page.raw.slice(previous.targetStart, range.targetEnd))) start = Math.max(start, range.end);
      if (this.raw.length - start <= 2048 && significantText(this.raw.slice(start)))
        this.remember(start, this.raw.trimEnd().length, page, { start: previous.targetEnd, end: page.raw.trimEnd().length }, { recover: true });
    }
  }
  remember(start, end, target, hit, alignment) {
    if (start > end || hit.start > hit.end) return null;
    const state = this.connections.get(target) || {};
    const existing = state.ranges?.find(item => item.start === start && item.end === end
      && item.targetStart === hit.start && item.targetEnd === hit.end);
    if (existing) return existing;
    const previous = alignment?.previous;
    let diff = alignment?.diff;
    if (!diff) {
      const left = normalized(this, { start, end }), right = normalized(target, hit);
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
    const connection = Object.defineProperty({ ...previous, start, end, targetStart: hit.start, targetEnd: hit.end, distance: diff.distance, spans: diff.parts }, 'target', { value: target });
    if (previous?.editorDiff) connection.editorDiff = textDiff(this.raw.slice(start, end), target.raw.slice(hit.start, hit.end), true, Infinity, true);
    state.ranges = [connection, ...(state.ranges || []).filter(item => item.start !== start || item.end !== end)].slice(0, Math.max(16, this.raw.length));
    this.connections.set(target, state);
    return connection;
  }
  range(target, start, end, reverse = false, connection, marked = false) {
    if (start > end) return null;
    const x = Number(reverse) * 2, y = 2 - x;
    const begin = reverse ? 'targetStart' : 'start', stop = reverse ? 'targetEnd' : 'end';
    let connections = connection ? [connection] : this.targetConnections(target, false);
    connection ||= start < end && connections.find(item => start >= item[begin] && end <= item[stop]);
    // Reuse bounded gap results, including failures, while confirmed neighbours stay unchanged.
    if (!connection && start < end && connections.length > 1) connections = [...connections].sort((a, b) => a[begin] - b[begin]).flatMap((b, i, ordered) => {
      const a = ordered[i - 1];
      const gap = a && a[stop] < end && b[begin] > Math.max(start, a[stop])
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
          && !(marked && part.blank[+reverse])
          : left === right && part.significant[1 - +reverse]
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
    const mapped = !entry.range && this.range(target, entry.start, entry.end, reverse, undefined, marked);
    if (mapped && !mapped.approximate) return mapped;
    const hit = entry.range || (reverse ? this : target).search(entry, scope) || mapped;
    if (!hit || hit === mapped) return hit || null;
    return { ...hit, connection: this.remember(reverse ? hit.start : entry.start, reverse ? hit.end : entry.end, target,
      reverse ? { start: entry.start, end: entry.end } : hit) };
  }

  // Scan each comparison once: add() classifies missing text while collecting its PDF edge.
  scanCandidates(target, connections, { gaps = true, items = null, edits = true } = {}) {
    const pairs = connections ?? this.pairs, live = pairs.length ? pairs : this.livePairs;
    connections = live.length || connections ? live : this.targetConnections(target?.layer ? this.prepared?.full : target);
    const index = target?.layer ? this.fullIndex : target;
    const pages = new Map(index?.pages?.map(page => [page.number, page]));
    const page = target?.layer && pages.get(Number(target.layer.closest('.page')?.dataset.pageNumber));
    if (target && (!index || target.layer && (!page || index.raw.slice(page.start, page.end) !== target.raw)))
      return Object.assign([], { context: null });
    const context = target && { index, page, offset: page?.start || 0 };
    const collected = { edges: [], ranges: [] }, ordered = [];
    for (const connection of connections) {
      const mapped = connection.target;
      const mappedPage = context && mapped !== context.index && mapped?.layer
        && pages.get(Number(mapped.layer.closest('.page')?.dataset.pageNumber));
      const base = !context ? 0 : mapped === context.index
        || mappedPage && context.index.raw.slice(mappedPage.start, mappedPage.end) === mapped.raw
        || mapped?.layer && !context.index.pages?.length ? mappedPage?.start || 0 : null;
      const diff = this.compare(connection);
      if (base !== null && diff) ordered.push(connection);
      this.add(items, connection.start, diff, { connection, edits, connections, base: base ?? 0,
        collected: base === null ? null : collected });
    }
    if (gaps && context) for (const [sourceStart, sourceEnd] of connectionGaps(ordered.sort((a, b) => a.start - b.start),
      this.raw.length - this.raw.trimStart().length, this.raw.trimEnd().length)) collected.ranges.push({ sourceStart, sourceEnd });
    collected.edges.sort((a, b) => a.sourceEnd - b.sourceEnd);
    const matched = !!collected.edges.length;
    for (const range of collected.ranges.sort((a, b) =>
      a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      const edge = collected.edges[lowerBound(collected.edges, range.sourceStart + 1, value => value.sourceEnd) - 1]?.targetEnd || 0;
      const hit = !range.connection && target && this.connections.get(target)?.prepared
        && this.range(target, range.sourceStart, range.sourceEnd, false, undefined, true);
      const resolved = !!(hit && /[\p{L}\p{N}]/u.test(target.raw.slice(hit.start, hit.end))
        && significantText(this.raw.slice(range.sourceStart, range.sourceEnd))
          === significantText(target.raw.slice(hit.start, hit.end)));
      Object.assign(range, { edge, matched, resolved });
    }
    return Object.assign(collected.ranges, { context });
  }
  // Resolve a missing source selection to the preceding confirmed PDF edge.
  missingRange(target, start, end = start) {
    let ranges = this.prepared?.differences?.items?.missingRanges;
    if (!ranges?.context) ranges = this.scanCandidates(target);
    const { context } = ranges;
    if (start === undefined || !context) return ranges;
    const hit = ranges.find(range => !range.resolved && range.sourceStart <= start && range.sourceEnd >= end), a = hit?.edge;
    if (!hit?.matched) return null;
    const parts = context.index.fontRuns(0, context.index.raw.length, true);
    // Missing HTML has no PDF box: use the last paired edge, never unrelated OCR in the gap.
    const part = a ? parts.findLast(part => part.start < a && context.index.raw.slice(part.start, Math.min(a, part.end)).trim())
      : parts.find(part => context.index.raw.slice(part.start, part.end).trim());
    if (!part) return null;
    const text = context.index.raw.slice(part.start, Math.min(a || part.end, part.end));
    const from = a ? part.start + text.trimEnd().length : part.start + text.length - text.trimStart().length;
    const endBias = a > 0;
    if (context.page && (from < context.page.start || from > context.page.end || endBias && from === context.page.start)) return null;
    return { start: from - context.offset, end: from - context.offset, endBias };
  }
  add(items, start, diff, { connection = null, missing = false, notice = null,
    edits = true, connections = this.pairs, collected = null, base = 0 } = {}) {
    if (!diff) return;
    if (!connection) this.compare(null, diff);
    let mappedFirst, mappedLast;
    const number = /^[^\p{L}\d]*(\d+)[^\p{L}\d]*$/u;
    if (collected) for (const [a, b, , right, part] of diff.ranges) {
      if (!part.changed && /\p{L}/u.test(part.pdf)) {
        if (mappedFirst === undefined) mappedFirst = a;
        mappedLast = b;
      }
      if (!part.html.trim() || !part.pdf.trim()) continue;
      collected.edges.push({ sourceEnd: start + b - (part.html.length - part.html.trimEnd().length),
        targetEnd: base + connection.targetStart + right - (part.pdf.length - part.pdf.trimEnd().length) });
    }
    for (const [a, b, , , part] of diff.reviewRanges || diff.ranges) {
      if (!notice && !part.review) continue;
      const htmlNumber = number.exec(part.html), pdfNumber = number.exec(part.pdf);
      const aligned = htmlNumber && pdfNumber, from = start + a + (aligned ? htmlNumber[0].indexOf(htmlNumber[1]) : 0),
        end = from + (aligned ? htmlNumber[1].length : b - a);
      const contains = other => other === connection || other.start <= from && other.end >= end
        && (from < end || other.end > from || other.start === from);
      const text = significantText(this.raw.slice(from, end));
      if (connection && text && connections.some(other => {
        if (other === connection || !contains(other)) return false;
        const hit = this.range(other.target, from, end, false, other);
        return hit && significantText(other.target.raw.slice(hit.start, hit.end)) === text;
      })) continue;
      const insideWord = connection?.target.sourcePages?.length > 1 && /^\p{L}+$/u.test(text)
        && (from > start && /\p{L}/u.test(this.raw[from - 1]) || end < connection.end && /\p{L}/u.test(this.raw[end]));
      const absent = missing || !!collected && !insideWord && /[\p{L}\p{N}]/u.test(part.html)
        && (part.blank[1] || /\p{L}/u.test(part.html) && !/\p{L}/u.test(part.pdf))
        && (mappedFirst === undefined || b <= mappedFirst || a >= mappedLast);
      if (collected && absent) collected.ranges.push({ sourceStart: from, sourceEnd: end, connection });
      if (!items) continue;
      if (connection && connections.find(contains) !== connection) continue;
      const low = lowerBound(items, from, item => item.sourceStart);
      if (items[low]?.sourceStart === from && (items[low].sourceEnd > from || end === from) || low && items[low - 1].sourceEnd > from
        || items[low] && items[low].sourceStart < end && items[low].sourceEnd > from) continue;
      items.splice(low, 0, {
        id: `${from}:${end}`, sourceStart: from, sourceEnd: end, ...(absent ? { missing: true } : {}),
        comparison: { html: aligned ? htmlNumber[1] : part.html, pdf: aligned ? pdfNumber[1] : part.pdf }, options: [
          { id: 'pdf', label: '替换', edits: edits && !absent
            && !(this.starts?.[from] < this.ends?.[from - 1] || this.starts?.[end] < this.ends?.[end - 1])
            ? this.textEdits(from, end, aligned ? pdfNumber[1] : part.pdf) : [] }
        ]
      });
    }
  }
  candidates(notice = null, fonts = false, edits = true, text = true,
    targets = notice ? [] : this.prepared?.pages || [], connections) {
    const items = [];
    if (connections === undefined) {
      connections = targets === this.prepared?.pages ? this.pairs : this.targetConnections(targets);
    }
    const target = text && (targets.find(candidate => candidate?.sourcePages?.length)
      || connections.find(connection => connection.target?.sourcePages?.length)?.target);
    const missing = text && this.scanCandidates(target, connections,
      { gaps: !!target && (this.connections.get(target)?.prepared
        || connections.some(connection => connection.target === target && connection.recovered)), items, edits }) || [];
    if (text && notice?.source && this.raw.slice(notice.source.start, notice.source.end) === notice.html)
      this.add(items, notice.source.start, { parts: comparisonParts(notice) }, { notice, edits, connections });
    for (const range of missing) if (!range.resolved)
      this.add(items, range.sourceStart, { parts: [{ html: this.raw.slice(range.sourceStart, range.sourceEnd),
        pdf: '', changed: true }] }, { missing: true, edits, connections });
    const result = this.formatDifferences(items, fonts, edits, connections);
    // Missing anchors reuse the exact ranges that produced this queue.
    if (missing.context) Object.defineProperty(result, 'missingRanges', { value: missing });
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
  matches(queries, haystack, options) { return findMatches(this, queries, haystack, options); }
  // Search within this index without creating a source/target connection.
  search(entry, scope = null) {
    const offset = scope?.start || 0, haystack = scope ? normalized(this, { start: offset, end: scope.end }) : this.normalized;
    const before = normalized(entry.before).text.trim(), after = normalized(entry.after).text.trim();
    const hit = this.matches([entry.text], haystack, { before, after, best: true }) || this.matches([significantText(entry.text)],
      compact(haystack), { before: significantText(before), after: significantText(after), best: true });
    return hit && { ...hit, start: hit.start + offset, end: hit.end + offset };
  }
  locateSource(chunks) {
    const first = chunks[0], last = chunks.at(-1);
    this.update(chunks.map(chunk => chunk.index));
    const entry = first.index.entry(first.start, first.end, undefined,
      chunks.map(({ index, start, end }) => index.raw.slice(start, end)).join("\n"));
    entry.after = last.index.raw.slice(last.end, last.end + 160);
    const left = this.connections.get(first.index)?.scope, right = this.connections.get(last.index)?.scope;
    const scope = left === right ? left : left && right && left.start <= right.start ? { start: left.start, end: right.end } : null;
    const hit = chunks.length === 1
      ? this.locate(first.index, entry, true, scope)
      : this.search(entry, scope);
    const html = hit && this.raw.slice(hit.start, hit.end);
    const difference = !hit ? { message: "No reliable HTML match" } : html !== entry.text ? { html, pdf: entry.text } : null;
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
    for (const target of new Set([...(this.environment.getTargets?.() || []),
      this.fullIndex].filter(Boolean))) {
      const cached = previous.connections.get(target), original = cached?.ranges || [];
      const state = this.connections.get(target) || {};
      this.connections.set(target, state);
      const retain = item => {
        const delta = start === oldEnd && item.end === start && item.start < start ? null : shift(item);
        if (delta !== null) {
          const kept = Object.defineProperty({ ...item, gap: undefined, start: item.start + delta, end: item.end + delta }, 'target', { value: target }), diff = item.editorDiff;
          if (diff?.context?.[0] === previous.textVersion && this.formats.slice(kept.start, kept.end).every((style, i) => {
            const at = item.start + i, old = previous.formats[at];
            return style.italic === old.italic && style.bold === old.bold && style.name === old.name
              && style.definition?.open === old.definition?.open
              && (!i || (style === this.formats[kept.start + i - 1]) === (old === previous.formats[at - 1]));
          })) kept.editorDiff = { ...diff, context: [this.textVersion, ...diff.context.slice(1)],
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
      const migrated = new Map(), retained = [];
      for (const item of original) {
        const next = retain(item);
        migrated.set(item, next);
        next && retained.push(next);
      }
      if (retained.length) state.ranges = retained;
      const reverseScope = target.connections.get(previous);
      const reverse = (reverseScope?.ranges || []).flatMap(item => {
        const delta = shift({ start: item.targetStart, end: item.targetEnd });
        return delta === null ? [] : [Object.defineProperty({ ...item, gap: undefined, targetStart: item.targetStart + delta, targetEnd: item.targetEnd + delta }, 'target', { value: this })];
      });
      if (reverse.length || previous.raw === this.raw && reverseScope?.scope !== undefined)
        target.connections.set(this, { ...(previous.raw === this.raw ? reverseScope : {}), ranges: reverse.length ? reverse : undefined });
      const scope = cached?.scope, prepared = cached?.preparedRanges, delta = shift(scope);
      if (scope && (delta !== null || retained.length && retained.length === original.length
        && scope.start <= start && scope.end >= oldEnd && prepared?.every(item => migrated.has(item)))) Object.assign(state, {
        prepared: cached.prepared, scope: { start: scope.start + (delta ?? 0), end: scope.end + (delta ?? change) },
        preparedRanges: prepared === original ? retained : prepared?.map(item => migrated.has(item) ? migrated.get(item) : retain(item)).filter(Boolean)
      });
    }
  }
}
window.PdfSelectionDiff.PdfConnections = PdfConnections;
