// The same VS Code module owns native source access and PDF-side selection.
if (typeof module === 'object' && module.exports) {
  const vscode = require('vscode');
  const { sameUri, reviewSourceSnapshot, reviewDecorationGroups } = require('../reader-core.cjs');
  module.exports.attach = (reader, panel) => {
    const subscriptions = [], decorations = new Map();
    let disposed = false, previous = null, signature = '', lastChange = null;
    const range = value => new vscode.Range(value.startLineNumber - 1, value.startColumn - 1,
      value.endLineNumber - 1, value.endColumn - 1);
    const editors = () => (vscode.window.visibleTextEditors || []).filter(editor => sameUri(editor.document.uri, reader.current?.uri));
    function clear() {
      for (const type of decorations.values()) type.dispose();
      decorations.clear();
    }
    async function snapshot() {
      const current = reader.current;
      if (!current || !sameUri(current.volume.pdfUri, reader.panelPdfUri)) return { uri: null, text: '', readOnly: true };
      const document = await vscode.workspace.openTextDocument(current.uri);
      if (reader.current !== current || reader.panel !== panel || disposed) return null;
      const visible = editors(), active = vscode.window.activeTextEditor;
      const editor = visible.includes(active) ? active : visible[0], groups = vscode.window.tabGroups?.all || [];
      const html = groups.find(group => group.viewColumn === editor?.viewColumn
        && group.tabs.some(tab => sameUri(tab.input?.uri, current.uri)))
        || groups.find(group => group.tabs.some(tab => sameUri(tab.input?.uri, current.uri)));
      const pdf = groups.find(group => group.tabs.some(tab => tab.input?.viewType === 'mewReader.pdf'
        && sameUri(tab.input.uri, reader.panelPdfUri)));
      const sourceColumn = editor?.viewColumn ?? html?.viewColumn ?? null;
      const pdfColumn = pdf?.viewColumn ?? panel.viewColumn ?? null;
      return { ...reviewSourceSnapshot(document, current, editor?.selections),
        changes: lastChange?.uri === document.uri.toString(true) && lastChange.version === document.version ? lastChange.changes : undefined,
        layout: { sourceViewColumn: sourceColumn, pdfViewColumn: pdfColumn,
          // Columns alone cannot distinguish groups in different windows.
          // Simultaneously visible native editors must be in separate views.
          splitView: editor && panel.visible ? true : html && pdf ? html !== pdf
            : sourceColumn != null && pdfColumn != null ? sourceColumn !== pdfColumn : null } };
    }
    async function publish(userSelection = false) {
      if (disposed || reader.panel !== panel || !reader.ready) return;
      const value = await snapshot();
      if (!value || disposed || reader.panel !== panel) return;
      if (previous?.uri !== value.uri || previous?.version !== value.version) clear();
      previous = value;
      const key = JSON.stringify(value);
      if (key === signature && !userSelection) return;
      signature = key;
      await panel.webview.postMessage({ type: 'reviewSource', snapshot: value, userSelection });
    }
    async function document(message) {
      const current = reader.current;
      if (disposed || reader.panel !== panel || !current || message.uri !== current.uri.toString(true)
        || !sameUri(current.volume.pdfUri, reader.panelPdfUri)) throw new Error('文件已切换，请重新审阅。');
      const document = await vscode.workspace.openTextDocument(current.uri);
      if (disposed || reader.current !== current || reader.panel !== panel || document.version !== message.version)
        throw new Error('原文已变化，请重新审阅。');
      return document;
    }
    const source = { range, editors, snapshot, publish, document,
      async reply(message, result) {
        if (!disposed && reader.panel === panel) await panel.webview.postMessage({ type: 'reviewResult', id: message.id,
          ...result, snapshot: await snapshot() });
      } };
    const changed = () => void publish().catch(reader.report);
    if (panel.onDidChangeViewState) subscriptions.push(panel.onDidChangeViewState(changed));
    subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (!sameUri(event.document.uri, reader.current?.uri)) return;
      if (event.contentChanges.length) lastChange = { uri: event.document.uri.toString(true), version: event.document.version,
        changes: event.contentChanges.map(({ rangeOffset, rangeLength, text }) => ({ rangeOffset, rangeLength, text })) };
      changed();
    }));
    subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
      const kinds = vscode.TextEditorSelectionChangeKind;
      const userSelection = !panel.active && event.textEditor === vscode.window.activeTextEditor
        && sameUri(event.textEditor.document.uri, reader.current?.uri)
        && (event.kind === kinds.Mouse || event.kind === kinds.Keyboard);
      void publish(userSelection).catch(reader.report);
    }));
    for (const [owner, event] of [[vscode.workspace, 'onDidSaveTextDocument'],
      [vscode.window, 'onDidChangeVisibleTextEditors'],
      [vscode.window.tabGroups, 'onDidChangeTabGroups'], [vscode.window.tabGroups, 'onDidChangeTabs']])
      if (owner?.[event]) subscriptions.push(owner[event](changed));
    subscriptions.push(panel.webview.onDidReceiveMessage(message => {
      if (!['reviewSelection', 'reviewFocus', 'reviewDecorations'].includes(message?.type)) return;
      const focusRevision = message.type === 'reviewFocus' ? ++reader.focusRevision : reader.focusRevision;
      void (async () => {
        const doc = await document(message);
        if (message.type === 'reviewFocus') {
          const column = editors()[0]?.viewColumn ?? (await snapshot())?.layout?.sourceViewColumn ?? vscode.ViewColumn.Active;
          if (disposed || reader.panel !== panel || focusRevision !== reader.focusRevision) return;
          return vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false, preview: false });
        }
        if (message.type === 'reviewSelection') {
          for (const editor of editors()) {
            const selections = message.selections.map(value => new vscode.Selection(
              new vscode.Position((value.selectionStartLineNumber ?? value.startLineNumber) - 1, (value.selectionStartColumn ?? value.startColumn) - 1),
              new vscode.Position((value.positionLineNumber ?? value.endLineNumber) - 1, (value.positionColumn ?? value.endColumn) - 1)));
            if (JSON.stringify(editor.selections) !== JSON.stringify(selections)) editor.selections = selections;
            if (editor.selection) editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          }
          return;
        }
        const groups = reviewDecorationGroups(message.decorations);
        for (const name of groups.keys()) if (name && !decorations.has(name)) {
          const accent = new vscode.ThemeColor(name === 'mew-font-diff-text' ? 'editorWarning.foreground' : 'editorInfo.foreground');
          decorations.set(name, vscode.window.createTextEditorDecorationType(name === 'mew-ocr-diff-insert'
            ? { before: { contentText: '\u200b', border: '1px solid', borderColor: accent } }
            : { backgroundColor: name === 'mew-review-current' ? new vscode.ThemeColor('diffEditor.removedTextBackground')
              : name === 'mew-review-proposed' ? new vscode.ThemeColor('diffEditor.insertedTextBackground')
              : name === 'mew-ocr-diff-text' ? new vscode.ThemeColor('editor.findMatchHighlightBackground') : undefined,
              textDecoration: name === 'mew-review-current' ? 'line-through' : name === 'mew-font-diff-text' ? 'underline wavy' : undefined,
              borderWidth: '0 0 1px 0', borderStyle: 'solid', borderColor: accent }));
        }
        for (const [name, type] of decorations) for (const editor of editors()) editor.setDecorations(type,
          (groups.get(name) || []).map(mark => ({ range: range(mark.range), renderOptions: mark.after?.content ? {
            after: { contentText: mark.after.content, backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground') }
          } : undefined })));
      })().catch(() => publish().catch(reader.report));
    }));
    panel.onDidDispose(() => { disposed = true; subscriptions.forEach(value => value.dispose()); clear(); });
    return source;
  };
} else {
(async () => {
  "use strict";
  if (typeof window === "undefined" || window.PdfSelection) return;
  if (!window.PdfReviewReady) await import('./pdf-review-provider.js');
  const review = await window.PdfReviewReady;
  if (window.PdfSelection) return;
  const options = window.PdfSelectionOptions;
  const cleanup = [], editors = new WeakSet(), selectionDocuments = new WeakSet();
  let selecting = false, pendingDifference = null;
  const layers = new Map();
  const preparationPages = new Set();
  const editIdleDelay = 350;
  let preparationTask = null, lastInteraction = 0, lastIndexYield = 0, lastEdit = -Infinity;
  let activeEditor = null, syncingPdf = false, contexts = [], locationSearch = null, scrolled = false, positioned = false;
  let reviewPointer = null, defaultPointer = null;
  let viewer = null, revision = 0, timer, stopped = false, diffHighlight = true, sourceDiffHighlight = true, selectionHighlight = true;
  let preferenceWrites = Promise.resolve(), selectionRevision = 0, notifiedSelection = -1, interactionId = 0, userSelection = false;
  try {
    const settings = options.settings;
    if (settings) {
      diffHighlight = settings.diffHighlight !== false;
      sourceDiffHighlight = (settings.sourceDiffHighlight ?? settings.diffHighlight) !== false;
      selectionHighlight = settings.selectionHighlight !== false;
      for (const key of ['italic', 'bold']) review.setFontEnabled(settings[`${key}Detection`] !== false, key, false);
      window.ReplacementReview.refreshMenu();
    }
  } catch {}
  const currentEditor = () => activeEditor?.getModel() ? activeEditor : null;
  const sourcePages = () => window.ReaderUI?.getPdfSourcePages?.();
  Object.assign(review.locator.options, options);
  Object.assign(review.locator.environment, {
    document, getPdf: () => viewer?.pdfDocument, getSourcePages: sourcePages,
    getSourceIndex() {
      const editor = currentEditor();
      return editor?.document && review.locator.editorSourceIndex(editor.document);
    },
    getTargets() {
      const pdf = viewer?.pdfDocument, numbers = sourcePages();
      if (!currentEditor()) return [];
      return [...layers.values()].filter(page => page.pdf === pdf && (!numbers || numbers.includes(page.number))
        && page.columnText === review.locator.columnText(pdf, page.number));
    },
    getVisiblePages: (numbers = sourcePages()) => visiblePages().filter(number => !numbers || numbers.includes(number)).map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) })),
    isCurrent: pdf => selectionHighlight && !stopped && viewer?.pdfDocument === pdf,
    async waitForIdle(pdf) {
      while (selectionHighlight && !stopped && viewer?.pdfDocument === pdf
        && (performance.now() - lastInteraction < 100 || performance.now() - lastEdit < editIdleDelay))
        await new Promise(resolve => setTimeout(resolve, 25));
      if (performance.now() - lastIndexYield >= 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        lastIndexYield = performance.now();
      }
    },
    onIndexed: () => queueWarm()
  });
  const status = { state: "waiting-for-pdf", pages: [], matches: 0, differences: [], error: null };
  const api = window.PdfSelection = {
    status, locator: review.locator, attachEditor, attachViewer, savePreference, refresh: publishSources,
    highlight: text => select(Array.isArray(text) ? text : [text]),
    clear: () => select([]),
    showReviewPointer(editor, items, key) {
      if (!selectionHighlight) return;
      if (key && defaultPointer?.key === key && currentPointer(defaultPointer)) return;
      review.highlights.clearHighlights(true);
      if (!key) reviewPointer = null;
      const model = editor?.getModel();
      if (!model || !viewer?.pdfDocument || key && !diffHighlight || !items?.length && !key) return;
      const data = review.locator.reviewLists.get(items);
      // One index owns both the candidate offsets and the rendered page mappings, so a
      // candidate list arriving from the paired window is re-anchored on the PDF side.
      const index = data?.index || review.locator.editorSourceIndex(editor.document);
      const entries = data?.entries || items.map(item => index.candidateEntry(item));
      const pointer = { editor, model, version: model.getVersionId?.(), pdf: viewer?.pdfDocument, entries, key };
      if (key) defaultPointer = pointer;
      else reviewPointer = pointer;
      if (!key && !entries.every(entry => contexts.some(context => context.index === entry.index && context.start <= entry.start && context.end >= entry.end)))
        return select(entries, true);
      schedule();
    },
    clearReviewPointer(editor) {
      if (editor && (reviewPointer || defaultPointer)?.editor !== editor) return;
      review.highlights.clearHighlights(true);
      if (defaultPointer && (stopped || !currentPointer(defaultPointer))) defaultPointer = null;
      reviewPointer = null;
      if (defaultPointer) schedule();
    },
    setDiffHighlight(enabled, side = 'pdf') {
      if (side === 'source') sourceDiffHighlight = !!enabled;
      else {
        diffHighlight = !!enabled;
        defaultPointer = null;
        review.highlights.clearHighlights(true);
        if (reviewPointer) schedule();
      }
      savePreference(side === 'source' ? 'sourceDiffHighlight' : 'diffHighlight', !!enabled, '无法保存差异高亮设置');
      publishSources();
      if (enabled) queueWarm();
      if (diffButton) {
        diffButton.textContent = diffHighlight ? '关闭差异高亮' : '显示差异高亮';
        diffButton.setAttribute('aria-pressed', String(diffHighlight));
      }
    },
    setSelectionHighlight(enabled) {
      selectionHighlight = !!enabled;
      savePreference('selectionHighlight', selectionHighlight, '无法保存选区联动设置');
      clearTimeout(preparationTask);
      preparationTask = null;
      preparationPages.clear();
      resetPdf();
      select([]);
      for (const id of ['pdf-ocr', 'pdf-font', 'pdf-bold']) window.ReplacementReview.invalidate(id);
      if (diffButton) diffButton.disabled = !selectionHighlight;
      window.ReplacementReview.refreshMenu();
      if (selectionHighlight) queueWarm();
    },
    get selectionEnabled() { return selectionHighlight; },
    stop() {
      stopped = true;
      resetPdf();
      clearTimeout(preparationTask);
      cleanup.splice(0).reverse().forEach(dispose => dispose());
      delete window.PdfSelection;
    },
    get viewer() { return viewer; },
    get editor() { return currentEditor(); },
    get enabled() { return diffHighlight; },
    get sourceEnabled() { return sourceDiffHighlight; },
    get interactionId() { return interactionId; }
  };
  function savePreference(key, value, message) {
    preferenceWrites = preferenceWrites.then(async () => {
      await options.savePreference(key, value);
    }).catch(() => window.ReaderUI?.notify(message, true));
  }
  function report(state, detail = {}) {
    Object.assign(status, { state }, detail); window.dispatchEvent(new CustomEvent("pdf-selection-highlight-status", { detail: { ...status } }));
  }
  function listen(target, name, callback, options) {
    target.addEventListener(name, callback, options); cleanup.push(() => target.removeEventListener(name, callback, options));
  }
  const diffButton = document.getElementById('diffHighlightBtn');
  if (diffButton) {
    diffButton.disabled = !selectionHighlight;
    diffButton.textContent = diffHighlight ? '关闭差异高亮' : '显示差异高亮';
    diffButton.setAttribute('aria-pressed', String(diffHighlight));
    listen(diffButton, 'click', () => api.setDiffHighlight(!diffHighlight));
  }
  function clearLayers() { for (const div of layers.keys()) clearLayer(div); }
  function clearLayer(div, records) {
    // PDF.js toggles the text layer's selection classes between pointerdown and pointerup.
    // Keep the marker and its notices available for the click's hit test.
    if (records && !records.some(({ type, target, attributeName, addedNodes, removedNodes }) => type === 'childList'
      ? [...addedNodes, ...removedNodes].some(node => node.textContent)
      : type === 'characterData' || (target !== layers.get(div)?.layer || attributeName !== 'class') && target.textContent)) return false;
    layers.get(div)?.observer.disconnect();
    if (!layers.delete(div)) return false;
    review.highlights.paintHighlight(div, [], options.color);
    review.highlights.paintHighlight(div, [], options.color, true);
    return true;
  }
  function currentPointer(pointer) {
    return pointer.pdf === viewer?.pdfDocument && pointer.editor === currentEditor() && pointer.model === pointer.editor.getModel()
      && pointer.version === pointer.model.getVersionId?.();
  }
  function resetPdf() {
    defaultPointer = null;
    api.clearReviewPointer();
    ++revision;
    clearTimeout(timer);
    review.highlights.clearHighlights();
    clearLayers();
    window.dispatchEvent(new CustomEvent('pdf-selection-reset'));
  }
  function select(entries, plain = false, fromUser = false) {
    if (!selectionHighlight && entries.length) return;
    ++selectionRevision;
    userSelection = fromUser;
    if (entries.length) lastInteraction = performance.now();
    const decode = text => (plain ? String(text || "") : new window.MewEditorCore.DocumentModel({ text: String(text || "") }).parse(document).raw).trim();
    contexts = entries.map(input => {
      const entry = input && typeof input === 'object' ? input : { text: input }, text = entry.text, value = entry.marked ? text : decode(text);
      const start = entry.start + (plain && !entry.marked ? text.length - text.trimStart().length : 0);
      return { text: value, before: decode(entry.before || "").slice(-160),
        after: decode(entry.after || "").slice(0, 160), index: entry.index, start, end: start + value.length,
        marked: entry.marked, difference: entry.difference };
    }).filter(entry => entry.text || entry.marked);
    status.differences = [];
    locationSearch = null;
    scrolled = positioned = false;
    if (!contexts.length) {
      review.highlights.clearHighlights();
      report(viewer ? "idle" : "waiting-for-pdf", { pages: [], matches: 0, mode: null, differences: [], error: null });
    }
    schedule();
    return api;
  }
  function schedule(delay = 0) {
    if (stopped || !selectionHighlight) return;
    ++revision;
    clearTimeout(timer);
    const run = revision;
    const execute = () => Promise.all([refresh(run), refreshReviewPointer()]).catch(error => {
      if (stopped || run !== revision) return;
      report("error", { error: error.message });
      console.error("[PDF selection highlight]", error);
    });
    if (delay === -1) execute();
    else timer = setTimeout(execute, typeof delay === "number" ? delay : 0);
  }
  function attachEditor(editor) {
    editor = editor?.editor || editor;
    const editorApi = editor?.getDomNode?.()?.ownerDocument.defaultView.monaco || window.monaco;
    if (editorApi && editor?.getOption?.(editorApi.editor.EditorOption.inDiffEditor)) return;
    if (!editor?.onDidChangeCursorSelection || editors.has(editor)) return;
    editors.add(editor);
    activeEditor = editor;
    const node = editor.getDomNode?.();
    if (node) {
      trackSelection(node.ownerDocument);
      const interact = () => { lastInteraction = performance.now(); };
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) listen(node, name, interact, { passive: true });
    }
    let readTimer = null;
    cleanup.push(() => clearTimeout(readTimer));
    const read = event => {
      if (syncingPdf) return;
      if (event?.changes || readTimer !== null) {
        if (event?.changes) lastEdit = event.isFlush ? -Infinity : performance.now();
        if (readTimer === null) select([]);
        clearTimeout(readTimer);
        readTimer = setTimeout(() => { readTimer = null; read(); }, Math.max(0, editIdleDelay - (performance.now() - lastEdit)));
        return;
      }
      if (!selectionHighlight) { queueWarm(); return; }
      activeEditor = editor;
      const model = editor.getModel();
      let index;
      const entries = model ? (editor.getSelections() || []).flatMap(range => {
        const selected = review.highlights.selectionRange(editor, event, range), mark = selected?.range;
        range = mark || range;
        const start = model.getOffsetAt(range.getStartPosition()), end = model.getOffsetAt(range.getEndPosition());
        if (!mark && start === end) return [];
        index ||= review.locator.editorSourceIndex(editor.document);
        const a = window.PdfSelectionDiff.lowerBound(index.ends, start + 1), b = window.PdfSelectionDiff.lowerBound(index.starts, end);
        // Each decoration owns its candidate; fragments do not need to rediscover
        // a nearby text candidate and turn a font click into a text review.
        const item = selected?.item;
        return [item ? index.candidateEntry(item) : index.entry(a, b, !!mark)];
      }) : [];
      if (viewer && (!index || index.prepared?.pdf !== viewer.pdfDocument)) queueWarm();
      select(entries, true, event?.userSelection);

    };
    for (const name of ["onDidChangeCursorSelection", "onDidChangeModel", "onDidChangeModelContent"]) {
      const subscription = editor[name]?.(event => {
        if (name !== "onDidChangeCursorSelection") { read(event); return; }
        if (event?.userSelection) ++interactionId;
        lastInteraction = performance.now();
        read(event);
      });
      if (subscription) cleanup.push(() => subscription.dispose());
    }
    const click = editor.onMouseUp?.(event => {
      if (event.target?.position && event.target.type !== 9) {
        ++interactionId;
        read({ position: event.target.type === 6 && !event.target.detail?.injectedText
          ? event.target.range?.getStartPosition() || event.target.position : event.target.position,
          clientX: event.event?.posx,
          lineRange: event.target.type === 4 ? event.target.range : null });
      }
    });
    if (click) cleanup.push(() => click.dispose());
    if (viewer) warm();
    if (editor.hasTextFocus() || editor.getDomNode()?.ownerDocument !== document) read();
  }
  function attachViewer(instance) {
    if (!instance?.getPageView || !instance.eventBus || viewer === instance) return;
    resetPdf();
    viewer = instance;
    const manualScroll = () => {
      if (viewer !== instance) return;
      lastInteraction = performance.now();
      scrolled = positioned = true;
    };
    for (const name of ["wheel", "touchstart", "pointerdown"]) listen(instance.container, name, manualScroll, { passive: true });
    listen(instance.container, 'pointerdown', () => { ++interactionId; }, { passive: true });
    listen(instance.container, "keydown", event => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) manualScroll();
    });
    for (const event of ["pagesinit", "pagechanging", "pagerendered", "textlayerrendered", "scalechanging", "rotationchanging", "updateviewarea"]) {
      const update = data => {
        if (viewer !== instance) return;
        if (event === "textlayerrendered") clearLayer(instance.getPageView(data?.pageNumber - 1)?.div);
        if (["pagesinit", "scalechanging", "rotationchanging"].includes(event)) { clearLayers(); review.highlights.clearHighlights(); }
        if (event === "textlayerrendered" && performance.now() - lastEdit >= editIdleDelay) {
          warm([data.pageNumber]);
        }
        else queueWarm(data?.pageNumber);
        if (contexts.length || reviewPointer || defaultPointer) schedule();
      };
      instance.eventBus.on(event, update);
      cleanup.push(() => instance.eventBus.off(event, update));
    }
    const destroyed = () => { if (viewer === instance) resetPdf(); };
    instance.eventBus.on("pagesdestroy", destroyed);
    cleanup.push(() => instance.eventBus.off("pagesdestroy", destroyed));
    report("idle");
    queueWarm();
    schedule();
  }
  function queueWarm(number) {
    if (stopped || !selectionHighlight) return;
    preparationPages.add(number);
    if (preparationTask !== null) return;
    preparationTask = setTimeout(() => {
      preparationTask = null;
      if (stopped || !selectionHighlight) return;
      if (performance.now() - lastInteraction < 100 || performance.now() - lastEdit < editIdleDelay) { queueWarm(number); return; }
      const numbers = [...preparationPages].filter(number => number !== undefined);
      if (preparationPages.has(undefined)) numbers.push(...visiblePages());
      preparationPages.clear();
      warm([...new Set(numbers)]);
      if (contexts.length) { locationSearch = null; schedule(); }
      else if (reviewPointer) schedule();
    }, Math.max(0, 100 - (performance.now() - lastInteraction), editIdleDelay - (performance.now() - lastEdit)));
  }
  function warm(numbers = visiblePages()) {
    if (!selectionHighlight || !viewer?.pdfDocument) return;
    const pdf = viewer.pdfDocument, model = currentEditor()?.getModel(), scope = sourcePages();
    for (const div of layers.keys()) if (!div.isConnected) clearLayer(div);
    for (const number of numbers) layerIndex(viewer.getPageView(number - 1)?.div);
    if (model && scope?.length && !review.locator.getDocumentIndex(pdf, scope))
      void review.locator.indexDocument(pdf, scope).catch(error => console.warn('[PDF selection highlight] Source pages unavailable:', error));
    publishSources();
  }
  function publishSources() {
    if (!selectionHighlight) return;
    if (performance.now() - lastEdit < editIdleDelay) return;
    const editor = currentEditor();
    window.dispatchEvent(new CustomEvent('pdf-selection-sources', { detail: {
      editor: editor || activeEditor, pdf: viewer?.pdfDocument,
      enabled: sourceDiffHighlight, diffEnabled: diffHighlight
    } }));
  }
  trackSelection(document);
  listen(document, "selectionchange", selectFromPdf);
  listen(window, "resize", schedule);
  if (document.fonts) listen(document.fonts, 'loadingdone', () => {
    clearLayers(); queueWarm(); schedule();
  });
  listen(window, "pagehide", () => api.stop());
  attachEditor(window.readerMonaco);
  attachViewer(window.ReaderUI.getPdfViewer());
  function trackSelection(doc) {
    if (selectionDocuments.has(doc)) return;
    selectionDocuments.add(doc);
    let preserving = false;
    listen(doc, 'pointerdown', event => {
      preserving = selectionHighlight && event.button === 0 && event.returningToWindow
        && (viewer?.container.contains(event.target) || event.target.closest?.('.monaco-editor'));
      if (preserving) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.button === 0) selecting = true;
    }, true);
    const release = event => {
      selecting = false;
      if (preserving) { preserving = false; return; }
      const publish = pendingDifference;
      pendingDifference = null;
      if (event.type === 'pointerup' && event.button === 0) {
        if (publish) setTimeout(publish, 0);
      } else notifiedSelection = selectionRevision;
      if (doc === document && event.type === 'pointerup' && event.button === 0) selectFromPdf(event);
    };
    listen(doc, 'pointerup', release, true);
    listen(doc, 'pointercancel', release, true);
    listen(doc.defaultView, 'blur', release);
  }
  function selectFromPdf(event) {
    if (stopped || !selectionHighlight || syncingPdf || !viewer) return;
    const native = document.getSelection();
    if (!native?.rangeCount || native.isCollapsed) {
      if (status.mode === "pdf-selection") select([]);
      const div = event?.target?.closest?.('.page'), painted = div && review.highlights.getHighlight(div, true);
      const page = div?.getBoundingClientRect();
      const x = page && (event.clientX - page.left) / page.width;
      const y = page && (event.clientY - page.top) / page.height;
      const distance = box => Math.hypot(Math.max(box.x - x, x - box.x - box.w, 0) * page.width,
        Math.max(box.y - y, y - box.y - box.h, 0) * page.height);
      const notice = painted?.notices?.filter(({ box }) => box
        && event.clientX >= page.left + box.x * page.width - (box.caret ? 8 : 3) && event.clientX <= page.left + (box.x + box.w) * page.width + (box.caret ? 8 : 3)
        && event.clientY >= page.top + box.y * page.height - (box.caret ? 3 : 0) && event.clientY <= page.top + (box.y + box.h) * page.height + (box.caret ? 3 : 0))
        .sort(({ box: a, missing: am }, { box: b, missing: bm }) => distance(a) - distance(b)
          || Math.abs(x - a.x - a.w / 2) - Math.abs(x - b.x - b.w / 2) || Number(!!bm) - Number(!!am))[0];
      if (notice) { notifiedSelection = null; publishDifferences(div, painted, [notice], true, 'pdf'); }
      else if (event?.type === 'pointerup' && viewer.container.contains(event.target)) {
        api.clearReviewPointer();
        select([]);
      }
      return;
    }
    if (event?.type === 'pointerup') return;
    const range = native.getRangeAt(0), chunks = [], scope = sourcePages();
    const ancestor = range.commonAncestorContainer;
    const page = (ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement)?.closest(".page");
    const pages = page && viewer.viewer.contains(page) ? [page] : viewer.viewer.querySelectorAll(".page");
    for (const div of pages) {
      const layer = div.querySelector(".textLayer");
      if (!layer || !range.intersectsNode(layer)) continue;
      if (scope && !scope.includes(Number(div.dataset.pageNumber))) return;
      const index = layerIndex(div);
      if (!index) continue;
      let start = 0, end = index.raw.length;
      for (const part of index.parts) {
        if (range.startContainer === part.node) start = part.start + range.startOffset;
        if (range.endContainer === part.node) end = part.start + range.endOffset;
      }
      if (start !== end) chunks.push({ div, index, start: Math.min(start, end), end: Math.max(start, end) });
    }
    if (!chunks.length) return;
    const editor = currentEditor();
    const model = editor?.getModel();
    if (!model || !editor.setSelection) return;
    activeEditor = editor;
    const index = review.locator.editorSourceIndex(editor.document), { hit, range: missingAnchor, difference } = index.locateSource(chunks);
    select([]);
    for (const chunk of chunks) {
      const result = nativeBoxes(chunk.div, [], [{ range: missingAnchor || { start: chunk.start, end: chunk.end }, difference }]);
      paint(chunk.div, result.boxes, result.notices.map(notice => ({ ...notice, source: hit && { index, start: hit.start, end: hit.end } })));
    }
    report("idle", { mode: "pdf-selection", differences: difference ? [difference] : [] });
    if (!hit) return; // An ambiguous match must not move the editor selection.
    publishSources();
    const target = editor.document.rangeAt(hit.start, hit.end, true);
    syncingPdf = true;
    try {
      editor.setSelection(target);
      editor.revealRangeInCenterIfOutsideViewport?.(target);
    } finally { syncingPdf = false; }
  }
  function visiblePages() {
    if (!viewer?.pdfDocument) return [];
    const visible = viewer._getVisiblePages?.().views;
    if (visible?.length) return visible.map(page => page.id);
    const rect = viewer.container.getBoundingClientRect(), pages = [];
    for (const div of viewer.viewer.querySelectorAll(".page[data-page-number]")) {
      const box = div.getBoundingClientRect();
      if (box.bottom > rect.top && box.top < rect.bottom && box.right > rect.left && box.left < rect.right) {
        pages.push(Number(div.dataset.pageNumber));
      }
    }
    return pages.length ? pages : [viewer.currentPageNumber];
  }
  function layerIndex(div) {
    const layer = div?.querySelector(".textLayer");
    if (!layer || !layer.getClientRects().length) return null;
    const number = Number(div.dataset.pageNumber) || viewer?.currentPageNumber;
    const pdf = viewer?.pdfDocument, columnText = review.locator.columnText(pdf, number);
    const cached = layers.get(div);
    if (cached?.layer === layer && cached.pdf === pdf && cached.columnText === columnText
      && cached.width === div.clientWidth && cached.height === div.clientHeight && !clearLayer(div, cached.observer.takeRecords())) return cached;
    clearLayer(div);
    const parts = [];
    const view = viewer?.getPageView(number - 1);
    const fontAt = review.layerFonts(view, layer, () => {
      if (stopped || !selectionHighlight || viewer?.pdfDocument !== pdf) return;
      clearLayer(div); queueWarm(number);
      if (!document.getSelection()?.isCollapsed) selectFromPdf();
      else if (contexts.length || reviewPointer || defaultPointer) schedule();
    });
    const text = columnText || fontAt.text;
    if (!text || fontAt.items.size !== text.parts.length) return null;
    const { raw, breaks, horizontal } = text;
    const spans = new Map([...fontAt.items].map(([span, item]) => [item, span]));
    // The DOM supplies nodes and fonts; PDF text owns ordering, spaces and offsets.
    for (const part of text.parts) {
      const span = spans.get(part.item), font = fontAt(span);
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      let start = part.start, node;
      while ((node = walker.nextNode())) {
        const end = start + node.textContent.length;
        if (end > start) parts.push({ node, start, end, font });
        start = end;
      }
    }
    const observer = new MutationObserver(records => {
      if (!clearLayer(div, records)) return;
      queueWarm(number);
      if (contexts.length || reviewPointer || defaultPointer) schedule();
    });
    observer.observe(layer, { subtree: true, childList: true, characterData: true, attributes: true });
    const index = new window.PdfSelectionDiff.PdfConnections(review.locator, { layer, raw, parts, breaks, horizontal, observer, pdf, number, columnText, width: div.clientWidth, height: div.clientHeight });
    layers.set(div, index);
    return index;
  }
  function nativeBoxes(div, queries, targets = []) {
    const index = layerIndex(div);
    if (!index) return { boxes: [], count: 0, pending: true };
    const { hits, focusHit } = index.locateLayer(queries, targets);
    const result = review.highlights.measureHighlights(div, index, hits, focusHit);
    // Reuse the confirmed PDF item when its counterpart has no measurable text.
    if (!result.notices.length) result.notices = targets.filter(target => target.marked && target.source && target.difference && !target.difference.missing).map(target => {
      const viewport = viewer.getPageView(target.pageNumber - 1)?.viewport, item = target.item;
      const point = item && viewport?.convertToViewportPoint(item.transform[4], item.transform[5]);
      return { ...target.difference, source: target.source, box: point && {
        x: point[0] / viewport.width, y: (point[1] - item.height * viewport.scale) / viewport.height,
        w: 0, h: item.height * viewport.scale / viewport.height } };
    });
    return result;
  }
  function paint(div, boxes, notices = []) {
    const painted = review.highlights.paintHighlight(div, boxes, options.color);
    if (notices.length) publishDifferences(div, painted, notices);
  }
  async function refreshReviewPointer() {
    const pointer = reviewPointer || defaultPointer;
    if (!pointer || contexts.length) { review.highlights.clearHighlights(true); return; }
    if (stopped || !currentPointer(pointer)) { api.clearReviewPointer(pointer.editor); return; }
    const found = review.locator.findLocations(pointer.pdf, pointer.entries, !reviewPointer), locations = Array.isArray(found) ? found : await found;
    if (contexts.length || (reviewPointer || defaultPointer) !== pointer) return;
    if (!currentPointer(pointer)) { api.clearReviewPointer(pointer.editor); return; }
    const visible = new Set(), targets = locations.flatMap(location => location.targets);
    for (const number of visiblePages()) {
      const div = viewer.getPageView(number - 1)?.div;
      if (!div) continue;
      visible.add(div);
      const result = nativeBoxes(div, [], targets.filter(target => target.pageNumber === number));
      // Painting a marker must not publish selection events that could reopen
      // the popup on its previous side during a window switch; clicks publish it.
      if (result.pending) {
        review.highlights.paintHighlight(div, [], options.color, true);
        continue;
      }
      const painted = review.highlights.paintHighlight(div, result.boxes, options.color, true);
      if (painted) {
        painted.notices = result.notices;
        painted.node.classList.toggle('mew-pdf-default-highlight', !reviewPointer);
        painted.node.classList.toggle('mew-review-preview',
          pointer.editor.getDomNode()?.classList.contains('mew-review-preview') || false);
      }
    }
    review.highlights.clearHighlights(true, visible);
  }
  function publishDifferences(div, painted, notices, pointer = false, side = 'html') {
    // Publish mapping data only. The review adapter chooses where and how to show it.
    const editor = currentEditor(), model = editor?.getModel(), selected = selectionRevision;
    if (notices.length) setTimeout(function publish() {
      if (!selectionHighlight || (!diffHighlight && !sourceDiffHighlight && !notices[0].missing) || stopped || selected !== selectionRevision || notifiedSelection === selected
        || div && !div.isConnected || painted && (!painted.node.isConnected || review.highlights.getHighlight(div, pointer) !== painted)) return;
      // Opening review selects its candidate; wait until the user's drag ends.
      if (selecting) { pendingDifference = publish; return; }
      notifiedSelection = selected;
      const box = notices[0].box, page = div?.getBoundingClientRect();
      const anchor = box && { left: page.left + box.x * page.width, top: page.top + box.y * page.height,
        bottom: page.top + (box.y + box.h) * page.height };
      window.dispatchEvent(new CustomEvent('pdf-selection-difference', { detail: {
        editor, model, pdf: viewer?.pdfDocument, notices, anchor, anchorElement: div, anchorBox: box, interactionId, side, userSelection
      } }));
    }, 0);
  }
  async function refresh(run) {
    if (!contexts.length || !viewer?.pdfDocument || stopped) return;
    const instance = viewer, pdf = instance.pdfDocument, results = [];
    const current = () => selectionHighlight && !stopped && run === revision && instance === viewer && pdf === viewer.pdfDocument;
    if (!locationSearch || locationSearch.pdf !== pdf) {
      report("searching", { error: null });
      const entries = contexts.slice(), marked = entries.every(entry => entry.marked);
      const found = review.locator.findLocations(pdf, entries, marked);
      const search = locationSearch = { pdf, locations: Array.isArray(found)
        && (!marked || found.some(location => location.targets.length)) ? found : null };
      const complete = locations => {
        if (stopped || !selectionHighlight || locationSearch !== search || viewer?.pdfDocument !== pdf) return;
        search.locations = locations;
        schedule(-1);
      };
      // A review group can lose its visible-page mapping for one frame after a
      // replacement; fall back to the whole document instead of marking nothing.
      if (!search.locations) Promise.resolve(found).then(locations => marked
        && !locations.some(location => location.targets.length) ? review.locator.findLocations(pdf, entries, false) : locations)
        .then(complete, error => {
          console.warn("[PDF selection highlight] Context search unavailable:", error);
          complete(entries.map(entry => ({ entry, targets: [] })));
        });
    }
    const locations = locationSearch.locations;
    publishSources();
    publishDifferences(null, null, locations?.flatMap(location => location.notice && (location.notice.missing || !location.targets.length) ? [location.notice] : []) || [], true);
    const exact = locations?.flatMap(location => location.targets) || [];
    const queries = locations?.flatMap(location => location.targets.length ? [] : location.queries || [location.entry.text]) || [];
    if (!positioned && exact.length) {
      await Promise.resolve();
      if (!current()) return;
      const target = exact[0], view = instance.getPageView(target.pageNumber - 1);
      const focus = view?.div && nativeBoxes(view.div, queries, exact.filter(entry => entry.pageNumber === target.pageNumber)).focus;
      if (focus) {
        positioned = true;
        const container = instance.container, rect = container.getBoundingClientRect(), box = view.div.getBoundingClientRect();
        const sx = rect.width / container.offsetWidth, sy = rect.height / container.offsetHeight;
        const left = box.left + (view.div.clientLeft + focus.x * view.div.clientWidth) * box.width / view.div.offsetWidth,
          top = box.top + (view.div.clientTop + focus.y * view.div.clientHeight) * box.height / view.div.offsetHeight;
        const vertical = top < rect.top + container.clientTop * sy || top + focus.h * box.height > rect.top + (container.clientTop + container.clientHeight) * sy;
        const horizontal = left < rect.left + container.clientLeft * sx || left + focus.w * box.width > rect.left + (container.clientLeft + container.clientWidth) * sx;
        if (vertical || horizontal) {
          // Revealing text near the page bottom must not expose mostly the next
          // page: PDF.js would report that page and switch the paired HTML file.
          const bottom = rect.top + (container.clientTop + container.clientHeight) * sy,
            right = rect.left + (container.clientLeft + container.clientWidth) * sx;
          container.scrollBy({
            top: vertical ? Math.min((top - rect.top) / sy - 48, Math.max(0, (box.bottom - bottom) / sy)) : 0,
            left: horizontal ? Math.min((left - rect.left) / sx - 24, Math.max(0, (box.right - right) / sx)) : 0
          });
        }
      } else if (!scrolled) {
        scrolled = true;
        // Let the text layer render before applying the bounded anchor scroll.
        if (target.pageNumber !== instance.currentPageNumber) instance.scrollPageIntoView({ pageNumber: target.pageNumber });
      }
      if (!current()) return;
    }
    const numbers = visiblePages(), visible = new Set(numbers.map(number => instance.getPageView(number - 1)?.div));
    review.highlights.clearHighlights(false, visible);
    for (const number of numbers) {
      const view = instance.getPageView(number - 1);
      if (!view?.div) continue;
      if (!current()) return;
      const result = nativeBoxes(view.div, queries, locations ? exact.filter(target => target.pageNumber === number) : contexts);
      paint(view.div, result.boxes, result.notices);
      results.push({ pageNumber: number, source: "pdf-text", matches: result.count, pending: !!result.pending });
    }
    if (current()) report(locations ? "idle" : "searching", { pages: results, mode: exact.length ? (queries.length ? "mixed" : "exact") : "fallback",
      differences: exact.filter(target => target.difference).map(target => ({ pageNumber: target.pageNumber, ...target.difference })),
      matches: results.reduce((sum, page) => sum + page.matches, 0) });
  }
})().catch(error => console.error(error));

}
