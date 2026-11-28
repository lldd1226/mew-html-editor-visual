// Native VS Code document access for the shared PDF review scripts.
(() => {
  "use strict";
  // Each document owns its editor model, version snapshot and derived HTML index.
  class DocumentModel {
    constructor({ text = "", model = null } = {}) {
      this.content = text;
      this.model = model;
      this.update(text);
    }

    update(text = this.content) {
      const source = this.model?.getValue?.() ?? text, version = this.model?.getVersionId?.();
      this.content = text;
      if (!this.snapshot || this.snapshot.source !== source || this.snapshot.version !== version) {
        this.snapshot = { source, version }; this.index = null;
      }
    }

    rangeAt(start, end, textOffsets = false) {
      if (textOffsets) {
        const { source, starts, ends } = this.parse();
        [start, end] = [starts[start] ?? source.length, (end > start ? ends[end - 1] : starts[start]) ?? source.length];
      }
      const a = this.model.getPositionAt(start), b = this.model.getPositionAt(end);
      return { startLineNumber: a.lineNumber, startColumn: a.column,
        endLineNumber: b.lineNumber, endColumn: b.column };
    }
    validateEdits(edits) {
      const { source, version } = this.snapshot;
      if (edits.versionId !== undefined && edits.versionId !== version) throw new Error('编辑器内容已变化，无法应用旧修改');
      const sorted = edits.map(edit => {
        if (!edit.range) return { ...edit };
        const range = this.model?.validateRange(edit.range);
        if (!range || ['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn']
          .some(key => !Number.isInteger(edit.range[key]) || range[key] !== edit.range[key])) throw new Error('无效的替换范围');
        return { ...edit, start: this.model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
          end: this.model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }), text: edit.text ?? '' };
      }).sort((a, b) => a.start - b.start || a.end - b.end);
      let previous = null;
      for (const edit of sorted) {
        if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0
          || edit.end < edit.start || edit.end > source.length || typeof edit.text !== 'string') throw new Error('无效的替换范围');
        if (previous && (edit.start < previous.end || edit.start === previous.start)) throw new Error('替换范围重叠，请逐条处理');
        if (edit.expected !== undefined && source.slice(edit.start, edit.end) !== edit.expected) throw new Error('原文已变化，无法应用旧修改');
        previous = edit;
      }
      return Object.defineProperty(sorted, 'versionId', { value: version });
    }
    applyEdits(edits, { editor } = {}) {
      if (editor) {
        this.update(this.content);
        if (!this.model || editor.document !== this) throw new Error('编辑器内容已变化，无法应用旧修改');
        if (editor.getOption()) throw new Error('当前文件只读');
      }
      edits = this.validateEdits(edits);
      if (!editor) {
        const pieces = [];
        let offset = 0;
        for (const edit of edits) {
          pieces.push(this.snapshot.source.slice(offset, edit.start), edit.text); offset = edit.end;
        }
        pieces.push(this.snapshot.source.slice(offset));
        return { source: pieces.join(''), edits };
      }
      if (!edits.length) return;
      editor.pushUndoStop?.();
      const result = editor.applyReviewEdits(edits, this.snapshot.source);
      editor.pushUndoStop?.();
      const check = value => { if (value === false) throw new Error('编辑器未能应用替换'); return value; };
      return result?.then ? result.then(check) : check(result);
    }
    parse(document = globalThis.document) {
      if (this.index) return this.index;
      const starts = [], ends = [], formats = [], byStart = new Map(), tagStack = [];
      const stack = [{ name: '', italic: false, bold: false, tags: [] }];
      let raw = "", ignored = "", rawName, declarationEnd = 0, template;
      const tokens = /<!--[\s\S]*?-->|<!--|<\/?[a-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>|<!(?=[^>]*>)[^><]*>?|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[^<&]+|[<&]/gi;
      for (const token of this.snapshot.source.matchAll(tokens)) {
        const text = token[0], tag = /^<(\/?)\s*([a-z][\w:-]*)/i.exec(text), name = tag?.[2].toLowerCase(), end = token.index + text.length;
        const empty = tag && (/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name) || /\/\s*>$/.test(text));
        const align = name === "p" && text.match(/\balign\s*=\s*["']?(center|right)\b/i)?.[1]?.toLowerCase();
        const node = tag && !tag[1] && (!rawName || !ignored) && { name, start: token.index, openEnd: end, open: text,
          id: name === "p" ? ({ center: "c", right: "r" }[align] || name) : name };
        // Pair repair and formatting retain their own closing policies on shared opening nodes.
        if (tag && (!rawName || tag[1] && name === rawName)) {
          if (tag[1]) {
            const open = tagStack.at(-1), crossed = tagStack.findLastIndex(item => item.name === name);
            if (open && (open.name === name || crossed < 0)) {
              byStart.set(open.start, Object.assign(tagStack.pop(), { closeName: name, closeStart: token.index, end }));
              if (name === rawName) rawName = undefined;
            } else if (crossed >= 0) tagStack.length = crossed;
          } else if (empty) byStart.set(node.start, Object.assign(node, { closeStart: end, end }));
          else {
            tagStack.push(node);
            if (/^(script|style|textarea|title)$/.test(name)) rawName = name;
          }
        }
        if (text.startsWith("<!") && !text.startsWith("<!--")) declarationEnd = this.snapshot.source.indexOf(">", token.index) + 1;
        if (text === "<!--") ignored = "!--";
        if (tag && !tag[1] && /^(head|script|style)$/.test(name)) ignored ||= name;
        if (ignored || text.startsWith("<!") || token.index < declarationEnd) {
          if (tag?.[1] && name === ignored) ignored = "";
          continue;
        }
        let value = text;
        if (tag) {
          if (tag[1]) {
            const at = stack.findLastIndex(value => value.name === name);
            if (at > 0) {
              Object.assign(stack[at].definition, { fontCloseStart: token.index, closeEnd: end, closing: text, rawEnd: raw.length });
              stack.length = at;
            }
          } else if (!empty) {
            const frame = { ...stack.at(-1), name, definition: node }, style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text);
            node.rawStart = raw.length;
            const italic = /(?:^|;)\s*font-style\s*:\s*([^;!]+)/i.exec(style?.[1] ?? style?.[2] ?? "")?.[1].trim();
            const bold = /(?:^|;)\s*font-weight\s*:\s*([^;!]+)/i.exec(style?.[1] ?? style?.[2] ?? "")?.[1].trim();
            node.italic = italic && /^(normal|italic|oblique)\b/i.test(italic) ? !/^normal$/i.test(italic) : /^(i|em)$/.test(name) ? true : null;
            node.bold = bold && /^(normal|bold|[1-9]00)$/i.test(bold) ? /bold/i.test(bold) || Number(bold) >= 600 : /^(b|strong)$/.test(name) ? true : null;
            frame.italic = node.italic ?? frame.italic; frame.bold = node.bold ?? frame.bold;
            if (node.italic !== null || node.bold !== null) frame.tags = [...frame.tags, node];
            stack.push(frame);
          }
          value = (tag[1] && /^(p|div|li|h[1-6])$/.test(name)) || name === "br" ? "\n" : "";
        } else if (document && text.startsWith("&") && text.endsWith(";")) {
          (template ||= document.createElement("template")).innerHTML = text;
          value = template.content.textContent;
        }
        const encoded = value !== text;
        raw += value;
        for (let i = 0; i < value.length; i++) {
          starts.push(token.index + (encoded ? 0 : i));
          ends.push(token.index + (encoded ? text.length : i + 1));
          formats.push(stack.at(-1));
        }
      }
      return this.index = { ...this.snapshot, raw, starts, ends, formats, tags: { pairs: [...byStart.values()], byStart }, model: this.model };
    }


  }

  class VSCodeController {
    constructor(send, request) {
      this.send = send;
      this.request = request;
      this.listeners = new Map();
      this.collections = new Set();
      this.actions = new Map();
      this.editor = this;
      for (const name of ["onDidChangeModel", "onDidChangeModelContent", "onDidChangeCursorSelection", "onDidDispose"]) {
        this[name] = callback => {
          const listeners = this.listeners.get(name) || new Set();
          this.listeners.set(name, listeners); listeners.add(callback);
          return { dispose: () => listeners.delete(callback) };
        };
      }
    }
    emit(name, event) { this.listeners.get(name)?.forEach(callback => callback(event)); }
    receive(snapshot, userSelection = false) {
      const previous = this.snapshot;
      this.snapshot = snapshot;
      if (previous?.uri === snapshot.uri) this.document?.update(snapshot.text);
      if (previous?.uri !== snapshot.uri || previous?.version !== snapshot.version)
        this.collections.forEach(collection => collection.clear());
      if (previous?.uri !== snapshot.uri) {
        const model = snapshot.uri ? {
          uri: { toString: () => snapshot.uri },
          getValue: () => this.snapshot.text,
          getVersionId: () => this.snapshot.version,
          getLanguageId: () => "html",
          getPositionAt: offset => this.positionAt(offset),
          getOffsetAt: position => this.offsetAt(position),
          getValueInRange: range => this.snapshot.text.slice(this.offsetAt(this.range(range).getStartPosition()), this.offsetAt(this.range(range).getEndPosition())),
          validateRange: range => this.range(range)
        } : null;
        this.document = model ? new DocumentModel({ model }) : null;
        this.emit("onDidChangeModel", {});
      } else if (previous?.text !== snapshot.text) this.emit("onDidChangeModelContent", {
        changes: snapshot.version === previous?.version + 1 && snapshot.changes?.length ? snapshot.changes
          : [{ rangeOffset: 0, rangeLength: previous?.text.length || 0, text: snapshot.text }]
      });
      else if (userSelection || JSON.stringify(previous?.selections) !== JSON.stringify(snapshot.selections))
        this.emit("onDidChangeCursorSelection", { source: "keyboard", userSelection });
    }
    positionAt(offset) {
      const text = this.getValue(); offset = Math.max(0, Math.min(text.length, offset));
      const lines = text.slice(0, offset).split("\n");
      return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
    }
    offsetAt({ lineNumber, column }) {
      const lines = this.getValue().split("\n");
      return lines.slice(0, lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + column - 1;
    }
    range(value) {
      const range = { ...value };
      range.getStartPosition = () => ({ lineNumber: range.startLineNumber, column: range.startColumn });
      range.getEndPosition = range.getPosition = () => ({ lineNumber: range.endLineNumber, column: range.endColumn });
      range.equalsRange = other => !!other && ["startLineNumber", "startColumn", "endLineNumber", "endColumn"].every(key => range[key] === other[key]);
      range.isEmpty = () => range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
      range.containsPosition = position => this.offsetAt(position) >= this.offsetAt(range.getStartPosition()) && this.offsetAt(position) <= this.offsetAt(range.getEndPosition());
      range.toString = () => `${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}`;
      // Only coordinates cross the webview bridge; range methods stay local.
      for (const key of Object.keys(range))
        if (typeof range[key] === "function") Object.defineProperty(range, key, { enumerable: false });
      return range;
    }
    get nativeEditor() { return true; }
    getId() { return "mewReader"; }
    getAction(id) { return this.actions.get(id); }
    addAction(action) {
      this.actions.set(action.id, action);
      return { dispose: () => this.actions.delete(action.id) };
    }
    getModel() { return this.document?.model || null; }
    get layout() { return this.snapshot?.layout || null; }
    get splitView() { return this.layout?.splitView ?? null; }
    getValue() { return this.snapshot?.text || ""; }
    getOption() { return !!this.snapshot?.readOnly; }
    getDomNode() { return document.body; }
    hasTextFocus() { return false; }
    getTargetAtClientPoint() { return null; }
    getSelections() { return (this.snapshot?.selections || []).map(value => this.range(value)); }
    getSelection() { return this.getSelections()[0] || this.range({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }); }
    setSelection(range) { this.send("reviewSelection", { selections: [range] }); }
    setPosition(position) { this.setSelection({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }); }
    revealRangeInCenterIfOutsideViewport() {} // reviewSelection reveals in the native editor.
    focus() { this.send("reviewFocus", {}); }
    createDecorationsCollection() {
      let values = [];
      const update = () => this.send("reviewDecorations", { decorations: [...this.collections].flatMap(collection => collection.values()).map(value => ({ range: value.range, className: value.options.inlineClassName ?? value.options.before?.inlineClassName ?? value.options.after?.inlineClassName, hoverMessage: value.options.hoverMessage, after: value.options.after })) });
      const collection = {
        values: () => values,
        get length() { return values.length; },
        getRange: index => values[index] && this.range(values[index].range),
        set: decorations => { this.collections.add(collection); values = decorations; update(); },
        clear: () => { this.collections.delete(collection); values = []; update(); }
      };
      this.collections.add(collection);
      return collection;
    }
    applyReviewEdits(edits, source) {
      return this.request("reviewApply", { edits: edits.map(({ start, end, text }) => ({ start, end, text })), source });
    }
    previewReview({ before, after, edits = [] }) {
      after = new DocumentModel({ text: after }).applyEdits([...this.document.validateEdits(edits)]).source;
      return this.request("reviewPreview", { before, after });
    }
    save() { return this.request("reviewSave", { source: this.getValue() }); }
    showReviewHover(range, hover, focus = false) { this.send("reviewHover", { range, hover, focus }); }
    async runReviewAction(action) {
      if (!['prev', 'next', 'apply', 'advance', 'all', 'save', 'preview-diff', 'close'].includes(action)) return;
      const button = document.querySelector(`.replacement-review:not([hidden]) [data-${action}]`);
      if (button && !button.disabled && !button.hidden) {
        try { await button.onclick?.call(button); }
        finally { window.ReplacementReview?.refreshPresentation(); }
      }
    }
    bindReviewSuggestions(provide, getSession, prepared) {
      if (provide) this.suggestionProvider = provide;
      const plans = prepared ?? this.suggestionProvider?.(this.getModel())
        ?? getSession?.()?.items.flatMap(item => item.options) ?? [];
      if (this.plans === plans && this.plansVersion === this.snapshot?.version) return;
      this.plans = plans; this.plansVersion = this.snapshot?.version;
      this.send("reviewPlans", { plans });
    }
    dispose() { this.emit("onDidDispose"); this.listeners.clear(); this.collections.clear(); this.actions.clear(); }
  }
  const api = { DocumentModel, VSCodeController };
  if (typeof module === "object" && module.exports) module.exports = api;
  else window.MewEditorCore = api;
})();
