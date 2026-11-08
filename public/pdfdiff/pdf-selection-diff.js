// Text comparison and normalization; independent of document and review state.
let diffComputer = null;
const fontKeys = ['italic', 'bold'];
function significantText(text) {
  return text.normalize("NFKC").replace(/ſ/g, "s").replace(/ß/g, "ss").replace(/ẞ/g, "SS")
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[\s\-\u00ad\u2010\u2011]/g, '');
}
function textDiff(left, right, details = false, limit = Infinity, condense = false) {
  if (left === right) return { distance: 0, parts: details ? (left ? [{ html: left, pdf: right, changed: false }] : []) : undefined };
  // A bounded match cannot span more extra characters than its edit limit.
  if (Number.isFinite(limit) && Math.abs(left.length - right.length) > limit && Math.abs(Array.from(left).length - Array.from(right).length) > limit)
    return { distance: limit + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined };
  // Connections condense word runs before the same character refinement used by selections.
  if (condense || !diffComputer || !details && Number.isFinite(limit))
    return localTextDiff(left, right, details, condense ? limit : details ? Math.min(limit, 128) : limit);
  const fallback = details ? localTextDiff(left, right, true, 128) : null;
  if (fallback?.distance <= 128) return fallback;
  try {
    const alignment = diffComputer.computeDiff(left.split("\n"), right.split("\n"), {
      ignoreTrimWhitespace: false, maxComputationTimeMs: 1000,
      computeMoves: false, extendToSubwords: false
    });
    if (alignment.hitTimeout) throw new Error("Monaco diff timed out");
    const offsets = text => {
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
      return range => [starts[range.startLineNumber - 1] + range.startColumn - 1,
        starts[range.endLineNumber - 1] + range.endColumn - 1];
    };
    const offsetA = offsets(left), offsetB = offsets(right), parts = [];
    let a = 0, b = 0, distance = 0;
    for (const change of alignment.changes) {
      if (!change.innerChanges?.length) throw new Error("Missing Monaco character ranges");
      for (const { originalRange: x, modifiedRange: y } of change.innerChanges) {
        const [startA, endA] = offsetA(x), [startB, endB] = offsetB(y);
        if (![startA, endA, startB, endB].every(Number.isInteger) || startA < a || startB < b
          || endA < startA || endB < startB || endA > left.length || endB > right.length
          || left.slice(a, startA) !== right.slice(b, startB)) throw new Error("Invalid Monaco ranges");
        const html = left.slice(startA, endA), pdf = right.slice(startB, endB);
        // Refine each hunk even when the whole passage exceeds the edit budget.
        const refined = details ? localTextDiff(html, pdf, true, 128) : null;
        distance += refined?.distance <= 128 ? refined.distance : Math.max([...html].length, [...pdf].length);
        if (details) {
          appendPart(parts, left.slice(a, startA), right.slice(b, startB), false);
          for (const part of refined.parts) appendPart(parts, part.html, part.pdf, part.changed);
        }
        a = endA; b = endB;
      }
    }
    if (left.slice(a) !== right.slice(b)) throw new Error("Incomplete Monaco ranges");
    if (details) appendPart(parts, left.slice(a), right.slice(b), false);
    return { distance, parts: details ? parts : undefined };
  } catch { /* Retry Monaco on the next comparison. */ }
  return fallback && limit >= 128 ? fallback : localTextDiff(left, right, details, limit);
}
const mixedWhitespace = (left, right) => !!left && !!right
  && /\s/u.test(left) !== /\s/u.test(right) && /[\p{L}\p{N}]/u.test(left + right);
// Detailed unbounded text uses word alignment; bounded/token checks use the edit wavefront.
function localTextDiff(left, right, details = false, limit = Infinity, equal = (a, b) => a === b, substitutions = true) {
  const wordwise = details && typeof left === 'string' && !Number.isFinite(limit);
  if (wordwise) {
    const words = text => text.match(/[\p{L}\p{N}]+(?:[-\u2010\u2011][\p{L}\p{N}]+)*\s*|[^\s]\s*|\s+/gu) || [];
    left = words(left); right = words(right); limit = 1024;
    equal = (a, b) => a.trimEnd() === b.trimEnd() || /^[.,\s]+$/u.test(a + b)
      || /^\d+\s*$/u.test(a) && /^\d+\s*$/u.test(b);
  }
  const originalA = [...left], originalB = [...right];
  const { start, oldEnd: endA, newEnd: endB } = changedRange(originalA, originalB, equal);
  const a = originalA.slice(start, endA), b = originalB.slice(start, endB), n = a.length, m = b.length;
  const bound = Math.min(limit, details && typeof left === 'string' ? 128 : Infinity, Math.max(n, m));
  let previous = new Int32Array([0]), distance = Math.abs(n - m) > bound ? bound + 1 : 0;
  const waves = details ? [{ row: previous, trace: null }] : null;
  for (; distance < bound && previous[n - m + distance] !== n; ) {
    const score = ++distance, row = new Int32Array(2 * score + 1).fill(-1);
    const trace = details ? new Uint8Array(row.length) : null;
    for (let k = Math.max(-score, -m); k <= Math.min(score, n); k++) {
      const at = k + score - 1;
      const replace = previous[at], remove = previous[at - 1], insert = previous[at + 1];
      let x = substitutions && replace >= 0 && replace < n && replace - k >= 0 && replace - k < m
        && !mixedWhitespace(a[replace], b[replace - k]) ? replace + 1 : -1, move = 0;
      // At equal cost, retain the insertion/deletion path and its exact character matches.
      if (remove >= 0 && remove < n && remove + 1 >= x) { x = remove + 1; move = 1; }
      if (insert >= 0 && insert - k - 1 < m && insert >= x) { x = insert; move = 2; }
      if (x < 0) continue;
      let y = x - k;
      while (x < n && y < m && equal(a[x], b[y])) { x++; y++; }
      row[k + score] = x;
      if (trace) trace[k + score] = move;
    }
    previous = row;
    if (details) waves.push({ row, trace });
  }
  const failed = distance > bound || previous[n - m + distance] !== n;
  if (failed) distance = bound + 1;
  if (!details) return { distance };
  const reversed = [];
  let x = n, k = n - m;
  for (let score = failed ? 0 : distance; score > 0; score--) {
    const move = waves[score].trace[k + score], previousK = k + (move === 1 ? -1 : move === 2 ? 1 : 0);
    const previousX = waves[score - 1].row[previousK + score - 1], previousY = previousX - previousK;
    const fromX = previousX + (move !== 2), fromY = previousY + (move !== 1);
    if (x > fromX) reversed.push({ html: a.slice(fromX, x).join(''), pdf: b.slice(fromY, x - k).join(''), changed: false });
    reversed.push({ html: move === 2 ? '' : a[previousX], pdf: move === 1 ? '' : b[previousY], changed: true });
    x = previousX; k = previousK;
  }
  const parts = failed ? [{ html: originalA.join(''), pdf: originalB.join(''), changed: true }] : [];
  if (!failed) appendPart(parts, originalA.slice(0, start).join(''), originalB.slice(0, start).join(''), false);
  for (const part of reversed.reverse()) appendPart(parts, part.html, part.pdf, part.changed);
  if (!failed) appendPart(parts, originalA.slice(endA).join(''), originalB.slice(endB).join(''), false);
  if (!wordwise) return { distance, parts };
  const diff = { distance: 0, parts: [] };
  let html = '', pdf = '';
  for (let i = 0; i <= parts.length; i++) {
    const span = parts[i];
    html += span?.html || ''; pdf += span?.pdf || '';
    // Refine through punctuation-only matches instead of using them as word boundaries.
    if (span && !/[\p{L}\p{N}]/u.test((span.changed ? parts[i + 1] : span)?.html || '')) continue;
    const a = span ? html.trimEnd().length : html.length, b = span ? pdf.trimEnd().length : pdf.length;
    const next = localTextDiff(html.slice(0, a), pdf.slice(0, b), true, 128);
    diff.distance += next.distance;
    for (const part of next.parts) appendPart(diff.parts, part.html, part.pdf, part.changed);
    html = html.slice(a); pdf = pdf.slice(b);
    if (span && !span.changed) {
      let end = 0;
      while (end < html.length && end < pdf.length && html[end] === pdf[end]) end++;
      appendPart(diff.parts, html.slice(0, end), pdf.slice(0, end), false);
      html = html.slice(end); pdf = pdf.slice(end);
    }
  }
  return diff;
}
function changedRange(before, after, equal = (a, b) => a === b) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && equal(before[start], after[start])) start++;
  while (oldEnd > start && newEnd > start && equal(before[oldEnd - 1], after[newEnd - 1])) { oldEnd--; newEnd--; }
  return { start, oldEnd, newEnd };
}
function appendPart(parts, html, pdf, changed) {
  const last = parts.at(-1), previous = parts.at(-2);
  const blank = part => part?.changed && (part.html || part.pdf) && !part.html.trim() && !part.pdf.trim();
  const lettered = part => part?.changed && /[\p{L}\p{N}]/u.test(part.html + part.pdf);
  const separate = blank(last) && lettered({ changed, html, pdf }) || blank({ changed, html, pdf }) && lettered(last);
  if (changed && !pdf && last?.changed === false && previous?.changed && !previous.pdf && /^[\p{L}\p{N}]+$/u.test(last.html) && html.endsWith(last.html)) previous.html += last.html + html.slice(0, -last.html.length);
  else if (last?.changed === changed && !separate) { last.html += html; last.pdf += pdf; }
  else if (html || pdf) parts.push({ html, pdf, changed });
}
function normalized(raw, result = { text: "", starts: [], ends: [] }, base = 0, foldCase = true) {
  if (typeof raw !== 'string') return result.start === 0 && result.end === raw.raw.length
    ? raw.normalized : normalized(raw.raw.slice(result.start, result.end));
  let previous = result.text.at(-1) || "";
  const units = [], { starts, ends } = result;
  for (const match of raw.matchAll(/((?<=[\p{L}\p{N}])[-\u2010\u2011]\s*\n\s*(?=[\p{L}\p{N}]))|((?<![A-Za-z0-9])(?:[A-Za-z0-9][^\S\r\n]+){2,}[A-Za-z0-9](?![A-Za-z0-9]))|([a-zA-Z0-9]+)|(\s+)|(\.(?:\s*\.){2,})|[\s\S]/gu)) {
    const char = match[0], start = base + match.index, offset = start + char.length;
    if (match[1] || char === "\u00ad") continue;
    if (match[2] || match[3]) {
      // Text layers sometimes separate every glyph in a word; source offsets still belong to each glyph.
      let after = start, last = "";
      for (let i = 0; i < char.length; i++) {
        const glyph = char[i];
        if (!/[A-Za-z0-9]/.test(glyph)) continue;
        if (match[2] && /[a-z]/.test(last) && /[A-Z]/.test(glyph)) {
          units.push(" "); starts.push(after); ends.push(start + i);
        }
        units.push(foldCase ? glyph.toLowerCase() : glyph); previous = glyph;
        starts.push(start + i); ends.push(start + i + 1);
        after = start + i + 1; last = glyph;
      }
      previous = foldCase ? previous.toLowerCase() : previous;
      continue;
    }
    const value = match[4] ? ' ' : match[5] ? char.replace(/\s/g, '') : char >= '!' && char <= '~' ? char : char.normalize("NFKC").replace(/ſ/g, "s").replace(/ß/g, "ss").replace(/ẞ/g, "SS")
      .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/\s/g, " ");
    for (const unit of foldCase ? value.toLowerCase() : value) {
      if (unit === " " && previous === " ") { ends[ends.length - 1] = offset; continue; }
      units.push(unit); previous = unit;
      for (let i = 0; i < unit.length; i++) { starts.push(start); ends.push(offset); }
    }
  }
  result.text += units.join("");
  return result;
}
function lowerBound(values, value, key = entry => entry) {
  let low = 0, high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (key(values[mid]) < value) low = mid + 1; else high = mid;
  }
  return low;
}
// Text indexing, matching and confirmed HTML/PDF range alignment.
function extendPageRange(from, to, a, x, step, exact = false, word = /^[\p{L}\p{N}\p{Pd}]{2}$/u) {
  const offset = step < 0 ? -1 : 0;
  // Only the first pass may cross spaces or standalone separators when the next glyph matches.
  while (a + offset >= 0 && a + offset < from.length && x + offset >= 0 && x + offset < to.length) {
    const left = from[a + offset], right = to[x + offset];
    if (!exact && step < 0 && /^[-–—]$/.test(left) && from[a + offset - 1] === ' ' && from[a + offset + 1] === ' '
      && from[a + offset + step * 2] === right) { a += step * 2; continue; }
    if (!exact && step < 0 && /^[-–—]$/.test(right) && to[x + offset - 1] === ' ' && to[x + offset + 1] === ' '
      && to[x + offset + step * 2] === left) { x += step * 2; continue; }
    if (left !== right && (exact || !(left === ' ' && from[a + offset + step] === right)
      && !(right === ' ' && to[x + offset + step] === left))) break;
    if (left === right || left === ' ') a += step;
    if (left === right || right === ' ') x += step;
  }
  if (exact) return [a, x];
  // Keep OCR errors, dotted initials and wrapped compounds inside the same confirmed word.
  let aa = a, xx = x;
  while (aa > 0 && aa < from.length && Math.abs(a - aa) < 32 && word.test(from.slice(aa - 1, aa + 1))) aa += step;
  while (xx > 0 && xx < to.length && Math.abs(x - xx) < 32 && word.test(to.slice(xx - 1, xx + 1))) xx += step;
  if ((a !== aa || x !== xx) && !/[\p{L}\p{N}\p{Pd}]/u.test(from[aa + offset] || '')
    && !/[\p{L}\p{N}\p{Pd}]/u.test(to[xx + offset] || '')
    && textDiff(from.slice(Math.min(a, aa), Math.max(a, aa)), to.slice(Math.min(x, xx), Math.max(x, xx)), false, 32).distance <= 32) { a = aa; x = xx; }
  return extendPageRange(from, to, a, x, step, true, word);
}
function comparisonParts(value, full = value.selection === true) {
  if (value.comparisonDiff?.html !== value.html || value.comparisonDiff.pdf !== value.pdf || value.comparisonDiff.full !== full) {
    let offset = 0;
    value.comparisonDiff = { html: value.html, pdf: value.pdf, full, rows: [], parts: (textDiff(value.html, value.pdf, true)?.parts || [{ html: value.html, pdf: value.pdf, changed: false }]).map(part => ({ ...part,
      start: offset, end: offset += part.html.length, changed: part.changed && (full || significantText(part.html) !== significantText(part.pdf)) })) };
  }
  return value.comparisonDiff.parts;
}
const ready = window.PdfSelectionOptions?.nativeEditor ? Promise.resolve() : import("/monaco/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js")
    .then(({ DefaultLinesDiffComputer }) => diffComputer = new DefaultLinesDiffComputer())
    .catch(() => null);

function documentIndex(documents, pdf, numbers) {
  const index = documents?.get(pdf)?.get(numbers ? `pages:${numbers.join(',')}` : '');
  return index?.normalized ? index : undefined;
}
function* matchPositions(index, needle, { text }, anchors) {
  if (!anchors || text.length < 65536) {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) yield at;
    return;
  }
  // Index aligned 8-character blocks so short anchors also avoid full-volume rescans.
  index.anchorBlocks ||= Map.groupBy(Array.from({ length: Math.floor(text.length / 8) }, (_, i) => i * 8),
    at => text.slice(at, at + 8));
  for (let offset = 0; offset < 8 && offset + 8 <= needle.length; offset++) {
    for (const position of index.anchorBlocks.get(needle.slice(offset, offset + 8)) || []) {
      const at = position - offset;
      if (at >= 0 && text.startsWith(needle, at)) yield at;
    }
  }
}
function findMatches(index, queries, haystack, { anchors = false, fuzzy = false, before = '', after = '', wholeWords = false, best = false } = {}) {
  const found = new Map(), word = char => !!char && /[\p{L}\p{N}_]/u.test(char);
  let bestHit = null, bestTied = false;
  const consider = match => {
    const key = `${match.start}:${match.end}`;
    if (found.has(key)) return;
    found.set(key, match);
    if (!best) return;
    const begin = lowerBound(haystack.starts, match.start), end = lowerBound(haystack.starts, match.end);
    const left = haystack.text.slice(Math.max(0, begin - 400), begin).trim(), right = haystack.text.slice(end, end + 400).trim();
    let a = 0, b = 0;
    while (a < before.length && a < left.length && before.at(-a - 1) === left.at(-a - 1)) a++;
    while (b < after.length && b < right.length && after[b] === right[b]) b++;
    const score = a + b;
    if (!bestHit || score > bestHit.score) { bestHit = { ...match, score }; bestTied = false; }
    else if (score === bestHit.score) bestTied = true;
  };
  for (const query of queries) {
    const needle = anchors ? query : normalized(query).text.trim();
    if (fuzzy) {
      const size = [...needle].length, long = needle.length > 128;
      if (size && size < 3 || !size && (before.length < 4 || after.length < 4) || needle.length > 2048
        || before.length + after.length < 8 || (long && (before.length < 12 || after.length < 12))) return best ? null : [];
      const limit = !size ? 0 : long ? Math.min(32, Math.max(3, Math.floor(size * 0.05)))
        : Math.min(3, Math.max(1, Math.floor(size * 0.2)));
      const starts = new Set(), ends = new Set(), text = haystack.text;
      for (const [context, left] of [[before, true], [after, false]]) {
        if (context.length < 4) continue;
        for (const size of [...new Set([Math.min(24, context.length), Math.min(12, context.length), ...(long ? [] : [4])])]) {
          const anchor = left ? context.slice(-size) : context.slice(0, size);
          let anchored = false;
          for (const at of matchPositions(index, anchor, haystack)) {
            anchored = true;
            let boundary = left ? at + anchor.length : at;
            if (left) {
              while (text[boundary] === ' ') boundary++;
              starts.add(boundary);
            } else {
              while (boundary && text[boundary - 1] === ' ') boundary--;
              if (long) ends.add(boundary);
              else for (let delta = -limit; delta <= limit; delta++) starts.add(boundary - needle.length + delta);
            }
            if (starts.size > 200 || ends.size > 200) return best ? null : [];
          }
          if (anchored) break;
        }
      }
      for (const begin of starts) for (const end of long ? ends : Array.from({ length: limit * 2 + 1 }, (_, i) => begin + needle.length - limit + i)) {
        if (Math.abs(end - begin - needle.length) > limit
          || begin < 0 || end > text.length || text[begin] === ' ' || text[end - 1] === ' ') continue;
        // Never cut a normalized glyph (e.g. a ligature or a surrogate pair).
        if ((begin && haystack.starts[begin] === haystack.starts[begin - 1]) || (end < text.length && haystack.starts[end] === haystack.starts[end - 1])) continue;
        const distance = textDiff(needle, text.slice(begin, end), false, limit).distance;
        if (size && !distance || distance > limit) continue;
        const start = haystack.starts[begin], stop = size ? haystack.ends[end - 1] : start;
        consider({ start, end: stop, approximate: true, distance });
      }
    } else if (needle) {
      for (const at of matchPositions(index, needle, haystack, anchors)) {
        const end = at + needle.length;
        const before = [...haystack.text.slice(Math.max(0, at - 2), at)].pop(), after = [...haystack.text.slice(end, end + 2)][0];
        if (wholeWords && (word(needle[0]) && word(before) || word([...needle].pop()) && word(after))) continue;
        const start = haystack.starts[at], stop = haystack.ends[end - 1];
        consider({ start, end: stop });
        if (anchors && found.size > 1) return [...found.values()]; // Only unique anchors are useful.
      }
    }
  }
  if (best && bestHit?.score >= Math.min(24, before.length + after.length)) return bestTied ? null : bestHit;
  if (best && !fuzzy) return findMatches(index, queries, haystack, { anchors, fuzzy: true, before, after, wholeWords, best });
  if (best) return null;
  return [...found.values()];
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

window.PdfSelectionDiff = { pdfTextBaseline, pdfFontStyle, fontKeys, textDiff, localTextDiff, changedRange, normalized, lowerBound, significantText, extendPageRange, comparisonParts, documentIndex, findMatches, ready };
export { pdfTextBaseline, pdfFontStyle, fontKeys, textDiff, localTextDiff, changedRange, normalized, lowerBound, significantText, extendPageRange, comparisonParts, documentIndex, findMatches, ready };
