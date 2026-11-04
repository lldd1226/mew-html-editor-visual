const vscode = require("vscode");
const path = require("node:path");
const { readFile: readLocalFile, stat: statLocalFile } = require("node:fs/promises");
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[ch]);
}

function pdfHtml(webview, context, pdfUri) {
  const nonce = `${Date.now()}${Math.random()}`.replace(/\D/g, "");
  const at = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...parts)).toString();
  const slash = value => value.endsWith("/") ? value : `${value}/`;
  const saved = context.workspaceState?.get("mewReader.pdfSession", {});
  const config = {
    sessionState: saved?.document?.pdfUri === pdfUri?.toString(true) ? saved : {},
    core: at("vendor", "pdfjs", "build", "pdf.mjs"),
    worker: at("vendor", "pdfjs", "build", "pdf.worker.mjs"),
    viewer: at("vendor", "pdfjs", "web", "pdf_viewer.mjs"),
    cMap: slash(at("vendor", "pdfjs", "cmaps")),
    fonts: slash(at("vendor", "pdfjs", "standard_fonts")),
    wasm: slash(at("vendor", "pdfjs", "wasm")),
    images: slash(at("vendor", "pdfjs", "web", "images")),
    reviewSettings: context.globalState.get("mewReader.pdfReviewSettings", {}),
    displaySettings: context.globalState.get("mewReader.pdfDisplaySettings.v1", {})
  };
  const encoded = escapeHtml(JSON.stringify(config));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource} blob: data:; img-src ${webview.cspSource} blob: data:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:"><meta id="reader-config" data-config="${encoded}"><link rel="stylesheet" href="${at("vendor", "pdfjs", "web", "pdf_viewer.css")}"><link rel="stylesheet" href="${at("reader-pdf.css")}"><link rel="stylesheet" href="${at("pdfdiff", "replacement-review.css")}"><title>MEW PDF</title></head><body><svg aria-hidden="true" width="0" height="0"><filter id="scanColorFilter" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR id="filterR" type="table" tableValues="0 1"/><feFuncG id="filterG" type="table" tableValues="0 1"/><feFuncB id="filterB" type="table" tableValues="0 1"/></feComponentTransfer></filter></svg><header id="tools"><strong id="title">MEW PDF</strong><div class="tool-group"><button id="tocButton" hidden aria-controls="tocPanel" aria-expanded="false">目录</button><button id="direction" title="切换左右/上下翻页">左右翻页</button><button id="settings" title="调整扫描件颜色">显示设置</button></div><div class="tool-group page-tools"><button id="previous" title="上一页" aria-label="上一页">‹</button><input id="pageNumber" type="text" value="1" aria-label="PDF 页码或页码标签"><span>/</span><output id="pageCount">0</output><button id="next" title="下一页" aria-label="下一页">›</button></div><div class="tool-group zoom-tools"><button id="minus" title="缩小">−</button><input id="zoom" value="页宽" aria-label="PDF 缩放"><button id="plus" title="放大">＋</button></div><details><summary>差异审阅</summary><div id="replacementFeatures"></div></details><button id="copyImage" title="复制本页像素尺寸最大的内嵌原图">复制本页图片</button></header><aside id="tocPanel" hidden aria-label="PDF 目录"><header><strong>目录</strong><button id="tocClose" aria-label="关闭目录">×</button></header><ol id="tocList"></ol></aside><div id="stage" lang="und"><div id="viewer" class="pdfViewer"></div></div><p id="status">等待 HTML 页面…</p><dialog id="settingsDialog"><form method="dialog"><header><strong>扫描件显示设置</strong><button value="close" aria-label="关闭">×</button></header><label>亮度 <output id="brightnessValue">100%</output><input id="brightness" type="range" min="50" max="160" value="100"></label><label>背景色 <input id="paper" type="color" value="#ffffff"></label><label>文字色 <input id="ink" type="color" value="#000000"></label><label class="toggle"><input id="invert" type="checkbox">反色</label><footer><button id="reset" type="button">恢复默认</button><button value="close">完成</button></footer></form></dialog><script type="module" nonce="${nonce}" src="${at("reader-pdf.js")}"></script></body></html>`;
}


// An extension-host restart leaves resolved custom-editor inputs connected to
// the dead host. A window reload instead resolves them normally. Give that
// resolver a chance first, then replace only inputs that never attached.
function restorePdfTabs(context, reader) {
  const savedTabs = (vscode.window.tabGroups?.all || []).flatMap(group =>
    group.tabs.filter(tab => tab.input?.viewType === "mewReader.pdf").map(tab => ({ group, tab })));
  const timer = setTimeout(async () => {
    try {
      for (const { group, tab } of savedTabs) {
        if (reader.panel || reader.resolvingPdf || !vscode.window.tabGroups.all.includes(group) || !group.tabs.includes(tab)) continue;
        // Keep the group (including its auxiliary window) alive while replacing
        // its last tab. The placeholder never owns document data.
        const holder = vscode.window.createWebviewPanel("mewReader.restoring", "正在恢复 PDF…",
          { viewColumn: group.viewColumn, preserveFocus: true }, {});
        try {
          if (!await vscode.window.tabGroups.close(tab, true)) continue;
          await vscode.commands.executeCommand("vscode.openWith", tab.input.uri, "mewReader.pdf",
            { viewColumn: holder.viewColumn, preserveFocus: true, preview: false });
        } finally { holder.dispose(); }
      }
    } catch (error) { reader.report(error); }
  }, 1000);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

function savePdfState(context, message) {
  if (message?.type === "pdfDisplaySettings") return context.globalState.update("mewReader.pdfDisplaySettings.v1", message.settings);
  if (message?.type === "pdfState") return context.workspaceState?.update("mewReader.pdfSession", message.state);
}



const { sameUri, findConfig, resolveUri, sortExplorerFiles, formatPattern, pageFromName, pageFromPdfLabel, adjacentPage, pageAtOrBefore, normalizedVolumes, isInside } = require("./reader-core.cjs");

const { TagBarViewProvider } = require("./tag-panel.js");
const PDF_PANEL_VIEW_TYPE = "mewReader.pdf";

let lastEditor;
let reader;

function activate(context) {
  (reader = new ReaderController(context)).start();
  new TagBarViewProvider(context, { vscode, targetEditor, openSiblingFile, focusReaderWindow, revealReaderTab, report: reader.report }).start();
}

async function openSiblingFile(direction) {
  if (await reader.navigate(direction)) return;
  const current = activeFile();
  if (!current || current.uri.scheme === "untitled") {
    vscode.window.showInformationMessage("请先打开一个已保存的文件。");
    return;
  }

  const currentUri = current.uri;
  try {
    const files = await siblingFiles(currentUri, vscode.Uri.joinPath(currentUri, ".."));
    const currentIndex = files.findIndex(file => sameUri(file.uri, currentUri));
    if (currentIndex < 0) return;
    // 循环切换：首文件←到末尾，尾文件→到开头
    const target = files[(currentIndex + direction + files.length) % files.length];
    await vscode.commands.executeCommand("vscode.open", target.uri, {
      viewColumn: current.viewColumn,
      preserveFocus: false
    });
  } catch (error) {
    console.error("MEW Tags could not open the adjacent file.", error);
  }
}

// 点击标签栏按钮时 webview 视图持有焦点，vscode.window.activeTextEditor 为
// undefined，此时直接用 tabGroups 取活动标签容易拿到错误/滞后的标签（导致
// 弹回标签栏第一个文件）。因此优先取活动文本编辑器，webview 夺焦时退回
// lastEditor（最近一次活动的文本编辑器）。
// Images, PDFs and other custom editors do not appear in activeTextEditor.
// Their URI is available through the active tab input instead.
function activeFile() {
  const editor = vscode.window.activeTextEditor || lastEditor;
  if (editor && !editor.document.isUntitled) {
    return { uri: editor.document.uri, viewColumn: editor.viewColumn };
  }

  const group = vscode.window.tabGroups.activeTabGroup;
  const tabUri = uriFromTabInput(group && group.activeTab && group.activeTab.input);
  if (tabUri) return { uri: tabUri, viewColumn: group.viewColumn };
  return undefined;
}

function uriFromTabInput(input) {
  if (!input) return undefined;
  // `uri`: text/custom/notebook editors; `modified`: diff editors;
  // `result`: merge editors. The latter two keep navigation useful there too.
  for (const candidate of [input.uri, input.modified, input.result, input.original]) {
    if (candidate && typeof candidate.scheme === "string" && typeof candidate.toString === "function") {
      return candidate;
    }
  }
  return undefined;
}

const siblingCache = new Map(); // 目录+排序配置 -> { namesKey, files }

async function siblingFiles(currentUri, parentUri) {
  const explorerConfig = vscode.workspace.getConfiguration("explorer", currentUri);
  const options = {
    sortOrder: explorerConfig.get("sortOrder", "default"),
    lexicographicOptions: explorerConfig.get("sortOrderLexicographicOptions", "default"),
    reverse: explorerConfig.get("sortOrderReverse", false)
  };
  const key = `${parentUri.toString(true)}|${options.sortOrder}|${options.lexicographicOptions}|${options.reverse}`;

  // 轻量核对目录条目：文件列表无改动时直接复用缓存，有改动才重建
  const names = (await vscode.workspace.fs.readDirectory(parentUri))
    .filter(([, type]) => !(type & vscode.FileType.Directory))
    .map(([name]) => name);
  const namesKey = names.join("\n");
  const cached = siblingCache.get(key);
  if (cached && cached.namesKey === namesKey && cached.files.some(file => sameUri(file.uri, currentUri))) {
    return cached.files;
  }

  const files = names.map(name => ({ name, uri: vscode.Uri.joinPath(parentUri, name), mtime: 0 }));
  if (options.sortOrder === "modified") {
    await Promise.all(files.map(async file => {
      try { file.mtime = (await vscode.workspace.fs.stat(file.uri)).mtime; } catch { }
    }));
  }
  if (!files.some(file => sameUri(file.uri, currentUri))) {
    files.push({ name: "", uri: currentUri, mtime: 0 });
  }
  const sorted = sortExplorerFiles(files, options);
  siblingCache.set(key, { namesKey, files: sorted });
  return sorted;
}

function targetEditor() {
  const editor = vscode.window.activeTextEditor || lastEditor;
  if (editor?.document.isClosed) return undefined;
  if (editor) lastEditor = editor;
  return editor;
}

// Restored tabs are available before VS Code resolves their webviews.
function findPdfTab(uri) {
  for (const group of vscode.window.tabGroups?.all || []) {
    const tab = group.tabs.find(tab => tab.input?.viewType === PDF_PANEL_VIEW_TYPE && tab.input.uri && sameUri(tab.input.uri, uri));
    if (tab) return { group, tab };
  }
}

async function revealReaderTab({ group, tab }) {
  const groups = vscode.window.tabGroups.all;
  for (let i = 0; vscode.window.tabGroups.activeTabGroup !== group && i < groups.length; i++) {
    await waitForTabChange("workbench.action.focusNextGroup", () => vscode.window.tabGroups.activeTabGroup === group);
  }
  if (vscode.window.tabGroups.activeTabGroup !== group) return false;
  for (let i = 0; group.activeTab !== tab && i < group.tabs.length; i++) {
    await waitForTabChange("workbench.action.nextEditorInGroup", () => group.activeTab === tab);
  }
  if (group.activeTab !== tab) return false;
  await focusReaderWindow();
  return true;
}

// Command completion can precede the extension-host tab-state event.
async function waitForTabChange(command, ready) {
  const tabs = vscode.window.tabGroups;
  let finish, timer;
  const changed = new Promise(resolve => { finish = resolve; });
  const check = () => { if (ready()) finish(); };
  const listeners = [tabs.onDidChangeTabGroups?.(check), tabs.onDidChangeTabs?.(check)];
  try {
    timer = setTimeout(finish, 500);
    await vscode.commands.executeCommand(command);
    check();
    await changed;
  } finally {
    clearTimeout(timer);
    for (const listener of listeners) listener?.dispose();
  }
}

async function focusReaderWindow() {
  await vscode.commands.executeCommand("workbench.action.focusWindow");
}

class ReaderController {
  constructor(context) {
    this.context = context;
    this.panel = null;
    this.current = null;
    this.ready = false;
    this.restoredDocument = null;
    this.panelPdfUri = null;
    this.syncRevision = 0;
    this.navigationRevision = 0;
    this.focusRevision = 0;
    this.report = error => {
      console.error("MEW Reader", error);
      vscode.window.showErrorMessage(`MEW Reader：${error.message || error}`);
    };
  }

  start() {
    const { context } = this;
    lastEditor = vscode.window.activeTextEditor;
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor) return;
      lastEditor = editor;
      this.sync(editor.document.uri).catch(this.report);
    }));
    restorePdfTabs(context, this);
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(PDF_PANEL_VIEW_TYPE, this, {
      supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true }
    }),
      vscode.commands.registerCommand("mewReader.openPdf", () => this.open()),
      vscode.commands.registerCommand("mewReader.openPreviousPage", () => openSiblingFile(-1)),
      vscode.commands.registerCommand("mewReader.openNextPage", () => openSiblingFile(1)));
    for (const id of ["pdf-selection-sync", "pdf-ocr", "pdf-font", "pdf-bold", "pdf-selection", "source-diff"])
      context.subscriptions.push(vscode.commands.registerCommand(`mewReader.toggle.${id}`, async () => {
        if (!this.panel) await this.open();
        return this.panel?.webview.postMessage({ type: "reviewToggle", id });
      }));
    if (lastEditor) this.sync(lastEditor.document.uri).catch(this.report);
  }

  async sync(uri, forceOpen = false) {
    if (!sameUri(uri, this.pdfNavigationTarget)) ++this.navigationRevision;
    const revision = ++this.syncRevision;
    const current = uri && /\.html?$/i.test(uri.path) ? await this.resolvePage(uri) : null;
    if (revision !== this.syncRevision) return false;
    this.current = current;
    if (!current) return false;
    this.watchVolume(current.volume);
    if (this.pdfNavigationTarget && sameUri(uri, this.pdfNavigationTarget)) {
      await this.pdfSource?.publish();
      return true;
    }
    this.pdfPageLabel = String(current.page);
    this.restoredDocument = null;
    const autoOpen = vscode.workspace.getConfiguration("mewReader", uri).get("autoOpenPdf", true);
    if (!this.panel && !autoOpen && !forceOpen) return true;
    if (!this.panel || !sameUri(this.panelPdfUri, current.volume.pdfUri)) await this.createPanel(current);
    // openWith can return before a restored custom editor is attached. Its
    // resolver owns the title; the ready handshake sends the pending current.
    await this.sendCurrent();
    return true;
  }

  watchVolume(volume) {
    const key = volume.directoryUri.toString();
    if (this.watchedDirectory === key) return;
    this.fileWatcher?.dispose();
    this.watchedDirectory = key;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(volume.directoryUri, "*"));
    this.fileWatcher = watcher;
    const changed = () => {
      clearTimeout(this.directoryTimer);
      this.directoryTimer = setTimeout(() => this.refreshVolume().catch(this.report), 120);
    };
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    this.context.subscriptions.push(watcher, { dispose: () => clearTimeout(this.directoryTimer) });
  }

  indexVolume(volume, entries) {
    volume.files = new Map(entries.flatMap(([name, type]) => {
      const page = pageFromName(name, volume.pattern);
      return !(type & vscode.FileType.Directory) && page != null &&
        (!volume.explicitPages.length || volume.explicitPages.includes(page))
        ? [[page, vscode.Uri.joinPath(volume.directoryUri, name)]] : [];
    }));
    volume.pages = (volume.explicitPages.length ? volume.explicitPages.filter(page => volume.files.has(page)) : [...volume.files.keys()]).sort((a, b) => typeof a === "number" && typeof b === "number" ? a - b : typeof a === "number" ? 1 : typeof b === "number" ? -1 : 0);
  }

  async refreshVolume() {
    const current = this.current;
    if (!current || !this.panel) return;
    const volume = current.volume;
    const entries = await vscode.workspace.fs.readDirectory(volume.directoryUri);
    if (this.current !== current) return;
    this.indexVolume(volume, entries);
    await this.onPdfPage({ pageLabel: this.pdfPageLabel ?? String(current.page) });
  }

  async open() {
    const uri = activeFile()?.uri;
    if (!uri || !(await this.sync(uri, true))) return vscode.window.showInformationMessage("当前文件没有可用的对应 PDF，可继续使用标签插入功能。");
    if (this.panel && sameUri(this.panelPdfUri, this.current.volume.pdfUri)) {
      this.panel.reveal(undefined, false);
    await focusReaderWindow();
    } else {
      const restored = findPdfTab(this.current.volume.pdfUri);
      if (restored) await revealReaderTab(restored);
    }
  }

  async navigate(direction) {
    const uri = activeFile()?.uri;
    if (!uri || !/\.html?$/i.test(uri.path)) return false;
    const current = this.current && sameUri(this.current.uri, uri) ? this.current : await this.resolvePage(uri);
    if (!current) return false;
    const page = adjacentPage(current.volume.pages, current.page, direction);
    if (page == null) return true;
    await this.openHtmlPage(current, page);
    return true;
  }

  async openHtmlPage(current, page, preserveFocus = true) {
    const revision = ++this.navigationRevision;
    const target = current.volume.files.get(page);
    if (!target) return;
    const column = targetEditor()?.viewColumn || vscode.ViewColumn.Active;
    const document = await vscode.workspace.openTextDocument(target);
    if (revision !== this.navigationRevision || (preserveFocus && this.current !== current)) return;
    await vscode.window.showTextDocument(document, { viewColumn: column, preserveFocus, preview: true });
    if (revision === this.navigationRevision) await this.sync(target);
  }

  async onPdfPage(message) {
    ++this.navigationRevision;
    const current = this.current;
    if (!current) return;
    this.pdfPageLabel = message.pageLabel;
    const requested = pageFromPdfLabel(message.pageLabel);
    const page = requested == null ? null : pageAtOrBefore(current.volume.pages, requested);
    if (page == null || page === current.page) return;
    this.pdfNavigationTarget = current.volume.files.get(page);
    try { await this.openHtmlPage(current, page, true); }
    finally { this.pdfNavigationTarget = null; }
  }

  async createPanel(current) {
    // Let the custom-editor resolver attach the tab saved by VS Code in place.
    if (findPdfTab(current.volume.pdfUri)) return;
    if (this.openingPanel) {
      await this.openingPanel;
      if (findPdfTab(current.volume.pdfUri) ||
          (this.panel && sameUri(this.panelPdfUri, current.volume.pdfUri))) return;
    }
    this.openingPanel = this.openFloating(current);
    try { await this.openingPanel; }
    finally { this.openingPanel = null; }
  }

  async openFloating(current) {
    const setting = vscode.workspace.getConfiguration("mewReader", current.uri).get("pdfOpenLocation", "beside");
    const column = setting === "active" ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    await vscode.commands.executeCommand("vscode.openWith", current.volume.pdfUri, PDF_PANEL_VIEW_TYPE, {
      viewColumn: column,
      preserveFocus: setting !== "newWindow",
      preview: false
    });
    if (setting === "newWindow") {
      try {
        await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
        await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
      }
      catch { vscode.window.showWarningMessage("MEW Reader：当前 VS Code 不支持自动把 PDF 页签移到新窗口，已保留在右侧。"); }
    }
  }

  openCustomDocument(uri) {
    this.resolvingPdf = true;
    return { uri, dispose() {} };
  }

  resolveCustomEditor(document, panel) {
    if (this.current && !sameUri(this.current.volume.pdfUri, document.uri)) this.current = null;
    const fileName = panel.title = path.basename(document.uri.fsPath || document.uri.path);
    this.attachPanel(panel, {
      pdfUri: document.uri.toString(true),
      fileName,
      pageLabel: "1"
    });
  }

  attachPanel(panel, restoredDocument = null) {
    if (this.panel && this.panel !== panel) this.panel.dispose();
    this.panel = panel;
    this.ready = false;
    this.restoredDocument = restoredDocument;
    const pdfUri = restoredDocument?.pdfUri ? vscode.Uri.parse(restoredDocument.pdfUri) : this.current?.volume.pdfUri;
    this.panelPdfUri = pdfUri ?? null;
    this.resolvingPdf = false;
    this.pdfSource = require("./pdfdiff/pdf-selection.js").attach(this, panel);
    require("./pdfdiff/replacement-review.js").attach(this, panel, this.pdfSource, focusReaderWindow);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: pdfUri ? [this.context.extensionUri, vscode.Uri.joinPath(pdfUri, "..")] : [this.context.extensionUri]
    };
    // Bind byte access to this custom editor's file, never to a webview-supplied
    // path. Binary postMessage bypasses the webview resource service worker.
    let disposed = false;
    let reading;
    const readController = new AbortController();
    panel.webview.onDidReceiveMessage(message => {
      if (disposed || this.panel !== panel) return;
      if (message?.type === "focusPdf") {
        ++this.focusRevision;
        panel.reveal(undefined, false);
        focusReaderWindow().catch(this.report);
      }
      if (message?.type === "copyImageError") vscode.window.showErrorMessage(`复制图片失败：${String(message.error)}`);
      if (message?.type === "pdfDataRequest" && Number.isSafeInteger(message.id) && pdfUri?.scheme === "file") {
        reading ||= statLocalFile(pdfUri.fsPath).then(info => info.size <= 128 * 1024 * 1024
          ? readLocalFile(pdfUri.fsPath, { signal: readController.signal }) : null);
        const request = reading;
        request.then(bytes => {
          if (!disposed) return panel.webview.postMessage({ type: "pdfData", id: message.id,
            data: bytes ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null });
        }, error => {
          if (!disposed) return panel.webview.postMessage({ type: "pdfData", id: message.id, error: error.message });
        }).catch(this.report).finally(() => { if (reading === request) reading = null; });
      }
      if (message?.type === "ready") {
        this.ready = true;
        this.acceptRestoredDocument(message.document);
        this.sendCurrent().catch(this.report);
      }
      if (message?.type === "pdfPageChange") this.onPdfPage(message).catch(this.report);
      savePdfState(this.context, message)?.catch(this.report);
    }, null, this.context.subscriptions);
    panel.onDidDispose(() => {
      disposed = true;
      readController.abort();
      if (this.panel !== panel) return;
      this.panel = null;
      this.ready = false;
      this.restoredDocument = null;
      this.panelPdfUri = null;
      this.pdfSource = null;
    }, null, this.context.subscriptions);
    // Register the handshake before starting the webview, including restoration.
    panel.webview.html = pdfHtml(panel.webview, this.context, pdfUri);
    panel.webview.postMessage({ type: "requestReady" }).then(undefined, this.report);
  }

  acceptRestoredDocument(value) {
    if (!value || typeof value !== "object") return;
    const restored = Object.fromEntries(["htmlUri", "pdfUri", "fileName", "pageLabel"]
      .filter(key => typeof value[key] === "string" && value[key]).map(key => [key, value[key]]));
    if (!restored.pdfUri || (this.panelPdfUri && restored.pdfUri !== this.panelPdfUri.toString(true))) return;
    this.restoredDocument = restored;
    if (restored.htmlUri && !this.current) {
      const uri = vscode.Uri.parse(restored.htmlUri);
      if (/\.html?$/i.test(uri.path)) this.resolvePage(uri).then(current => {
        if (!current || this.current) return;
        this.current = current;
        this.sendCurrent();
      }).catch(error => console.warn("MEW Reader could not resolve the restored HTML page", error));
    }
  }

  async sendCurrent() {
    if (!this.panel || !this.ready) return;
    const current = this.current;
    const document = this.restoredDocument?.htmlUri === current?.uri.toString(true) ? this.restoredDocument : current ? {
      htmlUri: this.current.uri.toString(true),
      pdfUri: current.volume.pdfUri.toString(true),
      fileName: path.basename(current.volume.pdfUri.fsPath || current.volume.pdfUri.path),
      pageLabel: formatPattern(current.volume.pageLabel, current.page, current.volume.id)
    } : this.restoredDocument;
    if (!document?.pdfUri) return;
    const pdfUri = vscode.Uri.parse(document.pdfUri);
    // The custom editor owns one PDF; a pending switch must not retarget its data bridge.
    if (!sameUri(pdfUri, this.panelPdfUri)) return;
    await this.panel.webview.postMessage({
      type: "showPdf",
      ...document,
      maxPage: current?.volume.pages.at(-1) ?? document.maxPage,
      nativeData: pdfUri.scheme === "file",
      url: this.panel.webview.asWebviewUri(pdfUri).toString()
    });
    await this.pdfSource?.publish();
  }


  async resolvePage(uri) {
    const known = this.knownPage(uri);
    if (known) return known;
    const configUri = await findConfig(vscode, uri);
    if (!configUri) return null;
    const raw = await vscode.workspace.fs.readFile(configUri);
    let json;
    try { json = JSON.parse(Buffer.from(raw).toString("utf8")); }
    catch (error) { throw new Error(`${configUri.fsPath || configUri.path} 不是有效 JSON：${error.message}`); }
    const base = vscode.Uri.joinPath(configUri, "..");
    for (const spec of normalizedVolumes(json)) {
      const directoryUri = resolveUri(vscode, base, spec.directory);
      if (!isInside(path.resolve(uri.fsPath), path.resolve(directoryUri.fsPath))) continue;
      const page = pageFromName(path.basename(uri.fsPath), spec.pattern);
      if (page == null) continue;
      const entries = await vscode.workspace.fs.readDirectory(directoryUri);
      spec.directoryUri = directoryUri;
      this.indexVolume(spec, entries);
      spec.pdfUri = resolveUri(vscode, base, spec.pdf);
      if (!spec.files.has(page)) return null;
      const pdf = await vscode.workspace.fs.stat(spec.pdfUri).catch(() => null);
      if (!pdf || pdf.type & vscode.FileType.Directory) return null;
      return { uri, page, volume: spec, configUri };
    }
    return null;
  }

  knownPage(uri) {
    const volume = this.current?.volume;
    if (!volume?.directoryUri || !isInside(path.resolve(uri.fsPath), path.resolve(volume.directoryUri.fsPath))) return null;
    const page = pageFromName(path.basename(uri.fsPath), volume.pattern);
    const file = page == null ? null : volume.files.get(page);
    if (!file || !sameUri(file, uri)) return null;
    return { uri, page, volume, configUri: this.current.configUri };
  }
}

module.exports = { activate, pdfHtml, restorePdfTabs, savePdfState };
