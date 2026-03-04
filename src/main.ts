import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { register } from "@tauri-apps/plugin-global-shortcut";

interface BookInfo {
  title: string;
  content: string;
  chapters: ChapterInfo[];
}

interface ChapterInfo {
  title: string;
  start: number;
  end: number;
}

interface HistoryItem {
  path: string;
  title: string;
  progress: number;
  totalPages?: number;
  lastRead: number;
}

interface Settings {
  fontSize: number;
  lineHeight: number;
  charsPerPage: number;
  opacity: number;
  fontFamily: string;
  textColor: string;
  windowOpacity: number;
  encoding: string;
  readingMode: boolean;
  mouseMode: boolean;
}

let currentBook: BookInfo | null = null;
let currentPath = "";
let currentPage = 0;
let totalPages = 0;
let pages: string[] = [];
let history: HistoryItem[] = [];
let isReadingMode = false;
let isMouseMode = false;
let activeSidebarTab: "toc" | "history" = "toc";
let readingChromeHideTimer: number | undefined;
const chapterPageMap: Map<number, number> = new Map();
let chapterPageStarts: number[] = [];
let pageChapterMap: number[] = [];
let chapterPageCounts: number[] = [];

const defaultSettings: Settings = {
  fontSize: 18,
  lineHeight: 1.6,
  charsPerPage: 1000,
  opacity: 0.85,
  fontFamily: "Microsoft YaHei, PingFang SC, sans-serif",
  textColor: "#2c3e50",
  windowOpacity: 1,
  encoding: "utf-8",
  readingMode: false,
  mouseMode: false,
};

let settings: Settings = { ...defaultSettings };

function loadSettings(): void {
  try {
    const saved = localStorage.getItem("novel-reader-settings");
    if (saved) {
      settings = { ...defaultSettings, ...JSON.parse(saved) };
      applySettings();
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem("novel-reader-settings", JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

function applySettings(): void {
  const root = document.documentElement;
  root.style.setProperty("--font-size", `${settings.fontSize}px`);
  root.style.setProperty("--line-height", `${settings.lineHeight}`);
  root.style.setProperty("--font-family", settings.fontFamily);
  root.style.setProperty("--bg-opacity", `${settings.opacity}`);
  root.style.setProperty("--bg-color", `rgba(249, 248, 245, ${settings.opacity})`);
  root.style.setProperty("--text-color", settings.textColor);
  root.style.setProperty("--window-opacity", settings.windowOpacity.toString());
}

function clampPage(page: number): number {
  if (totalPages <= 0) return 0;
  return Math.max(0, Math.min(page, totalPages - 1));
}

function paginateContent(content: string, charsPerPage: number, chapters: ChapterInfo[]): string[] {
  chapterPageStarts = [];
  pageChapterMap = [];
  chapterPageCounts = [];

  const pushPage = (text: string, chapterIndex: number, allPages: string[]): void => {
    const normalized = text.trim();
    if (!normalized) return;
    allPages.push(normalized);
    pageChapterMap.push(chapterIndex);
  };

  if (!chapters || chapters.length === 0) {
    const lines = content.split(/\r?\n/);
    const allPages: string[] = [];
    let currentPageText = "";

    for (const line of lines) {
      const trimmedLine = line.trimEnd();
      if (!trimmedLine.trim()) continue;

      if (currentPageText.length + trimmedLine.length > charsPerPage) {
        pushPage(currentPageText, 0, allPages);
        currentPageText = trimmedLine;
      } else {
        currentPageText += (currentPageText ? "\n\n" : "") + trimmedLine;
      }
    }

    pushPage(currentPageText, 0, allPages);
    chapterPageStarts = [0];
    chapterPageCounts = [allPages.length];
    if (allPages.length > 0 && pageChapterMap.length === 0) {
      pageChapterMap = Array.from({ length: allPages.length }, () => 0);
    }
    return allPages;
  }

  const allPages: string[] = [];

  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
    const chapter = chapters[chapterIndex];
    chapterPageStarts.push(allPages.length);
    const chapterContent = content.substring(chapter.start, chapter.end);
    const lines = chapterContent.split(/\r?\n/);
    let currentPageText = "";
    let hasTitle = false;

    const chapterTitle = chapter.title.trim();
    if (chapterTitle) {
      currentPageText = chapterTitle;
      hasTitle = true;
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const raw = lines[lineIndex];
      const trimmedLine = raw.trimEnd();
      if (!trimmedLine.trim()) continue;

      // Skip the duplicated heading line if the chapter slice already starts from heading.
      if (!hasTitle && chapterTitle && trimmedLine.trim() === chapterTitle) {
        currentPageText = chapterTitle;
        hasTitle = true;
        continue;
      }
      if (hasTitle && lineIndex === 0 && trimmedLine.trim() === chapterTitle) {
        continue;
      }

      if (currentPageText.length + trimmedLine.length > charsPerPage) {
        pushPage(currentPageText, chapterIndex, allPages);
        currentPageText = trimmedLine;
      } else {
        currentPageText += (currentPageText ? "\n\n" : "") + trimmedLine;
      }
    }

    pushPage(currentPageText, chapterIndex, allPages);
    chapterPageCounts.push(allPages.length - chapterPageStarts[chapterIndex]);
  }

  return allPages;
}

function detectChaptersFromText(content: string): ChapterInfo[] {
  const lines = content.split(/\r?\n/);
  const candidates: { title: string; pos: number }[] = [];
  let cursor = 0;

  // Use unicode escapes to avoid source-encoding issues when matching Chinese headings.
  const chapterHeadingPattern =
    /^(?:\u7b2c\s*[\d\u4e00-\u9fa5\u3007\u96f6\u4e24]+\s*[\u7ae0\u8282\u5377\u90e8\u7bc7\u56de\u96c6]|(?:\u5e8f\u7ae0|\u6954\u5b50|\u540e\u8bb0|\u756a\u5916|\u5c3e\u58f0|\u5f15\u5b50))(?:\s+|[:：\-_.、]).*$/u;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed && chapterHeadingPattern.test(trimmed)) {
      const lineOffset = rawLine.indexOf(trimmed);
      const pos = cursor + (lineOffset >= 0 ? lineOffset : 0);
      const title = trimmed.replace(/\s+/g, " ").slice(0, 80);

      const prev = candidates[candidates.length - 1];
      if (!prev || Math.abs(prev.pos - pos) > 2) {
        candidates.push({ title, pos });
      }
    }
    cursor += rawLine.length + 1;
  }

  if (candidates.length < 2) {
    return [];
  }

  const chapters: ChapterInfo[] = [];
  for (let i = 0; i < candidates.length; i++) {
    chapters.push({
      title: candidates[i].title,
      start: candidates[i].pos,
      end: i < candidates.length - 1 ? candidates[i + 1].pos : content.length,
    });
  }

  return chapters;
}


function ensureTocReady(forceRebuild = false): void {
  if (!currentBook) return;

  const needDetect =
    forceRebuild || !currentBook.chapters || currentBook.chapters.length < 2;
  if (needDetect) {
    const detected = detectChaptersFromText(currentBook.content);
    if (detected.length >= 2) {
      currentBook.chapters = detected;
      const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
      pages = paginateContent(currentBook.content, settings.charsPerPage, currentBook.chapters);
      totalPages = pages.length;
      currentPage = clampPage(Math.round((totalPages - 1) * ratio));
    }
  }

  buildChapterPageMap();
}

function buildChapterPageMap(): void {
  chapterPageMap.clear();
  if (!currentBook || !currentBook.chapters.length || !pages.length) return;

  if (chapterPageStarts.length === currentBook.chapters.length) {
    for (let i = 0; i < chapterPageStarts.length; i++) {
      chapterPageMap.set(i, clampPage(chapterPageStarts[i]));
    }
    return;
  }

  let pageCursor = 0;

  for (let i = 0; i < currentBook.chapters.length; i++) {
    const chapter = currentBook.chapters[i];
    chapterPageMap.set(i, Math.min(pageCursor, Math.max(totalPages - 1, 0)));

    const chapterContent = currentBook.content.substring(chapter.start, chapter.end);
    const lines = chapterContent.split(/\n+/);
    let currentPageText = "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      if (currentPageText.length + trimmedLine.length > settings.charsPerPage) {
        if (currentPageText) pageCursor++;
        currentPageText = trimmedLine;
      } else {
        currentPageText += (currentPageText ? "\n\n" : "") + trimmedLine;
      }
    }

    if (currentPageText) pageCursor++;
  }
}

function getChapterPage(chapterIndex: number): number {
  return chapterPageMap.get(chapterIndex) ?? 0;
}

function getChapterEndPage(chapterIndex: number): number {
  if (!currentBook || !currentBook.chapters.length) {
    return Math.max(totalPages - 1, 0);
  }

  if (chapterIndex >= currentBook.chapters.length - 1) {
    return Math.max(totalPages - 1, 0);
  }

  const nextStart = getChapterPage(chapterIndex + 1);
  return Math.max(nextStart - 1, getChapterPage(chapterIndex));
}

function getCurrentChapterIndex(): number {
  if (!currentBook || !currentBook.chapters.length) return -1;

  for (let i = currentBook.chapters.length - 1; i >= 0; i--) {
    if (currentPage >= getChapterPage(i)) {
      return i;
    }
  }

  return 0;
}

function setSidebarTab(tab: "toc" | "history"): void {
  activeSidebarTab = tab;
  document.querySelectorAll(".toc-tab").forEach((node) => {
    const isActive = node.getAttribute("data-tab") === tab;
    node.classList.toggle("active", isActive);
  });

  const tocList = document.getElementById("toc-list");
  const historyList = document.getElementById("history-list");
  if (tocList) tocList.style.display = tab === "toc" ? "block" : "none";
  if (historyList) historyList.style.display = tab === "history" ? "block" : "none";
}

function toggleTocSidebar(forceOpen?: boolean): void {
  const tocSidebar = document.getElementById("toc-sidebar");
  if (!tocSidebar) return;

  if (typeof forceOpen === "boolean") {
    tocSidebar.classList.toggle("open", forceOpen);
  } else {
    tocSidebar.classList.toggle("open");
  }
}

function openTocSidebar(tab: "toc" | "history" = "toc"): void {
  setSidebarTab(tab);
  toggleTocSidebar(true);
}

function closeTocSidebar(): void {
  toggleTocSidebar(false);
}

function setReadingChromeVisible(visible: boolean, autoHideMs = 0): void {
  const app = document.getElementById("app");
  if (!app) return;

  if (readingChromeHideTimer) {
    window.clearTimeout(readingChromeHideTimer);
    readingChromeHideTimer = undefined;
  }

  app.classList.toggle("controls-visible", visible);

  if (!visible || autoHideMs <= 0) return;

  readingChromeHideTimer = window.setTimeout(() => {
    const tocOpen = document.getElementById("toc-sidebar")?.classList.contains("open");
    const settingsOpen = document.getElementById("settings-panel")?.classList.contains("show");
    if (!tocOpen && !settingsOpen) {
      app.classList.remove("controls-visible");
    }
  }, autoHideMs);
}

function toggleReadingMode(enable: boolean): void {
  isReadingMode = enable;
  const app = document.getElementById("app");
  if (enable) {
    app?.classList.add("reading-mode");
    setReadingChromeVisible(false);
  } else {
    app?.classList.remove("reading-mode");
    app?.classList.remove("controls-visible");
    closeTocSidebar();
    if (readingChromeHideTimer) {
      window.clearTimeout(readingChromeHideTimer);
      readingChromeHideTimer = undefined;
    }
  }
}

function toggleMouseMode(enable: boolean): void {
  isMouseMode = enable;
  const app = document.getElementById("app");
  if (enable) {
    app?.classList.add("mouse-mode");
  } else {
    app?.classList.remove("mouse-mode");
    app?.classList.remove("mouse-out");
  }
}

function updateChapterTitle(): void {
  const chapterTitleEl = document.getElementById("chapter-title");
  if (!chapterTitleEl || !currentBook || !currentBook.chapters.length) {
    if (chapterTitleEl) chapterTitleEl.textContent = "";
    return;
  }

  const currentChapterIndex = getCurrentChapterIndex();
  chapterTitleEl.textContent = currentBook.chapters[currentChapterIndex]?.title ?? "";
}

function updateTocStatus(): void {
  if (!currentBook || !currentBook.chapters.length) return;

  const tocList = document.getElementById("toc-list");
  if (!tocList) return;

  const currentChapterIndex = getCurrentChapterIndex();
  const items = tocList.querySelectorAll(".toc-item");
  items.forEach((el, index) => {
    const pageStart = getChapterPage(index);
    const pageEnd = getChapterEndPage(index);
    const isActive = index === currentChapterIndex || (currentPage >= pageStart && currentPage <= pageEnd);
    const isRead = pageEnd < currentPage;

    el.classList.toggle("active", isActive);
    el.classList.toggle("read", isRead);
  });
}

function renderToc(): void {
  const tocList = document.getElementById("toc-list");
  if (!tocList || !currentBook) {
    if (tocList) {
      tocList.innerHTML = '<div class="toc-empty">暂无目录</div>';
    }
    return;
  }

  ensureTocReady(false);
  if (!currentBook.chapters || !currentBook.chapters.length) {
    tocList.innerHTML = '<div class="toc-empty">未识别到章节，点击目录按钮可重试</div>';
    return;
  }

  const chapterElements = currentBook.chapters
    .map((chapter, index) => {
      const pageStart = getChapterPage(index);
      const pageEnd = getChapterEndPage(index);
      const isActive = currentPage >= pageStart && currentPage <= pageEnd;
      const isRead = pageEnd < currentPage;
      return `<div class="toc-item ${isActive ? "active" : ""} ${isRead ? "read" : ""}" data-page="${pageStart}">${chapter.title}</div>`;
    })
    .join("");

  tocList.innerHTML = chapterElements;

  tocList.querySelectorAll(".toc-item").forEach((el) => {
    el.addEventListener("click", () => {
      const page = parseInt(el.getAttribute("data-page") || "0", 10);
      currentPage = clampPage(page);
      renderPage(currentPage);
      if (isReadingMode) {
        closeTocSidebar();
      }
    });
  });
}

function ensureTocForCurrentBook(): void {
  if (!currentBook) return;
  const missingChapters = !currentBook.chapters || currentBook.chapters.length < 2;
  ensureTocReady(missingChapters);
}

function renderPage(pageIndex: number): void {
  const readerContent = document.getElementById("reader-content");
  if (!readerContent) return;

  if (!pages.length) {
    readerContent.innerHTML = '<div class="welcome-text">暂无可显示内容</div>';
    return;
  }

  const safePage = clampPage(pageIndex);
  currentPage = safePage;

  const page = pages[safePage] ?? "";
  readerContent.innerHTML = "";
  const text = document.createElement("div");
  text.className = "text-content";
  text.textContent = page;
  readerContent.appendChild(text);
  readerContent.scrollTop = 0;

  const progress = ((safePage + 1) / totalPages) * 100;
  const progressFill = document.getElementById("progress-fill");
  const pageInfo = document.getElementById("page-info");
  const currentChapterIndex = getCurrentChapterIndex();
  const chapterStart = currentChapterIndex >= 0 ? getChapterPage(currentChapterIndex) : 0;
  const chapterEnd = currentChapterIndex >= 0 ? getChapterEndPage(currentChapterIndex) : Math.max(totalPages - 1, 0);
  const chapterPageCount = Math.max(chapterEnd - chapterStart + 1, 1);
  const chapterPageOffset = Math.max(safePage - chapterStart + 1, 1);
  if (progressFill) progressFill.style.width = `${progress}%`;
  if (pageInfo) {
    pageInfo.textContent = `${safePage + 1}/${totalPages} (${Math.round(progress)}%) | CH ${chapterPageOffset}/${chapterPageCount}`;
  }

  updateChapterTitle();
  updateTocStatus();
  saveProgress();
}

function repaginateAndRender(keepRatio: boolean): void {
  if (!currentBook) return;

  const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
  pages = paginateContent(currentBook.content, settings.charsPerPage, currentBook.chapters);
  totalPages = pages.length;

  if (keepRatio) {
    currentPage = clampPage(Math.round((totalPages - 1) * ratio));
  } else {
    currentPage = clampPage(currentPage);
  }

  buildChapterPageMap();
  renderToc();
  renderPage(currentPage);
}

function nextPage(): void {
  if (currentPage < totalPages - 1) {
    currentPage++;
    renderPage(currentPage);
  }
}

function prevPage(): void {
  if (currentPage > 0) {
    currentPage--;
    renderPage(currentPage);
  }
}

function showLoading(show: boolean, text = "加载中...", progress = 0): void {
  const welcomeText = document.getElementById("welcome-text");
  const loadingIndicator = document.getElementById("loading-indicator");
  const loadingText = document.getElementById("loading-text");
  const loadingProgressBar = document.getElementById("loading-progress-bar");

  if (welcomeText) welcomeText.style.display = show ? "none" : "block";
  if (loadingIndicator) loadingIndicator.style.display = show ? "block" : "none";
  if (loadingText) loadingText.textContent = text;
  if (loadingProgressBar) loadingProgressBar.style.width = `${progress}%`;
}

async function openFile(): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: "小说文件", extensions: ["txt", "epub"] }],
    });

    if (selected) {
      await loadBook(selected as string);
    }
  } catch (e) {
    console.error("Failed to open file:", e);
  }
}

async function loadBook(path: string): Promise<void> {
  showLoading(true, "正在打开文件...", 10);

  try {
    const book: BookInfo = path.toLowerCase().endsWith(".epub")
      ? await invoke("read_epub_file", { path })
      : await invoke("read_txt_file", { path, encoding: settings.encoding });

    showLoading(true, "正在处理内容...", 50);

    currentBook = book;
    const detectedChapters = detectChaptersFromText(book.content);
    if (detectedChapters.length >= 2) {
      currentBook.chapters = detectedChapters;
    }
    currentPath = path;

    showLoading(true, "正在分页...", 70);
    pages = paginateContent(book.content, settings.charsPerPage, book.chapters);
    totalPages = pages.length;
    buildChapterPageMap();
    ensureTocForCurrentBook();

    const savedProgress = getSavedProgress(path);
    currentPage = clampPage(savedProgress);

    showLoading(true, "正在渲染...", 90);
    renderToc();
    renderPage(currentPage);
    await addToHistory(path, book.title);
    showLoading(false);
  } catch (e) {
    console.error("Failed to load book:", e);
    showLoading(false);
  }
}

function saveProgress(): void {
  if (!currentPath) return;
  try {
    localStorage.setItem(`progress_${currentPath}`, currentPage.toString());
    updateHistoryProgress(currentPath, currentPage);
  } catch (e) {
    console.error("Failed to save progress:", e);
  }
}

function getSavedProgress(path: string): number {
  try {
    const progress = localStorage.getItem(`progress_${path}`);
    return progress ? parseInt(progress, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function loadHistory(): void {
  try {
    const saved = localStorage.getItem("novel-reader-history");
    if (saved) {
      history = JSON.parse(saved);
      renderHistory();
    }
  } catch (e) {
    console.error("Failed to load history:", e);
  }
}

async function addToHistory(path: string, title: string): Promise<void> {
  const existing = history.findIndex((h) => h.path === path);
  if (existing !== -1) {
    history.splice(existing, 1);
  }

  history.unshift({
    path,
    title,
    progress: currentPage,
    totalPages,
    lastRead: Date.now(),
  });

  if (history.length > 20) {
    history = history.slice(0, 20);
  }

  try {
    localStorage.setItem("novel-reader-history", JSON.stringify(history));
    renderHistory();
  } catch (e) {
    console.error("Failed to save history:", e);
  }
}

function updateHistoryProgress(path: string, progress: number): void {
  const item = history.find((h) => h.path === path);
  if (!item) return;

  item.progress = progress;
  item.totalPages = totalPages;
  item.lastRead = Date.now();

  try {
    localStorage.setItem("novel-reader-history", JSON.stringify(history));
    renderHistory();
  } catch (e) {
    console.error("Failed to update history:", e);
  }
}

function renderHistory(): void {
  const historyList = document.getElementById("history-list");
  if (!historyList) return;

  const items = history
    .map((h, i) => {
      const base = h.totalPages && h.totalPages > 0 ? h.totalPages : 0;
      const percent = base > 0 ? Math.min(100, Math.round(((h.progress + 1) / base) * 100)) : 0;

      return `
    <div class="history-item" data-index="${i}">
      <div class="history-item-content">
        <div class="title">${h.title}</div>
        <div class="progress">${percent}%</div>
      </div>
      <button class="history-delete" data-index="${i}" title="删除">×</button>
    </div>
  `;
    })
    .join("");

  historyList.innerHTML = items || '<div class="toc-empty">暂无历史</div>';

  historyList.querySelectorAll(".history-item").forEach((el) => {
    el.addEventListener("click", async (e) => {
      if ((e.target as HTMLElement).classList.contains("history-delete")) return;
      const index = parseInt(el.getAttribute("data-index") || "0", 10);
      const item = history[index];
      if (!item) return;
      await loadBook(item.path);
      closeTocSidebar();
    });
  });

  historyList.querySelectorAll(".history-delete").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const index = parseInt(el.getAttribute("data-index") || "0", 10);
      deleteHistory(index);
    });
  });
}

function deleteHistory(index: number): void {
  if (index < 0 || index >= history.length) return;
  const item = history[index];
  if (item?.path) {
    try {
      localStorage.removeItem(`progress_${item.path}`);
    } catch (e) {
      console.error("Failed to clear progress cache:", e);
    }
  }
  history.splice(index, 1);
  try {
    localStorage.setItem("novel-reader-history", JSON.stringify(history));
    renderHistory();
  } catch (e) {
    console.error("Failed to delete history:", e);
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function syncSettingLabels(): void {
  const fontSizeValue = document.getElementById("font-size-value");
  const lineHeightValue = document.getElementById("line-height-value");
  const charsPerPageValue = document.getElementById("chars-per-page-value");
  const opacityValue = document.getElementById("opacity-value");
  const windowOpacityValue = document.getElementById("window-opacity-value");

  if (fontSizeValue) fontSizeValue.textContent = `${settings.fontSize}`;
  if (lineHeightValue) lineHeightValue.textContent = settings.lineHeight.toFixed(1);
  if (charsPerPageValue) charsPerPageValue.textContent = `${settings.charsPerPage}`;
  if (opacityValue) opacityValue.textContent = settings.opacity.toFixed(2);
  if (windowOpacityValue) windowOpacityValue.textContent = settings.windowOpacity.toFixed(1);
}

function initUI(): void {
  const btnMinimize = document.getElementById("btn-minimize");
  const btnClose = document.getElementById("btn-close");
  const btnOpen = document.getElementById("btn-open");
  const btnSettings = document.getElementById("btn-settings");
  const btnToggleSettings = document.getElementById("btn-toggle-settings");
  const settingsPanel = document.getElementById("settings-panel");
  const btnCloseSettings = document.getElementById("btn-close-settings");

  btnMinimize?.addEventListener("click", () => invoke("minimize_window"));
  btnClose?.addEventListener("click", () => invoke("close_window"));
  btnOpen?.addEventListener("click", openFile);

  btnSettings?.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPanel?.classList.toggle("show");
  });

  btnToggleSettings?.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPanel?.classList.toggle("show");
  });

  btnCloseSettings?.addEventListener("click", () => {
    settingsPanel?.classList.remove("show");
  });

  const btnToggleToc = document.getElementById("btn-toggle-toc");
  const btnTocTitle = document.getElementById("btn-toc-title");
  const btnHistoryTitle = document.getElementById("btn-history-title");

  btnToggleToc?.addEventListener("click", (e) => {
    e.stopPropagation();
    setReadingChromeVisible(true);
    ensureTocForCurrentBook();
    renderToc();
    const sidebar = document.getElementById("toc-sidebar");
    const isOpen = sidebar?.classList.contains("open");
    if (isOpen) {
      closeTocSidebar();
    } else {
      openTocSidebar(activeSidebarTab);
    }
  });

  btnTocTitle?.addEventListener("click", (e) => {
    e.stopPropagation();
    setReadingChromeVisible(true);
    ensureTocForCurrentBook();
    renderToc();
    openTocSidebar("toc");
  });

  btnHistoryTitle?.addEventListener("click", (e) => {
    e.stopPropagation();
    setReadingChromeVisible(true);
    openTocSidebar("history");
  });

  document.querySelectorAll(".toc-tab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      e.stopPropagation();
      const tabName = tab.getAttribute("data-tab") === "history" ? "history" : "toc";
      setSidebarTab(tabName);
    });
  });

  const fontSizeInput = document.getElementById("font-size") as HTMLInputElement;
  const lineHeightInput = document.getElementById("line-height") as HTMLInputElement;
  const charsPerPageInput = document.getElementById("chars-per-page") as HTMLInputElement;
  const opacityInput = document.getElementById("opacity") as HTMLInputElement;
  const fontFamilySelect = document.getElementById("font-family") as HTMLSelectElement;
  const textColorInput = document.getElementById("text-color") as HTMLInputElement;
  const windowOpacityInput = document.getElementById("window-opacity") as HTMLInputElement;
  const encodingSelect = document.getElementById("encoding") as HTMLSelectElement;
  const readingModeCheckbox = document.getElementById("reading-mode") as HTMLInputElement;
  const mouseModeCheckbox = document.getElementById("mouse-mode") as HTMLInputElement;

  if (fontSizeInput) {
    fontSizeInput.value = `${settings.fontSize}`;
    fontSizeInput.addEventListener("input", () => {
      settings.fontSize = parseInt(fontSizeInput.value, 10) || defaultSettings.fontSize;
      applySettings();
      syncSettingLabels();
      repaginateAndRender(true);
      saveSettings();
    });
  }

  if (lineHeightInput) {
    lineHeightInput.value = `${Math.round(settings.lineHeight * 10)}`;
    lineHeightInput.addEventListener("input", () => {
      settings.lineHeight = (parseInt(lineHeightInput.value, 10) || 16) / 10;
      applySettings();
      syncSettingLabels();
      saveSettings();
    });
  }

  if (charsPerPageInput) {
    charsPerPageInput.value = `${settings.charsPerPage}`;
    charsPerPageInput.addEventListener("input", () => {
      settings.charsPerPage = parseInt(charsPerPageInput.value, 10) || defaultSettings.charsPerPage;
      syncSettingLabels();
      repaginateAndRender(true);
      saveSettings();
    });
  }

  if (opacityInput) {
    opacityInput.value = `${Math.round(settings.opacity * 100)}`;
    opacityInput.addEventListener("input", () => {
      settings.opacity = (parseInt(opacityInput.value, 10) || 85) / 100;
      applySettings();
      syncSettingLabels();
      saveSettings();
    });
  }

  if (fontFamilySelect) {
    fontFamilySelect.value = settings.fontFamily;
    fontFamilySelect.addEventListener("change", () => {
      settings.fontFamily = fontFamilySelect.value;
      applySettings();
      saveSettings();
    });
  }

  if (textColorInput) {
    textColorInput.value = settings.textColor;
    textColorInput.addEventListener("input", () => {
      settings.textColor = textColorInput.value;
      applySettings();
      saveSettings();
    });
  }

  if (windowOpacityInput) {
    windowOpacityInput.value = `${Math.round(settings.windowOpacity * 100)}`;
    windowOpacityInput.addEventListener("input", () => {
      settings.windowOpacity = (parseInt(windowOpacityInput.value, 10) || 100) / 100;
      applySettings();
      syncSettingLabels();
      saveSettings();
    });
  }

  if (encodingSelect) {
    encodingSelect.value = settings.encoding;
    encodingSelect.addEventListener("change", () => {
      settings.encoding = encodingSelect.value;
      saveSettings();
    });
  }

  if (readingModeCheckbox) {
    readingModeCheckbox.checked = settings.readingMode;
    readingModeCheckbox.addEventListener("change", () => {
      settings.readingMode = readingModeCheckbox.checked;
      toggleReadingMode(settings.readingMode);
      saveSettings();
    });
  }

  if (mouseModeCheckbox) {
    mouseModeCheckbox.checked = settings.mouseMode;
    mouseModeCheckbox.addEventListener("change", () => {
      settings.mouseMode = mouseModeCheckbox.checked;
      toggleMouseMode(settings.mouseMode);
      saveSettings();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "F11") {
      e.preventDefault();
      toggleReadingMode(!isReadingMode);
      settings.readingMode = isReadingMode;
      if (readingModeCheckbox) readingModeCheckbox.checked = isReadingMode;
      saveSettings();
      return;
    }

    if (isEditableTarget(e.target)) return;

    if (e.key === "ArrowRight" || e.key === " " || e.key.toLowerCase() === "k") {
      e.preventDefault();
      nextPage();
    } else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "j") {
      e.preventDefault();
      prevPage();
    } else if (e.key === "Escape") {
      closeTocSidebar();
      settingsPanel?.classList.remove("show");
      setReadingChromeVisible(false);
    }
  });

  const readerArea = document.getElementById("reader-area");
  const readerControls = document.getElementById("reader-controls");
  const readerFooter = document.querySelector(".reader-footer") as HTMLElement | null;

  const keepReadingChromeVisible = () => {
    if (isReadingMode) {
      setReadingChromeVisible(true);
    }
  };
  const autoHideReadingChrome = () => {
    if (isReadingMode) {
      setReadingChromeVisible(true, 2500);
    }
  };

  readerControls?.addEventListener("mouseenter", keepReadingChromeVisible);
  readerControls?.addEventListener("mouseleave", autoHideReadingChrome);
  readerFooter?.addEventListener("mouseenter", keepReadingChromeVisible);
  readerFooter?.addEventListener("mouseleave", autoHideReadingChrome);

  readerArea?.addEventListener("contextmenu", (e) => {
    if (!isMouseMode) return;
    if ((e.target as HTMLElement).closest(".toc-sidebar, .reader-controls, .settings-panel")) return;
    e.preventDefault();
    prevPage();
  });

  readerArea?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".toc-sidebar, .reader-controls, .settings-panel")) return;

    const rect = readerArea.getBoundingClientRect();
    const relativeX = e.clientX - rect.left;
    const relativeY = e.clientY - rect.top;
    const normalizedX = relativeX / rect.width;
    const normalizedY = relativeY / rect.height;
    const inCenterArea =
      normalizedX >= 0.32 &&
      normalizedX <= 0.68 &&
      normalizedY >= 0.24 &&
      normalizedY <= 0.76;

    if (isReadingMode && inCenterArea) {
      const app = document.getElementById("app");
      const isVisible = app?.classList.contains("controls-visible");
      if (isVisible) {
        setReadingChromeVisible(false);
      } else {
        setReadingChromeVisible(true, 2800);
      }
      return;
    }

    if (!isMouseMode) return;

    if (relativeX > rect.width / 2) {
      nextPage();
    } else {
      prevPage();
    }
  });

  const app = document.getElementById("app");
  app?.addEventListener("mouseleave", () => {
    if (isMouseMode && isReadingMode) {
      app.classList.add("mouse-out");
    }
  });

  app?.addEventListener("mouseenter", () => {
    if (isMouseMode && isReadingMode) {
      app.classList.remove("mouse-out");
    }
  });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest("#settings-panel, #btn-settings, #btn-toggle-settings")) {
      settingsPanel?.classList.remove("show");
    }
    if (!target.closest("#toc-sidebar, #btn-toggle-toc, #btn-toc-title, #btn-history-title")) {
      closeTocSidebar();
    }
  });

  const btnExitReading = document.getElementById("btn-exit-reading");
  btnExitReading?.addEventListener("click", () => {
    toggleReadingMode(false);
    settings.readingMode = false;
    if (readingModeCheckbox) readingModeCheckbox.checked = false;
    saveSettings();
  });

  applySettings();
  syncSettingLabels();
  setSidebarTab("toc");

  if (settings.readingMode) {
    toggleReadingMode(true);
  }
  if (settings.mouseMode) {
    toggleMouseMode(true);
  }
}

async function setupGlobalShortcut(): Promise<void> {
  try {
    await register("Ctrl+Shift+H", async () => {
      await invoke("toggle_window");
    });
  } catch (e) {
    console.error("Failed to register global shortcut:", e);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  loadSettings();
  loadHistory();
  initUI();
  await setupGlobalShortcut();
});

