(() => {
  "use strict";

  // Each document owns its editor model, version snapshot and derived HTML index.
  class DocumentModel {
    static async load(options) {
      return new DocumentModel({ ...options, ...await options.read() });
    }

    constructor({ text = "", mtime = null, editable = true, read, write, path, model, api, language = "html", uri, onChange } = {}) {
      this.content = text;
      Object.assign(this, { editable, read, write, path });
      this.revision = this.reloadRevision = 0;
      this.pending = Promise.resolve();
      this.model = model ?? api?.editor.createModel(text, language, uri) ?? null;
      this.update(text, { text, mtime });
      this.model?.onDidChangeContent?.(() => { const wasDirty = this.dirty; this.update(); onChange?.(this, wasDirty); });
    }

    dispose() {
      this.model?.dispose();
      this.model = this.snapshot = this.index = null;
    }

    get dirty() { return this.content !== this.savedContent; }

    textFromEditor(text) {
      const normalize = value => value.replace(/\r\n?/g, "\n");
      for (const source of [this.content, this.savedContent]) {
        if (normalize(source) === normalize(text)) return source;
      }
      return text;
    }

    update(text, saved) {
      const source = this.model?.getValue?.() ?? text ?? this.content, version = this.model?.getVersionId?.();
      text ??= this.textFromEditor(source);
      if (text !== this.content) this.revision += 1;
      this.content = text;
      if (!this.snapshot || this.snapshot.source !== source || this.snapshot.version !== version) {
        this.snapshot = { source, version }; this.index = null;
      }
      if (saved) { this.savedContent = saved.text; this.mtime = saved.mtime; }
    }

    enqueue(operation) {
      const task = this.pending.then(operation);
      this.pending = task.catch(() => {});
      return task;
    }

    save(text = this.content, { latest = false } = {}) {
      const revision = this.reloadRevision;
      return this.enqueue(async () => {
        if (latest) {
          if (!this.dirty) return;
          text = this.content;
        } else if (revision !== this.reloadRevision) throw new Error("File reloaded before saving. Review the current content and save again.");
        if (!this.editable) throw new Error("Document is read-only");
        const result = await this.write({ text, mtime: this.mtime });
        this.update(this.content, { text, mtime: result.mtime });
        return result;
      });
    }

    async saveUntilClean() {
      while (this.dirty) await this.save(undefined, { latest: true });
    }

    refresh() {
      return this.enqueue(async () => {
        const { text, mtime } = await this.read();
        const status = text === this.savedContent ? "unchanged" : text === this.content ? "saved" : this.dirty ? "conflict" : "updated";
        if (status === "conflict") return status;
        if (status === "updated") this.reloadRevision += 1;
        this.update(status === "updated" ? text : this.content, { text, mtime });
        return status;
      });
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
    applyEdits(edits, { editor, origin = 'review-replacement', selections } = {}) {
      const api = editor?.getDomNode?.()?.ownerDocument?.defaultView?.monaco;
      if (editor) {
        this.update(this.content);
        if (!this.model || editor.document !== this) throw new Error('编辑器内容已变化，无法应用旧修改');
        if (!this.editable || editor.getOption?.(api?.editor.EditorOption.readOnly ?? 104)) throw new Error('当前文件只读');
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
      const result = editor.executeEdits(origin, edits.map(edit => edit.range ? edit
        : { range: this.rangeAt(edit.start, edit.end), text: edit.text, forceMoveMarkers: true }), typeof selections === 'function' ? selections
        : selections && (() => selections.map(selection => selection.selectionStartLineNumber !== undefined ? selection
          : api.Selection.fromPositions(this.model.getPositionAt(selection.start), this.model.getPositionAt(selection.end)))));
      editor.pushUndoStop?.();
      const check = value => { if (value === false) throw new Error('编辑器未能应用替换'); return value; };
      return result?.then ? result.then(check) : check(result);
    }
    parse(document = window.document) {
      if (this.index) return this.index;
      // Editable tag, text-layout and font rules shared by pairs and definitions.
      const rules = {
        voidTags: /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/,
        rawTags: /^(script|style|textarea|title)$/,
        ignoredTags: /^(head|script|style)$/,
        newlineTags: /^(p|div|li|h[1-6])$/, lineBreakTag: "br",
        style: /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
        fonts: [
          ['italic', /^(i|em)$/, /(?:^|;)\s*font-style\s*:\s*([^;!]+)/i, /^(normal|italic|oblique)\b/i, value => !/^normal$/i.test(value)],
          ['bold', /^(b|strong)$/, /(?:^|;)\s*font-weight\s*:\s*([^;!]+)/i, /^(normal|bold|[1-9]00)$/i, value => /bold/i.test(value) || Number(value) >= 600]
        ],
        paragraphTag: "p", align: /\balign\s*=\s*["']?(center|right)\b/i,
        alignIds: { center: "c", right: "r" }
      };
      const starts = [], ends = [], formats = [], byStart = new Map(), tagStack = [];
      const stack = [{ name: '', italic: false, bold: false, tags: [] }];
      let raw = "", ignored = "", rawName, sharedTags = true, template;
      const tokens = /<!--[\s\S]*?-->|<!--|<![^>]*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[^<&]+|[<&]/gi;
      for (const token of this.snapshot.source.matchAll(tokens)) {
        const text = token[0], tag = /^<(\/?)\s*([a-z][\w:-]*)/i.exec(text), name = tag?.[2].toLowerCase(), end = token.index + text.length;
        const empty = tag && (rules.voidTags.test(name) || /\/\s*>$/.test(text));
        const align = name === rules.paragraphTag && text.match(rules.align)?.[1]?.toLowerCase();
        const node = tag && !tag[1] && (!rawName || !ignored) && { name, start: token.index, openEnd: end, open: text,
          id: name === rules.paragraphTag ? rules.alignIds[align] || name : name };
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
            if (rules.rawTags.test(name)) rawName = name;
          }
        }
        if (text.startsWith("<!") && !text.startsWith("<!--") && text.slice(2).includes("<")) sharedTags = false;
        if (text === "<!--") ignored = "!--";
        if (tag && !tag[1] && rules.ignoredTags.test(name)) ignored ||= name;
        if (ignored || text.startsWith("<!")) {
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
            const frame = { ...stack.at(-1), name, definition: node }, style = rules.style.exec(text);
            node.rawStart = raw.length;
            for (const [key, tags, declaration, valid, enabled] of rules.fonts) {
              const value = style && declaration.exec(style[1] ?? style[2])?.[1].trim();
              node[key] = value && valid.test(value) ? enabled(value) : tags.test(name) ? true : null;
              frame[key] = node[key] ?? frame[key];
            }
            if (node.italic !== null || node.bold !== null) frame.tags = [...frame.tags, node];
            stack.push(frame);
          }
          value = (tag[1] && rules.newlineTags.test(name)) || name === rules.lineBreakTag ? "\n" : "";
        } else if (text.startsWith("&") && text.endsWith(";")) {
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
      return this.index = { ...this.snapshot, raw, starts, ends, formats, tags: sharedTags ? { pairs: [...byStart.values()], byStart } : undefined, model: this.model };
    }
  }

  const registeredColorProviders = new WeakSet();
  const vscodeHtmlThemeRules = dark => {
    const colors = dark ? {
      delimiter: "808080", tag: "7EE787", attribute: "79C0FF", string: "A5D6FF", comment: "8B949E"
    } : {
      delimiter: "800000", tag: "116329", attribute: "0550AE", string: "0A3069", comment: "6E7781"
    };
    return [
      { token: "delimiter.html", foreground: colors.delimiter },
      { token: "tag.html", foreground: colors.tag },
      { token: "attribute.name.html", foreground: colors.attribute },
      { token: "attribute.value.html", foreground: colors.string },
      { token: "comment.html", foreground: colors.comment },
      { token: "comment.content.html", foreground: colors.comment }
    ];
  };

  const vscodeEditorThemeColors = dark => dark ? {
    "focusBorder": "#3994BCB3",
    "input.background": "#191A1B", "input.border": "#333536", "input.foreground": "#BFBFBF", "input.placeholderForeground": "#555555",
    "scrollbar.shadow": "#191B1D4D", "scrollbarSlider.background": "#A8A9AA85", "scrollbarSlider.hoverBackground": "#A8A9AA90", "scrollbarSlider.activeBackground": "#A8A9AA9C",
    "editor.background": "#121314", "editor.foreground": "#BBBEBF", "editorCursor.foreground": "#BBBEBF",
    "editorLineNumber.foreground": "#858889", "editorLineNumber.activeForeground": "#BBBEBF",
    "editor.selectionBackground": "#276782DD", "editor.inactiveSelectionBackground": "#27678260", "editor.selectionHighlightBackground": "#27678260",
    "editor.wordHighlightBackground": "#27678250", "editor.wordHighlightStrongBackground": "#27678280",
    "editor.findMatchBackground": "#27678290", "editor.findMatchHighlightBackground": "#27678280", "editor.findRangeHighlightBackground": "#FFFFFF13",
    "editor.hoverHighlightBackground": "#FFFFFF13", "editor.lineHighlightBackground": "#242526", "editor.rangeHighlightBackground": "#FFFFFF13",
    "editorLink.activeForeground": "#3A94BC", "editorWhitespace.foreground": "#8C8C8C4D",
    "editorIndentGuide.background1": "#8384854D", "editorIndentGuide.activeBackground1": "#838485", "editorRuler.foreground": "#848484", "editorCodeLens.foreground": "#8C8C8C",
    "editorBracketMatch.background": "#3994BC55", "editorBracketMatch.border": "#2A2B2C",
    "editorWidget.background": "#202122", "editorWidget.border": "#2A2B2C", "editorWidget.foreground": "#BFBFBF",
    "editorSuggestWidget.background": "#202122", "editorSuggestWidget.border": "#2A2B2C", "editorSuggestWidget.foreground": "#BFBFBF",
    "editorSuggestWidget.highlightForeground": "#BFBFBF", "editorSuggestWidget.selectedBackground": "#FFFFFF26", "editorSuggestWidget.focusOutline": "#3994BCB3",
    "editorHoverWidget.background": "#202122", "editorHoverWidget.border": "#2A2B2C", "editorGutter.background": "#121314",
    "editorOverviewRuler.border": "#2A2B2C", "editorOverviewRuler.findMatchForeground": "#3A94BC99"
  } : {
    "focusBorder": "#0069CC",
    "input.background": "#FFFFFF", "input.border": "#D8D8D866", "input.foreground": "#202020", "input.placeholderForeground": "#999999",
    "scrollbar.shadow": "#00000000", "scrollbarSlider.background": "#646464C0", "scrollbarSlider.hoverBackground": "#646464D0", "scrollbarSlider.activeBackground": "#646464E0",
    "editor.background": "#FFFFFF", "editor.foreground": "#202020", "editorCursor.foreground": "#202020",
    "editorLineNumber.foreground": "#606060", "editorLineNumber.activeForeground": "#202020",
    "editor.selectionBackground": "#0069CC40", "editor.inactiveSelectionBackground": "#0069CC1A", "editor.selectionHighlightBackground": "#0069CC15",
    "editor.wordHighlightBackground": "#0069CC26", "editor.wordHighlightStrongBackground": "#0069CC26",
    "editor.findMatchBackground": "#0069CC40", "editor.findMatchHighlightBackground": "#0069CC1A", "editor.findRangeHighlightBackground": "#00000015",
    "editor.hoverHighlightBackground": "#00000015", "editor.lineHighlightBackground": "#EAEAEA40", "editor.rangeHighlightBackground": "#00000015",
    "editorLink.activeForeground": "#0069CC", "editorWhitespace.foreground": "#60606040",
    "editorIndentGuide.background1": "#F7F7F740", "editorIndentGuide.activeBackground1": "#EEEEEE", "editorRuler.foreground": "#F7F7F7", "editorCodeLens.foreground": "#606060",
    "editorBracketMatch.background": "#0069CC40", "editorBracketMatch.border": "#F0F1F2",
    "editorWidget.background": "#FAFAFD", "editorWidget.border": "#E4E5E6", "editorWidget.foreground": "#202020",
    "editorSuggestWidget.background": "#FAFAFD", "editorSuggestWidget.border": "#E4E5E6", "editorSuggestWidget.foreground": "#202020",
    "editorSuggestWidget.highlightForeground": "#0069CC", "editorSuggestWidget.selectedBackground": "#00000025", "editorSuggestWidget.selectedForeground": "#202020", "editorSuggestWidget.selectedIconForeground": "#202020", "editorSuggestWidget.focusOutline": "#0069CC",
    "editorHoverWidget.background": "#FAFAFD", "editorHoverWidget.border": "#E4E5E6", "editorGutter.background": "#FFFFFF",
    "editorOverviewRuler.border": "#F0F1F2", "editorOverviewRuler.findMatchForeground": "#0069CC99"
  };
  // 两个入口共用默认配置；调用方直接传入各自的覆盖项。
  const monacoOptions = {
    model: null, automaticLayout: true, fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 14, lineHeight: 21, tabSize: 2, wordWrap: "on", minimap: { enabled: false },
    find: { addExtraSpaceOnTop: false },
    cursorStyle: "line", cursorWidth: 2, cursorBlinking: "smooth", cursorSmoothCaretAnimation: "explicit",
    // Monaco 0.55.1 在快速切换模型时可能取消 occurrence 请求并报错。
    occurrencesHighlight: "off", scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 },
    colorDecorators: true, defaultColorDecorators: "never",
    renderLineHighlight: "gutter", renderLineHighlightOnlyWhenFocus: true
  };
  const registeredThemes = new WeakSet();

  function setMonacoTheme(api, dark) {
    if (!registeredThemes.has(api)) {
      for (const isDark of [false, true]) {
        api.editor.defineTheme(isDark ? "mew-dark" : "mew-light", {
          base: isDark ? "vs-dark" : "vs", inherit: true,
          rules: vscodeHtmlThemeRules(isDark), colors: vscodeEditorThemeColors(isDark)
        });
      }
      registeredThemes.add(api);
    }
    api.editor.setTheme(dark ? "mew-dark" : "mew-light");
  }

  function registerHtmlStyleColorProvider(api) {
    if (registeredColorProviders.has(api)) return;
    registeredColorProviders.add(api);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const cssRegions = text => {
      const regions = [];
      for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
        regions.push({ start: match.index + match[0].indexOf(match[1]), text: match[1] });
      }
      for (const tag of text.matchAll(/<(?!style\b|\/|!)[^>]+>/gi)) {
        for (const attr of tag[0].matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
          regions.push({ start: tag.index + attr.index + attr[0].indexOf(attr[2]), text: attr[2] });
        }
      }
      return regions;
    };
    const parse = value => {
      if (!context || !CSS.supports("color", value)) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return { red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha / 255 };
    };
    const colorPattern = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|(?:rgba?|hsla?)\([^)]*\)/gi;
    api.languages.registerColorProvider("html", {
      provideDocumentColors(model) {
        const colors = [];
        for (const region of cssRegions(model.getValue())) {
          for (const match of region.text.matchAll(colorPattern)) {
            const color = parse(match[0]);
            if (!color) continue;
            const start = region.start + match.index;
            colors.push({ color, range: api.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(start + match[0].length)) });
          }
        }
        return colors;
      },
      provideColorPresentations(_model, { color, range }) {
        const bytes = [color.red, color.green, color.blue, color.alpha].map(value => Math.round(value * 255));
        const hex = bytes.slice(0, bytes[3] === 255 ? 3 : 4).map(value => value.toString(16).padStart(2, "0")).join("");
        const label = `#${hex}`;
        return [{ label, textEdit: { range, text: label } }];
      }
    });
  }

  class MonacoController {
    constructor(api, host, { scale = 1, dark = false, ...options } = {}) {
      this.api = api;
      registerHtmlStyleColorProvider(api);
      setMonacoTheme(api, dark);
      const config = { ...monacoOptions, ...options };
      this.fontSize = config.fontSize;
      this.lineHeight = config.lineHeight;
      this.editor = api.editor.create(host, {
        ...config, fontSize: this.fontSize * scale, lineHeight: Math.round(this.lineHeight * scale)
      });
      this.editor.document = this.editor.getModel() ? new DocumentModel({ model: this.editor.getModel() }) : null;
      const settingLabels = new Map();
      for (const [index, [name, label, values, read, write]] of [
        ["wordWrap", "自动换行", ["off", "on"]],
        ["minimap", "缩略图", [false, true], value => value.enabled, value => ({ enabled: value })],
        ["renderWhitespace", "显示空白字符", ["none", "all"]],
        ["guides", "缩进参考线", [false, true], value => value.indentation, value => ({ indentation: value })],
        ["folding", "代码折叠", [false, true]]
      ].entries()) {
        settingLabels.set(`mew.editor.toggle.${name}`, () => {
          const option = this.editor.getOption(api.editor.EditorOption[name]);
          const enabled = (read ? read(option) : option) !== values[0];
          return `${label}：${enabled ? "开启" : "关闭"}`;
        });
        this.editor.addAction({
          id: `mew.editor.toggle.${name}`, label: `切换${label}`,
          contextMenuGroupId: "mew.editor.settings", contextMenuOrder: index + 1,
          run: () => {
            const option = this.editor.getOption(api.editor.EditorOption[name]);
            const value = (read ? read(option) : option) === values[0] ? values[1] : values[0];
            this.editor.updateOptions({ [name]: write ? write(value) : value });
          }
        });
      }
      window.dispatchEvent(new CustomEvent("mew-monaco-ready", { detail: { editor: this.editor } }));
      // 菜单执行前恢复焦点；粘贴复用已有剪贴板读取方式及 Monaco 的 paste 处理。
      const menu = this.editor.getContribution("editor.contrib.contextmenu");
      const getActions = menu._getMenuActions.bind(menu);
      let SubmenuAction;
      menu._getMenuActions = (...args) => {
        const actions = getActions(...args).map(action => {
          if (!/^editor\.action\.clipboard(Copy|Cut|Paste)Action$/.test(action.id)) return action;
          const run = action.run.bind(action);
          action.run = (...params) => { this.focus(); const model = this.editor.getModel(); return action.id.endsWith("PasteAction")
            ? navigator.clipboard.readText().then(text => { if (text && this.editor.getModel() === model && !this.editor.getOption(api.editor.EditorOption.readOnly)) this.editor.trigger("mew", "paste", { text }); }) : run(...params); };
          return action;
        });
        // addAction prefixes menu command IDs with the editor instance ID.
        const actionId = action => action.id.startsWith(this.editor.getId() + ':')
          ? action.id.slice(this.editor.getId().length + 1) : action.id;
        for (const action of actions) {
          const getLabel = settingLabels.get(actionId(action));
          if (getLabel) action.label = getLabel();
          if (actionId(action).startsWith('mew.view.')) {
            action.label = document.getElementById(`${actionId(action).slice('mew.view.'.length)}PaneToggle`).textContent;
          }
        }
        const groups = [
          ["view", "视图", id => id.startsWith("mew.view.")],
          ["editor", "编辑器设置", id => id.startsWith("mew.editor.toggle.")],
          ["reader", "阅读器设置", id => id.startsWith("mew.reader.") && id !== "mew.reader.workspace"],
          ["tags", "标签面板设置", id => id.startsWith("mew.tag-panel.") && id !== "mew.tag-panel.visible"],
          ["diff", "差异设置", id => id.startsWith("replacement-review.toggle.") && id !== "replacement-review.toggle.pdf-selection-sync"]
        ];
        // Reuse Monaco's own SubmenuAction type so its menu renders the arrow,
        // hover expansion and keyboard navigation. The built-in Peek item is
        // a SubmenuItemAction, whose base class is SubmenuAction.
        if (!SubmenuAction) {
          // Include Peek even when this language has no navigation providers.
          // These unfiltered actions are used only to obtain the native type.
          const submenu = menu._menuService.getMenuActions(this.editor.contextMenuId, { contextMatchesRules: () => true })
            .flatMap(([, items]) => items).find(action => action.item?.submenu);
          SubmenuAction = Object.getPrototypeOf(submenu.constructor.prototype).constructor;
        }
        const grouped = new Set();
        const result = actions.flatMap(action => {
          const group = groups.find(([, , matches]) => matches(actionId(action)));
          if (!group) return [action];
          const [id, label, matches] = group;
          if (grouped.has(id)) return [];
          grouped.add(id);
          return [new SubmenuAction(`mew.settings.${id}`, label, actions.filter(item => matches(actionId(item))))];
        });
        return result.filter((action, index) => action.id !== "vs.actions.separator"
          || index > 0 && index < result.length - 1 && result[index - 1].id !== "vs.actions.separator");
      };
    }

    setDocument(document) {
      this.editor.document = document;
      this.editor.setModel(document?.model || null);
    }
    focus() { this.editor.focus(); }
    hasTextFocus() { return this.editor.hasTextFocus(); }
    setEditable(editable) { this.editor.updateOptions({ readOnly: !editable }); }
    setScale(scale) {
      this.editor.updateOptions({ fontSize: this.fontSize * scale, lineHeight: Math.round(this.lineHeight * scale) });
    }
    selection() {
      const selection = this.editor.getSelection();
      return selection && this.editor.getModel() ? { start: this.editor.getModel().getOffsetAt(selection.getStartPosition()), end: this.editor.getModel().getOffsetAt(selection.getEndPosition()) } : { start: 0, end: 0 };
    }
    setSelection(start, end = start) {
      this.editor.setSelection(this.api.Selection.fromPositions(this.editor.getModel().getPositionAt(start), this.editor.getModel().getPositionAt(end)));
    }
    setValue(text, preserveUndo = false, origin = "mew.setValue") {
      text = String(text ?? "");
      if (!this.editor.getModel() || this.editor.getValue() === text) return;
      if (!preserveUndo) return this.editor.getModel().setValue(text);
      const range = this.editor.getModel().getFullModelRange();
      return this.editor.document.applyEdits([{ range, text, forceMoveMarkers: true }], { editor: this.editor, origin });
    }
    undo() { this.editor.trigger("mew", "undo"); this.focus(); }
    redo() { this.editor.trigger("mew", "redo"); this.focus(); }
    canUndo() { return Boolean(this.editor.getModel()?.canUndo()); }
    canRedo() { return Boolean(this.editor.getModel()?.canRedo()); }
    async toggleFind({ replace = true, toggleIfVisible = true, readClipboard = false } = {}) {
      const visible = this.editor.getDomNode()?.querySelector(".find-widget")?.classList.contains("visible");
      if (visible && toggleIfVisible) return this.editor.trigger("mew", "closeFindWidget");
      const selected = this.editor.getModel()?.getValueInRange(this.editor.getSelection());
      const clipboard = !selected && readClipboard && !visible && navigator.clipboard?.readText?.().catch(() => null);
      if (!visible) this.focus();
      await this.editor.getAction(replace ? "editor.action.startFindReplaceAction" : "actions.find")?.run();
      const text = selected || await clipboard;
      if (text) this.editor.getContribution("editor.contrib.findController")?.setSearchString(text.replace(/\r\n?/g, "\n"));
    }
  }

  function languageForPath(api, path) {
    const name = String(path).replaceAll("\\", "/").split("/").pop().toLowerCase();
    const languages = api.languages.getLanguages();
    const named = languages.find(language => language.filenames?.some(filename => filename.toLowerCase() === name));
    if (named) return named.id;
    let match = null;
    for (const language of languages) {
      for (const extension of language.extensions || []) {
        const suffix = extension.toLowerCase();
        if (name.endsWith(suffix) && (!match || suffix.length > match.suffix.length)) match = { id: language.id, suffix };
      }
    }
    return match?.id || "plaintext";
  }

  function createChannel(session, receive) {
    const name = `mew-reader-${session}`;
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(name);
      channel.onmessage = event => receive(event.data);
      return channel;
    }
    const key = `__${name}`;
    const listener = event => {
      if (event.key !== key || !event.newValue) return;
      try { receive(JSON.parse(event.newValue).message); } catch { /* ignore malformed peer data */ }
    };
    window.addEventListener("storage", listener);
    return {
      postMessage(message) { localStorage.setItem(key, JSON.stringify({ nonce: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, message })); },
      close() { window.removeEventListener("storage", listener); }
    };
  }

  async function saveBeforeNavigation(isDirty, save) {
    while (isDirty()) {
      if (await save() === false) return false;
    }
    return true;
  }

  function mountFooter() {
    const host = document.querySelector('footer.statusbar');
    if (!host) return null;
    const extra = [...host.children];
    host.innerHTML = `${host.hasAttribute('data-file-info') ? '<span id="fileInfo"></span>' : ''}<output id="status" role="status" aria-live="polite" aria-atomic="true"></output><span id="positionInfo"></span><span id="languageInfo">${host.dataset.language || '纯文本'} · UTF-8</span><button id="prevFileBtn" type="button" title="上一文件 · 自动保存" aria-label="上一文件">←</button><button id="nextFileBtn" type="button" title="下一文件 · 自动保存" aria-label="下一文件">→</button>`;
    const status = host.querySelector('#status');
    extra.forEach(node => host.insertBefore(node, node.id === 'layoutReset' ? host.querySelector('#prevFileBtn') : status));
    const style = document.createElement('style');
    style.textContent = `
      .statusbar { flex:none; min-width:0; overflow:hidden; min-height:24px; display:flex; align-items:center; gap:10px; padding:1px 10px; border-top:1px solid var(--line); background:var(--chrome,var(--panel)); color:var(--muted); font-size:12px; }
      .statusbar button { flex:none; min-height:22px; padding:1px 5px; font-size:12px; }
      .statusbar #fileInfo,.statusbar .context { flex:0 1 auto; max-width:25%; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .statusbar #status { flex:1 1 0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .statusbar #positionInfo,.statusbar #languageInfo { flex:0 1 auto; min-width:0; margin-left:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .statusbar .context strong,.statusbar .context small { font-size:11px; font-weight:400; }
    `;
    document.head.append(style);
    let timer;
    return {
      host,
      setNavigation(handler) {
        host.querySelector('#prevFileBtn').onclick = () => handler(-1);
        host.querySelector('#nextFileBtn').onclick = () => handler(1);
      },
      setAvailable(previous, next) {
        host.querySelector('#prevFileBtn').disabled = !previous;
        host.querySelector('#nextFileBtn').disabled = !next;
      },
      notify(message, persistent = false) {
        clearTimeout(timer);
        status.textContent = status.title = message || '';
        if (message && !persistent) timer = setTimeout(() => { status.textContent = status.title = ''; }, 2600);
      },
      setPosition(line, column) { host.querySelector('#positionInfo').textContent = `Ln ${line}, Col ${column}`; },
      setLanguage(text) { host.querySelector('#languageInfo').textContent = text; },
      setFile(path) { const file = host.querySelector('#fileInfo'); if (file) file.textContent = file.title = path || ''; }
    };
  }
  const footer = typeof document !== 'undefined' ? mountFooter() : null;

  function loadMonaco(path = "/monaco/min/vs") {
    if (typeof require !== "function") return Promise.reject(new Error("Monaco 加载器未载入"));
    require.config({ paths: { vs: path } });
    return new Promise((resolve, reject) => require(["vs/editor/editor.main"], resolve, reject));
  }

  window.MewEditorCore = { DocumentModel, MonacoController, createChannel, languageForPath, loadMonaco, setMonacoTheme, footer, saveBeforeNavigation };
})();
