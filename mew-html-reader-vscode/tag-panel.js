(() => {
  "use strict";
  const tags = [
    { id: "b", label: "B", shortcut: "b", open: "<b>", close: "</b>", title: "Alt+B / b" },
    { id: "i", label: "I", shortcut: "i", open: "<i>", close: "</i>", title: "Alt+I / i" },
    { id: "em", label: "EM", shortcut: "em", open: "<em>", close: "</em>", title: "Insert emphasis" },
    { id: "q", label: "Q", shortcut: "q", open: "<blockquote>", close: "</blockquote>", title: "Alt+Q / q" },
    { id: "a", label: "A", shortcut: "a", open: "<a href=\"\" id=\"\">", close: "</a>", title: "Alt+A / a" },
    { id: "x", label: "AID", shortcut: "x", open: "<a id=\"\">", close: "</a>", title: "Alt+X / x" },
    { id: "l", label: "HREF", shortcut: "l", open: "<a href=\"\">", close: "</a>", title: "Alt+L / l" },
    { id: "f", label: "FN", shortcut: "f", open: "<sup><a href=\"\" id=\"\">", close: "</a></sup>", title: "Alt+F / f" },
    { id: "r", label: "R", shortcut: "r", open: "<p align=\"right\">", close: "</p>", title: "Alt+R / r" },
    { id: "c", label: "C", shortcut: "c", open: "<p align=\"center\">", close: "</p>", title: "Alt+C / c" },
    { id: "ltgt", label: "&lt;&gt;", open: "&lt;", close: "&gt;", title: "Insert angle bracket" },
    ...Array.from({ length: 6 }, (_, index) => {
      const shortcut = String(index + 1), id = `h${shortcut}`;
      return { id, label: id.toUpperCase(), shortcut, open: `<${id}>`, close: `</${id}>`, title: `Alt+${shortcut} / ${shortcut}` };
    }),
    { id: "p", label: "P", shortcut: "p", open: "<p>", close: "</p>", title: "Alt+P / p" },
    { id: "div", label: "DIV", shortcut: "d", open: "<div>", close: "</div>", title: "Alt+D / d" },
    { id: "span", label: "SPAN", shortcut: "s", open: "<span>", close: "</span>", title: "Alt+S / s" },
    { id: "aside", label: "ASIDE", shortcut: "aside", open: "<aside>", close: "</aside>", title: "Aside" },
    { id: "sup", label: "SUP", shortcut: "sup", open: "<sup>", close: "</sup>", title: "Insert Superscript" },
    { id: "sub", label: "SUB", shortcut: "sub", open: "<sub>", close: "</sub>", title: "Insert Subscript" },
    { id: "u", label: "U", open: "<u>", shortcut: "u", close: "</u>", title: "Insert Underline" }
  ];
  const attrs = [
    { id: "idAttr", label: "ID=", text: " id=\"\"", cursorOffset: 5, title: "Insert id attribute" },
    { id: "classAttr", label: "CLASS=", text: " class=\"\"", cursorOffset: 8, title: "Insert class attribute" },
    { id: "styleAttr", label: "STYLE=", text: " style=\"\"", cursorOffset: 8, title: "Insert style attribute" },
    { id: "hrs", label: "HRS", shortcut: 'h', text: "<hr style=\"width: 20%;\">", cursorOffset: 22, title: "Insert short hardline" },
    { id: "noIndentAttr", label: "NO INDENT", shortcut: '0', text: " style=\"text-indent: 0;\"", cursorOffset: 23, title: "Insert no-indent style attribute" },
    { id: "HR", label: "HR", text: "<hr>", cursorOffset: 3, title: "Insert hardline" },
    { id: "BR", label: "BR", shortcut: 'enter', text: "<br>", cursorOffset: 3, title: "Insert change line" },
    { id: "SUPdSUB", label: "SUP/SUB", text: "<sup></sup>/<sub></sub>", cursorOffset: 5, title: "Insert division" }
  ];
  const tagMap = new Map([
    ...tags
      .filter(tag => tag.shortcut)
      .map(tag => [tag.shortcut.toLowerCase(), tag]),
    ...attrs
      .filter(attr => attr.shortcut)
      .map(attr => [attr.shortcut.toLowerCase(), attr])
  ]);
  function tagForKeyEvent(event) {
    // Leave Alt+numpad available for Windows character-code input.
    if (event.altKey && (event.location === 3 || event.code?.startsWith("Numpad"))) return;
    return tagMap.get(event.key.toLowerCase());
  }
  const blockTagNames = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const blockTagIds = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);
  const inlineTagIds = new Set(["i", "b", "u", "em", "span"])
  const DocumentModel = (typeof module === "object" && module.exports ? require("./editor-core.js") : window.MewEditorCore)?.DocumentModel;

  class TagEditor {
    constructor(editor) {
      this.editor = editor.editor || editor;
      this.document = this.editor.document || new DocumentModel({ text: this.editor.getValue() });
    }

    buildTagEdit(start, end, tag) {
      const { source: text, tags: { pairs, byStart } } = this.document.parse();
      // Keep the selected line ending outside the edit, including both bytes of CRLF.
      const newline = text.slice(start, end).match(/\r?\n$/)?.[0] || "";
      end -= newline.length;
      const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const nextLine = text.indexOf("\n", end);
      const lineEnd = nextLine < 0 ? text.length : nextLine;
      const wholeLine = start < end && !/\S/.test(text.slice(lineStart, start)) &&
        !/\S/.test(text.slice(end, lineEnd)) && !/[\r\n]/.test(text.slice(start, end));
      // A line selection may include indentation, trailing spaces and the next line's column 1.
      if (wholeLine) {
        const selected = text.slice(start, end), content = selected.trim();
        if (content) { start += selected.indexOf(content); end = start + content.length; }
      }
      const selected = text.slice(start, end);
      const name = /^<([A-Za-z][\w:-]*)\b/.exec(tag.open)?.[1].toLowerCase();
      const simple = name && tag.close.toLowerCase() === `</${name}>`;
      let cursor = start, found = false, block, same;
      while (cursor < end) {
        if (/\s/.test(text[cursor])) { cursor++; continue; }
        const pair = byStart.get(cursor);
        if (!pair || pair.end > end) break;
        found = true; cursor = pair.end;
      }
      const complete = found && cursor === end;
      const exact = complete && byStart.get(start)?.end === end && byStart.get(start);
      if (!complete) for (const pair of pairs) {
        if (!((start === end && pair.start < start && start < pair.openEnd) ||
          (pair.openEnd <= start && end <= pair.closeStart))) continue;
        if (blockTagIds.has(tag.id) && blockTagNames.has(pair.name) &&
          (!block || pair.end - pair.start < block.end - block.start)) block = pair;
        if (simple && pair.name === name && (!same || pair.end - pair.start < same.end - same.start)) same = pair;
      }
      const mismatched = exact && exact.closeName && exact.closeName !== exact.name;
      const isBlock = exact && blockTagNames.has(exact.name);
      const replaceBlock = isBlock && blockTagIds.has(tag.id) && (exact.id === tag.id || tag.id !== "div");
      const inlineInsert = isBlock && inlineTagIds.has(tag.id);
      const wrapper = exact ? (mismatched || replaceBlock || (simple && exact.name === name) || inlineInsert) && exact : block || same;
      if (wrapper) {
        const remove = mismatched ? name === wrapper.name : (replaceBlock || block) ? wrapper.id === tag.id : true;
        let open = remove ? "" : tag.open, close = remove ? "" : tag.close;
        const inner = text.slice(wrapper.openEnd, wrapper.closeStart);
        const inOpening = start === end && start < wrapper.openEnd;
        if (inlineInsert) {
          open = text.slice(start, wrapper.openEnd) + tag.open;
          close = tag.close + text.slice(wrapper.closeStart, byStart.get(start).end);
        }
        return { start: wrapper.start, end: wrapper.end, text: open + inner + close,
          selectStart: open.length + (exact || inOpening ? 0 : start - wrapper.openEnd),
          selectEnd: open.length + (exact ? inner.length : inOpening ? 0 : end - wrapper.openEnd) };
      }
      if (complete && tag.close && selected.startsWith(tag.open) && selected.endsWith(tag.close)) {
        const inner = selected.slice(tag.open.length, -tag.close.length);
        return { start, end, text: inner, selectStart: 0, selectEnd: inner.length };
      }
      const before = start - tag.open.length, after = end + tag.close.length;
      if (!complete && tag.close && before >= 0 && text.slice(before, start) === tag.open && text.slice(end, after) === tag.close) {
        return { start: before, end: after, text: selected, selectStart: 0, selectEnd: selected.length };
      }
      const replacement = tag.open + selected + tag.close, emptyAttribute = tag.open.indexOf('=""');
      cursor = emptyAttribute >= 0 ? emptyAttribute + 2 : selected ? replacement.length : tag.open.length;
      return { start, end, text: replacement, selectStart: complete ? tag.open.length : cursor,
        selectEnd: complete ? tag.open.length + selected.length : cursor };
    }

    applyTag(item) {
      const editor = this.editor;
      const tag = item.open !== undefined ? item : null;
      if (editor.getModel && !editor.getModel()) return;
      const text = editor.getValue(), selections = editor.selections?.() || (editor.getSelections() || []).map(selection => ({
        start: editor.getModel().getOffsetAt(selection.getStartPosition()), end: editor.getModel().getOffsetAt(selection.getEndPosition())
      }));
      if (tag) this.document.update(text);
      const source = tag ? "mew.tag" : "mew.attr";
      const operations = selections.map(({ start, end }) => tag ? this.buildTagEdit(start, end, tag) : {
        start, end, text: item.text, selectStart: item.cursorOffset ?? item.text.length,
        selectEnd: item.cursorOffset ?? item.text.length
      });
      let changes, cursors;
      if (operations.length === 1) {
        const op = operations[0];
        changes = [{ start: op.start, end: op.end, text: op.text }];
        cursors = [{ start: op.start + op.selectStart, end: op.start + op.selectEnd }];
      } else {
        const edits = new Map(), targets = [];
        for (const operation of operations) {
          const pair = tag && this.document.parse().tags.byStart.get(operation.start);
          const inner = pair && text.slice(pair.openEnd, pair.closeStart);
          const inline = pair && blockTagNames.has(pair.name) && inlineTagIds.has(tag?.id) &&
            operation.text === text.slice(pair.start, pair.openEnd) + tag.open + inner + tag.close + text.slice(pair.closeStart, pair.end);
          const opening = inline ? text.slice(pair.start, pair.openEnd) + tag.open : tag?.open || "";
          const closing = inline ? tag.close + text.slice(pair.closeStart, pair.end) : tag?.close || "";
          // Split wrapper changes so shared/nested multi-cursor edits preserve the inner text.
          if (pair?.end === operation.end && (operation.text === inner || operation.text === opening + inner + closing)) {
            const remove = operation.text === inner;
            edits.set(`${pair.start}:${pair.openEnd}`, { start: pair.start, end: pair.openEnd, text: remove ? "" : opening });
            edits.set(`${pair.closeStart}:${pair.end}`, { start: pair.closeStart, end: pair.end, text: remove ? "" : closing });
            targets.push({ start: pair.openEnd + operation.selectStart - (remove ? 0 : opening.length),
              end: pair.openEnd + operation.selectEnd - (remove ? 0 : opening.length) });
          } else {
            const key = `${operation.start}:${operation.end}`;
            if (!edits.has(key)) edits.set(key, operation);
            targets.push({ operation: edits.get(key) });
          }
        }
        changes = [...edits.values()].sort((a, b) => a.start - b.start || a.end - b.end);
        const offset = (position, own) => position + changes.reduce((shift, edit) =>
          shift + (edit !== own && edit.end <= position ? edit.text.length - (edit.end - edit.start) : 0), 0);
        cursors = targets.map(({ operation: op, start, end }) => op ? {
          start: offset(op.start, op) + op.selectStart, end: offset(op.start, op) + op.selectEnd
        } : { start: offset(start), end: offset(end) });
      }
      if (editor.replaceRanges) return Promise.resolve(editor.replaceRanges(changes, cursors, source)).then(async applied => {
        if (applied === false) return;
        await editor.focus();
        return operations[0];
      });
      const Selection = editor.getSelection().constructor;
      const range = (start, end) => {
        const a = editor.getModel().getPositionAt(start), b = editor.getModel().getPositionAt(end);
        return new Selection(a.lineNumber, a.column, b.lineNumber, b.column);
      };
      const select = () => cursors.map(({ start, end }) => range(start, end));
      if (editor.document?.applyEdits) editor.document.applyEdits(changes, { editor, origin: source, selections: select });
      else {
        if (editor.getRawOptions().readOnly) throw new Error('当前文件只读');
        editor.pushUndoStop();
        const applied = editor.executeEdits(source, changes.map(edit => ({ range: range(edit.start, edit.end), text: edit.text, forceMoveMarkers: true })), select);
        editor.pushUndoStop();
        if (applied === false) throw new Error('编辑器未能应用替换');
      }
      if (operations.length === 1 && tag) editor.revealRangeInCenterIfOutsideViewport(editor.getSelection());
      editor.focus();
      return operations[0];
    }
  }

  const MIN_SCALE = .8, MAX_SCALE = 1.6, SNAP = 56;
  const DOCKS = [
    ["editor-top", "栏上", "停靠编辑框上方（与编辑框等宽）"],
    ["editor-bottom", "栏下", "停靠编辑框下方（与编辑框等宽）"],
    ["window-top", "窗上", "停靠窗口顶部（与窗口等宽）"],
    ["window-bottom", "窗下", "停靠窗口底部（与窗口等宽）"],
    ["floating", "浮动", "自由浮动（可拖动、可拉伸）"]
  ];
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
  const makeButton = (label, title, className, data = {}) => {
    const result = node("button", className, label);
    Object.assign(result, { type: "button", title });
    Object.assign(result.dataset, data);
    result.setAttribute("aria-label", title);
    return result;
  };

  function mount(options = {}) {
    const content = typeof options.content === "string" ? document.querySelector(options.content) : options.content;
    const host = typeof options.host === "string" ? document.querySelector(options.host) : options.host;
    if (!content || !host || content.closest(".float-panel")) return null;
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(options.storageKey) || "{}") || {}; } catch {}
    const oldPanel = stored.tagBar || stored.tagPanel || stored;
    const state = Object.assign({ dock: "editor-top", x: 60, y: 96, w: 520, scale: 1 }, oldPanel);
    delete state.h; // Ignore heights saved before automatic content sizing.
    if (state.dock === "top") state.dock = "editor-top";
    if (state.dock === "bottom") state.dock = "editor-bottom";
    if (!DOCKS.some(item => item[0] === state.dock)) state.dock = "editor-top";
    state.scale = clamp(Number(state.scale) || Number(options.initialTagScale) || 1, MIN_SCALE, MAX_SCALE);
    let editorScale = clamp(Number(stored.editorScale ?? stored._editorScale) || Number(options.initialEditorScale) || 1, MIN_SCALE, MAX_SCALE);

    const panel = node("div", "float-panel");
    panel.id = options.panelId || "tagPanel";
    panel.dataset.panel = content.id || "tagBar";
    const header = node("div", "fp-header");
    header.id = options.gripId || "tagPanelGrip";
    header.title = "编辑按钮：按住标题栏拖动可自由浮动，拖到窗口上/下边缘可停靠，双击恢复默认";
    const title = node("strong", "fp-title", options.title || "编辑按钮");
    title.id = options.titleId || "tagPanelTitle";
    const actions = node("span", "fp-actions");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "编辑按钮与编辑框尺寸及停靠位置");
    header.append(node("span", "fp-grip", "≡"), title);
    const hideButton = makeButton("×", "隐藏标签编辑框（Ctrl+Alt+M 重新打开）", "fp-hide");
    header.append(hideButton);
    hideButton.addEventListener("click", () => setVisible(false));
    content.classList.add("tag-bar");
    content.parentNode.insertBefore(panel, content);
    panel.append(header, content, actions);

    const makeScale = (target, label) => {
      const group = node("span", "fp-scale-actions");
      group.dataset.scaleTarget = target;
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", `${label}缩放`);
      const input = node("input", "fp-scale-input");
      Object.assign(input, { type: "text", inputMode: "decimal", maxLength: 5, value: "100%", title: `${label}缩放比例：输入 80%–160% 后按回车；双击恢复 100%` });
      input.dataset.scaleInput = target;
      input.setAttribute("aria-label", `${label}缩放比例`);
      group.append(node("span", "fp-scale-label", target === "editor" ? "编辑" : "标签"), makeButton("−", `缩小${label}（Ctrl+−）`, "fp-scale-control", { scaleAction: "smaller" }), input, makeButton("＋", `放大${label}（Ctrl+＋）`, "fp-scale-control", { scaleAction: "larger" }));
      return group;
    };
    actions.append(makeScale("editor", "编辑框"), makeScale("tag", "标签按钮"));
    for (const [dock, label, tip] of DOCKS) actions.append(makeButton(label, tip, "fp-dock", { dock }));
    for (const dir of ["e", "w"]) {
      const handle = node("div", `fp-handle fp-handle-${dir}`);
      handle.dataset.dir = dir;
      panel.append(handle);
    }
    const snapTop = node("div", "fp-snap fp-snap-top"), snapBottom = node("div", "fp-snap fp-snap-bottom");
    document.body.append(snapTop, snapBottom);

    const chromeHeights = () => ({
      header: Math.round(document.querySelector(options.headerSelector || "header")?.getBoundingClientRect().height || 0),
      footer: Math.round(document.querySelector(options.footerSelector || "footer")?.getBoundingClientRect().height || 0)
    });
    const save = () => {
      try { localStorage.setItem(options.storageKey, JSON.stringify({ dock: state.dock, x: Math.round(state.x), y: Math.round(state.y), w: Math.round(state.w), scale: state.scale, editorScale })); } catch {}
    };
    const updateScale = target => {
      const value = target === "editor" ? editorScale : state.scale;
      const input = actions.querySelector(`[data-scale-input="${target}"]`);
      input.value = `${Math.round(value * 100)}%`;
      const group = input.closest(".fp-scale-actions");
      group.querySelector('[data-scale-action="smaller"]').disabled = value <= MIN_SCALE;
      group.querySelector('[data-scale-action="larger"]').disabled = value >= MAX_SCALE;
      if (target === "editor") options.setEditorScale?.(editorScale);
      else {
        panel.style.setProperty("--fp-scale", state.scale);

      }
    };
    const updateWindowDock = () => {
      const chrome = chromeHeights();
      const height = state.dock.startsWith("window-") ? Math.round(panel.getBoundingClientRect().height) : 0;
      const top = state.dock === "window-top" ? height : 0, bottom = state.dock === "window-bottom" ? height : 0;
      if (top) panel.style.top = `${chrome.header}px`;
      if (bottom) panel.style.bottom = `${chrome.footer}px`;
      document.documentElement.style.setProperty("--window-dock-top", `${top}px`);
      document.documentElement.style.setProperty("--window-dock-bottom", `${bottom}px`);
      snapTop.style.top = `${chrome.header + top}px`;
      snapBottom.style.bottom = `${chrome.footer + bottom}px`;
      options.onLayout?.();
    };
    const clampFloating = () => {
      if (state.dock !== "floating") return;
      const chrome = chromeHeights();
      state.w = clamp(state.w, 220, innerWidth);
      panel.style.width = `${state.w}px`;
      const height = panel.getBoundingClientRect().height;
      state.x = options.keepFloatingInViewport
        ? clamp(state.x, 0, innerWidth - state.w)
        : clamp(state.x, 36 - state.w, innerWidth - 36);
      state.y = clamp(state.y, chrome.header, innerHeight - chrome.footer - (options.keepFloatingInViewport ? height : 28));
      Object.assign(panel.style, { left: `${state.x}px`, top: `${state.y}px`, width: `${state.w}px` });
    };
    const apply = () => {
      panel.className = `float-panel auto-height ${state.dock === "floating" ? "floating" : `dock-${state.dock}`}`;
      host.classList.toggle("bar-bottom", !panel.hidden && state.dock === "editor-bottom");
      host.classList.toggle("bar-fixed", panel.hidden || state.dock.startsWith("window-") || state.dock === "floating");
      panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = panel.style.width = "";
      updateScale("tag");
      clampFloating();
      panel.querySelectorAll(".fp-dock").forEach(button => {
        const active = button.dataset.dock === state.dock;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      requestAnimationFrame(updateWindowDock);
    };
    const floatPanel = () => {
      if (state.dock === "floating") return;
      const rect = panel.getBoundingClientRect();
      Object.assign(state, { dock: "floating", x: rect.left, y: rect.top, w: Math.min(620, rect.width) });
    };
    const setDock = dock => { if (dock === "floating") floatPanel(); state.dock = DOCKS.some(item => item[0] === dock) ? dock : "editor-top"; apply(); save(); };
    const track = (move, finish) => {
      const clean = () => { document.body.classList.remove("panel-dragging"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", clean); };
      const up = () => { clean(); finish(); };
      document.body.classList.add("panel-dragging");
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true }); window.addEventListener("pointercancel", clean, { once: true });
    };
    header.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest(".fp-actions,button")) return;
      event.preventDefault(); floatPanel(); apply();
      const offsetX = event.clientX - state.x, offsetY = event.clientY - state.y;
      let snap = null;
      const move = ev => {
        const chrome = chromeHeights();
        state.x = clamp(ev.clientX - offsetX, 36 - panel.offsetWidth, innerWidth - 36);
        state.y = clamp(ev.clientY - offsetY, chrome.header, innerHeight - chrome.footer - 28);
        Object.assign(panel.style, { left: `${state.x}px`, top: `${state.y}px` });
        snap = ev.clientY < chrome.header + SNAP + 6 ? "top" : ev.clientY > innerHeight - chrome.footer - SNAP - 6 ? "bottom" : null;
        snapTop.classList.toggle("active", snap === "top"); snapBottom.classList.toggle("active", snap === "bottom");
      };
      track(move, () => { snapTop.classList.remove("active"); snapBottom.classList.remove("active"); if (snap) setDock(`window-${snap}`); else save(); });
    });
    for (const handle of panel.querySelectorAll(".fp-handle")) handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const dir = handle.dataset.dir, rect = panel.getBoundingClientRect(), startX = event.clientX;
      const move = ev => {
        const dx = ev.clientX - startX;
        state.w = dir === "e" ? clamp(rect.width + dx, 220, innerWidth - rect.left)
          : clamp(rect.width - dx, 220, rect.right);
        state.x = dir === "w" ? rect.right - state.w : rect.left;
        clampFloating(); updateWindowDock();
      };
      track(move, save);
    });
    const setScale = (target, value) => {
      value = Math.round(clamp(value, MIN_SCALE, MAX_SCALE) * 100) / 100;
      if (target === "editor") editorScale = value; else state.scale = value;
      updateScale(target); updateWindowDock(); save();
      options.onScaleChange?.({ [`${target}Scale`]: value });
    };
    actions.addEventListener("click", event => {
      const scaleButton = event.target.closest("[data-scale-action]");
      if (scaleButton) {
        const target = scaleButton.closest("[data-scale-target]").dataset.scaleTarget;
        setScale(target, (target === "editor" ? editorScale : state.scale) + (scaleButton.dataset.scaleAction === "larger" ? .1 : -.1));
      }
      const dockButton = event.target.closest(".fp-dock");
      if (dockButton) setDock(dockButton.dataset.dock);
    });
    for (const input of actions.querySelectorAll("[data-scale-input]")) {
      const restore = () => updateScale(input.dataset.scaleInput);
      const commit = () => { const match = input.value.trim().match(/^(\d+(?:\.\d+)?)\s*%?$/); const percent = match ? Number(match[1]) : NaN; if (percent >= 80 && percent <= 160) setScale(input.dataset.scaleInput, percent / 100); else restore(); };
      input.addEventListener("focus", () => input.select()); input.addEventListener("change", commit);
      input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); commit(); input.select(); } else if (event.key === "Escape") { event.preventDefault(); restore(); input.blur(); } });
      input.addEventListener("dblclick", () => { setScale(input.dataset.scaleInput, 1); input.select(); });
    }
    header.addEventListener("dblclick", event => { if (event.target.closest(".fp-actions,button")) return; Object.assign(state, { dock: "editor-top", x: 60, y: 96, w: 520 }); apply(); save(); });
    let lastScaleTarget = "editor";
    actions.addEventListener("pointerdown", event => { const group = event.target.closest("[data-scale-target]"); if (group) lastScaleTarget = group.dataset.scaleTarget; }, true);
    const bindShortcuts = (targetDocument, fixedTarget = null) => {
      const shortcut = event => {
        if (!event.isComposing && event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && event.code === "KeyM") {
          event.preventDefault(); event.stopPropagation(); setVisible(panel.hidden); return;
        }
        const wheel = event.type === "wheel";
        if (!(event.ctrlKey || event.metaKey) || (!wheel && event.altKey)) return;
        const direction = wheel ? (event.deltaY < 0 ? 1 : -1) : ["Equal", "NumpadAdd"].includes(event.code) || event.key === "+" ? 1 : ["Minus", "NumpadSubtract"].includes(event.code) || event.key === "-" ? -1 : 0;
        if (!direction) return;
        const target = fixedTarget || (event.target.closest?.(".float-panel") ? "tag" : event.target.closest?.(options.editorSelector || "#monacoEditor,#visualEditor") ? "editor" : wheel ? null : lastScaleTarget);
        if (!target) return;
        lastScaleTarget = target; event.preventDefault(); if (!wheel) event.stopPropagation(); setScale(target, (target === "editor" ? editorScale : state.scale) + direction * .1);
      };
      targetDocument.addEventListener("wheel", shortcut, { capture: true, passive: false });
      targetDocument.addEventListener("keydown", shortcut, true);
    };
    bindShortcuts(document);
    if (options.editorReadyEvent) window.addEventListener(options.editorReadyEvent, event => {
      if (event.detail?.document) bindShortcuts(event.detail.document, "editor");
    });
    updateScale("editor"); apply();
    new ResizeObserver(() => {
      clampFloating();
      updateWindowDock();
    }).observe(panel);
    window.addEventListener("resize", () => { clampFloating(); updateWindowDock(); });
    window.addEventListener(options.chromeResizeEvent || "reader-chrome-resize", updateWindowDock);
    for (const eventName of options.layoutEvents || []) window.addEventListener(eventName, updateWindowDock);
    window.addEventListener("mew-tag-panel-reset", () => { editorScale = 1; Object.assign(state, { dock: "editor-top", x: 60, y: 96, w: 520, scale: 1 }); updateScale("editor"); apply(); save(); options.onScaleChange?.({ editorScale, tagScale: state.scale }); });
    const toggle = document.getElementById("tagPanelToggle");
    if (toggle) {
      toggle.title = panel.hidden ? "打开标签编辑框（Ctrl+Alt+M）" : "隐藏标签编辑框（Ctrl+Alt+M）";
      toggle.setAttribute("aria-keyshortcuts", "Control+Alt+M");
    }
    const setVisible = visible => {
      panel.hidden = !visible;
      host.classList.toggle("bar-bottom", visible && state.dock === "editor-bottom");
      host.classList.toggle("bar-fixed", !visible || state.dock.startsWith("window-") || state.dock === "floating");
      if (toggle) {
        toggle.textContent = `${visible ? "隐藏" : "打开"}标签编辑框`;
        toggle.setAttribute("aria-expanded", String(visible));
      }
      updateWindowDock();
    };
    toggle?.addEventListener("click", () => setVisible(panel.hidden));
    const boundEditors = new WeakSet();
    const bindMenu = editor => {
      if (boundEditors.has(editor)) return;
      boundEditors.add(editor);
      const actions = [editor.addAction({
        id: "mew.tag-panel.visible", label: "显示／隐藏标签面板",
        contextMenuGroupId: "mew.tag-panel.settings", contextMenuOrder: 1,
        run: () => setVisible(panel.hidden)
      }), ...DOCKS.map(([dock, , tip], index) => editor.addAction({
        id: `mew.tag-panel.dock.${dock}`, label: `标签面板：${tip}`,
        contextMenuGroupId: "mew.tag-panel.settings", contextMenuOrder: index + 2,
        run: () => { setVisible(true); setDock(dock); }
      }))];
      const subscription = editor.onDidDispose(() => {
        actions.forEach(action => action.dispose());
        subscription.dispose();
      });
    };
    window.addEventListener("mew-monaco-ready", event => bindMenu(event.detail.editor));
    for (const editor of window.monaco?.editor.getEditors() || []) bindMenu(editor);
    return { panel, setDock, setScale, setVisible, state,
      restoreScales(settings) {
        for (const target of ["editor", "tag"]) {
          const scale = settings[`${target}Scale`];
          setScale(target, typeof scale === "number" && Number.isFinite(scale) ? scale : 1);
        }
      }
    };
  }
  function renderBar(webview, { scriptUri, floating = false }) {
    const nonce = String(Date.now());
    return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>MEW Tags</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        padding: 6px;
        color: var(--vscode-foreground);
        background: var(--vscode-panel-background, var(--vscode-editor-background));
        font: 12px var(--vscode-font-family);
        overflow: auto;
      }
      .bar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
      }
      button {
        min-width: 30px;
        height: 24px;
        padding: 0 7px;
        border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
        border-radius: 4px;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        font: 600 11px var(--vscode-font-family);
        cursor: pointer;
      }
      button:hover { background: var(--vscode-button-hoverBackground); }
      button.attr {
        color: var(--vscode-editor-foreground);
        background: var(--vscode-input-background);
      }
    </style>
  </head>
  <body>
    <div class="bar">
    </div>
    <script nonce="${nonce}" src="${escapeHtml(scriptUri)}" data-mew-tag-bar data-floating="${floating}"></script>
  </body>
  </html>`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[ch]);
  }

  class TagBarViewProvider {
    constructor(context, host) {
      this.host = host;
      this.editors = new WeakMap();
      this.context = context;
      this.panels = new Set();
      this.setFloating(this.findFloating() !== undefined);
      context.subscriptions.push({ dispose: () => { for (const panel of this.panels) panel.dispose(); } });
    }
    start() {
      const { vscode } = this.host;
      const { subscriptions } = this.context;
      subscriptions.push(
        vscode.window.registerWebviewPanelSerializer("mewReader.floatingBar", this),
        vscode.window.registerWebviewViewProvider("mewReader.bar", this, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand("mewReader.showBar", () => this.show()),
        vscode.commands.registerCommand("mewReader.openFloatingBar", () => this.openFloating()));
      for (const tag of [...tags, ...attrs]) {
        subscriptions.push(vscode.commands.registerCommand(`mewReader.insert.${tag.id}`, () => this.insertTag(tag)));
      }
    }
    findFloating() {
      const { vscode } = this.host;
      for (const group of vscode.window.tabGroups?.all || []) {
        const tab = group.tabs.find(tab => ["mewReader.floatingBar", "mainThreadWebview-mewReader.floatingBar"].includes(tab.input?.viewType));
        if (tab) return { group, tab };
      }
    }
    setFloating(value) {
      const { vscode } = this.host;
      return vscode.commands.executeCommand("setContext", "mewReader.floating", value);
    }
    async show() {
      if (this.panels.size || this.findFloating()) return this.openFloating();
      return this.showDockedView();
    }
    configure(webview, floating) {
      const { vscode, report } = this.host;
      webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
      webview.onDidReceiveMessage(message => this.handleMessage(message).catch(report), null, this.context.subscriptions);
      webview.html = renderBar(webview, { floating, scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "tag-panel.js")).toString() });
    }
    resolveWebviewView(view) {
      this.configure(view.webview, false);
    }
    attachPanel(panel) {
      if (this.panels.has(panel)) return;
      this.panels.add(panel);
      this.setFloating(true);
      panel.title = "MEW 标签插入栏";
      panel.onDidDispose(() => {
        this.panels.delete(panel);
        if (!this.panels.size) this.setFloating(false);
      }, null, this.context.subscriptions);
      this.configure(panel.webview, true);
    }
    async deserializeWebviewPanel(panel) {
      this.attachPanel(panel);
    }
    async openFloating() {
      if (this.opening) return this.opening;
      this.opening = this.revealFloating();
      try { await this.opening; } finally { this.opening = null; }
    }
    async revealFloating() {
      const { vscode, revealReaderTab } = this.host;
      const existing = this.panels.values().next().value;
      if (existing) {
        existing.reveal(existing.viewColumn, false);
        await this.host.focusReaderWindow();
        return;
      }
      const restored = this.findFloating();
      if (restored) {
        if (await revealReaderTab(restored)) await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
        return;
      }
      const panel = vscode.window.createWebviewPanel("mewReader.floatingBar", "MEW 标签插入栏",
        vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.attachPanel(panel);
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
      await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
    }
    async showDocked() {
      const { vscode } = this.host;
      for (const panel of [...this.panels]) panel.dispose();
      for (const group of vscode.window.tabGroups?.all || []) {
        const tabs = group.tabs.filter(tab => ["mewReader.floatingBar", "mainThreadWebview-mewReader.floatingBar"].includes(tab.input?.viewType));
        if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
      }
      await this.setFloating(false);
      await this.showDockedView();
    }
    async handleMessage(message) {
      const { openSiblingFile } = this.host;
      if (!message || typeof message !== "object") return;
      if (message.type === "insertTag" || message.type === "insertAttr") {
        const item = (message.type === "insertTag" ? tags : attrs).find(item => item.id === message.id);
        if (item) return this.insertTag(item);
      }
      if (message.type === "openFloatingBar") return this.openFloating();
      if (message.type === "showDockedBar") return this.showDocked();
      if (message.type === "openPreviousFile") return openSiblingFile(-1);
      if (message.type === "openNextFile") return openSiblingFile(1);
    }
    showDockedView() {
      return this.host.vscode.commands.executeCommand("mewReader.bar.focus");
    }
    async insertTag(item) {
      const { vscode, targetEditor } = this.host;
      const editor = targetEditor();
      if (!editor) return vscode.window.showInformationMessage("Open a text editor before inserting MEW tags or attributes.");
      let engine = this.editors.get(editor);
      if (!engine) {
        const adapter = {
          getValue: () => editor.document.getText(),
          selections: () => editor.selections.map(selection => ({
            start: editor.document.offsetAt(selection.start), end: editor.document.offsetAt(selection.end)
          })),
          async replaceRanges(changes, selections) {
            // Reject conflicting ranges as a unit; never silently discard a cursor's edit.
            const ordered = [...changes].sort((a, b) => a.start - b.start || a.end - b.end);
            if (ordered.some((edit, index) => index && edit.start < ordered[index - 1].end)) {
              vscode.window.showInformationMessage("标签替换范围重叠，请调整选区后重试。");
              return false;
            }
            const document = editor.document;
            const applied = await editor.edit(builder => {
              for (const edit of ordered) builder.replace(
                new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
            });
            if (!applied || document.isClosed) return false;
            editor.selections = selections.map(selection => new vscode.Selection(
              document.positionAt(selection.start), document.positionAt(selection.end)));
            editor.revealRange?.(editor.selection, vscode.TextEditorRevealType?.InCenterIfOutsideViewport);
            return true;
          },
          focus: () => vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: true })
        };
        engine = new TagEditor(adapter);
        this.editors.set(editor, engine);
      }
      return engine.applyTag(item);
    }
  }
  function mountWebview(api, floating = false) {
    const bar = document.querySelector(".bar");
    if (!bar) return;
    if (floating) api.setState({ ...api.getState(), floating: true });
    const button = (type, item, attr = false) => {
      const element = makeButton(item.label, item.title, attr ? "attr" : "", { type, id: item.id || type });
      bar.append(element);
    };
    tags.forEach(item => button("insertTag", item));
    attrs.forEach(item => button("insertAttr", item, true));
    button("openPreviousFile", { label: "←", title: "Open Previous File in Folder" }, true);
    button("openNextFile", { label: "→", title: "Open Next File in Folder" }, true);
    button(floating ? "showDockedBar" : "openFloatingBar", {
      label: floating ? "返回标签栏 ↙" : "另窗打开 ↗",
      title: floating ? "关闭独立窗口，返回原停靠位置" : "在独立窗口打开标签栏；可在窗口标题栏开启置顶"
    }, true);
    bar.addEventListener("click", event => {
      const element = event.target.closest("button[data-type]");
      if (element) api.postMessage({ type: element.dataset.type, id: element.dataset.id });
    });
  }
  const api = { mount, tags, attrs, tagMap, tagForKeyEvent, blockTagNames, TagEditor, renderBar, mountWebview, TagBarViewProvider };
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    window.MewTagPanel = api;
    const script = typeof document === "object" ? document.currentScript : null;
    if (script?.hasAttribute("data-mew-tag-bar")) mountWebview(acquireVsCodeApi(), script.dataset.floating === "true");
  }
})();
