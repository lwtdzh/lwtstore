// Browser-side resilient downloader for Lwt's Store.
// Stores downloaded byte ranges in IndexedDB so interrupted page sessions can resume.

(function () {
  const DB_NAME = "lwt_download_cache";
  const DB_VERSION = 1;
  const CHUNK_STORE = "chunks";
  const STORAGE_KEY = "lwt_downloads";
  const ACTIVE_COOKIE = "lwt_download_active";
  const DEFAULT_THREADS = 3;
  const MAX_THREADS = 8;
  const CHUNK_SIZE = 2 * 1024 * 1024;

  const state = {
    tasks: new Map(),
    controllers: new Map(),
    dbPromise: null,
    tray: null,
    expanded: false,
    pinned: localStorage.getItem("lwt_download_tray_pinned") === "1",
  };

  window.lwtDownloadManager = {
    startDownload,
    expandTray,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDownloadManager);
  } else {
    initDownloadManager();
  }

  function initDownloadManager() {
    loadTasks();
    createTray();
    renderTray();

    document.addEventListener("click", () => {
      if (!state.pinned) collapseTray();
    });
  }

  async function startDownload(file) {
    const downloadFile = normalizeDownloadFile(file);
    if (!downloadFile.fileId || !downloadFile.url) {
      showDownloadToast("无法开始下载：文件信息不完整");
      return;
    }

    expandTray();

    let task = state.tasks.get(downloadFile.fileId);
    if (!task) {
      try {
        task = await createTask(downloadFile);
      } catch (err) {
        showDownloadToast(`无法开始下载: ${err.message}`);
        return;
      }
      state.tasks.set(task.id, task);
    }

    if (task.status !== "completed") {
      task.status = "running";
      task.error = "";
      task.retryMessage = "";
      task.updatedAt = new Date().toISOString();
      saveTasks();
      pumpTask(task);
    }

    renderTray();
  }

  function normalizeDownloadFile(file) {
    const url = file.downloadUrl
      ? new URL(file.downloadUrl, window.location.origin).toString()
      : "";

    return {
      fileId: file.fileId || extractFileId(url),
      fileName: file.fileName || "download.bin",
      fileSize: Number(file.fileSize || 0),
      url,
    };
  }

  function extractFileId(url) {
    const match = String(url || "").match(/\/api\/download\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  async function createTask(file) {
    const metadata = await resolveDownloadMetadata(file);
    const totalChunks = Math.max(1, Math.ceil(metadata.fileSize / CHUNK_SIZE));

    return {
      id: file.fileId,
      fileId: file.fileId,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      url: file.url,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      downloadedChunks: [],
      threads: DEFAULT_THREADS,
      status: "running",
      error: "",
      retryMessage: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async function resolveDownloadMetadata(file) {
    try {
      const res = await fetch(file.url, { method: "HEAD", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const size = Number(res.headers.get("Content-Length") || file.fileSize || 0);
      const contentDisposition = res.headers.get("Content-Disposition") || "";
      const name = parseContentDispositionFileName(contentDisposition) || file.fileName;

      return {
        fileName: name,
        fileSize: size,
      };
    } catch (err) {
      if (!file.fileSize) throw new Error(`无法读取下载信息: ${err.message}`);
      return {
        fileName: file.fileName,
        fileSize: file.fileSize,
      };
    }
  }

  function parseContentDispositionFileName(header) {
    const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (utfMatch) return decodeURIComponent(utfMatch[1].trim());

    const plainMatch = header.match(/filename="([^"]+)"/i);
    if (plainMatch) return decodeURIComponent(plainMatch[1].trim());

    return "";
  }

  function loadTasks() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      state.tasks = new Map(saved.map((task) => {
        const restored = {
          ...task,
          status: task.status === "running" ? "paused" : task.status,
          retryMessage: task.status === "running" ? "页面已重新打开，可继续下载" : task.retryMessage || "",
          downloadedChunks: Array.isArray(task.downloadedChunks) ? task.downloadedChunks : [],
        };
        return [restored.id, restored];
      }));
    } catch (err) {
      state.tasks = new Map();
    }
  }

  function saveTasks() {
    const serializable = Array.from(state.tasks.values()).map((task) => ({
      id: task.id,
      fileId: task.fileId,
      fileName: task.fileName,
      fileSize: task.fileSize,
      url: task.url,
      chunkSize: task.chunkSize,
      totalChunks: task.totalChunks,
      downloadedChunks: task.downloadedChunks,
      threads: task.threads,
      status: task.status,
      error: task.error || "",
      retryMessage: task.retryMessage || "",
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }));

    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));

    const activeIds = serializable
      .filter((task) => task.status !== "completed")
      .map((task) => task.id)
      .join(",");
    document.cookie = `${ACTIVE_COOKIE}=${encodeURIComponent(activeIds)}; path=/; max-age=2592000; SameSite=Lax`;
  }

  function getControllers(taskId) {
    if (!state.controllers.has(taskId)) {
      state.controllers.set(taskId, new Map());
    }
    return state.controllers.get(taskId);
  }

  function pumpTask(task) {
    if (task.status !== "running") return;

    const controllers = getControllers(task.id);
    while (controllers.size < task.threads) {
      const nextChunk = findNextChunk(task, controllers);
      if (nextChunk === -1) break;
      downloadChunk(task, nextChunk);
    }

    if (controllers.size === 0 && task.downloadedChunks.length >= task.totalChunks) {
      completeTask(task);
    }
  }

  function findNextChunk(task, controllers) {
    const done = new Set(task.downloadedChunks);
    for (let index = 0; index < task.totalChunks; index++) {
      if (!done.has(index) && !controllers.has(index)) return index;
    }
    return -1;
  }

  async function downloadChunk(task, chunkIndex) {
    const controllers = getControllers(task.id);
    const controller = new AbortController();
    controllers.set(chunkIndex, controller);
    renderTray();

    try {
      const blob = await fetchChunkWithRetry(task, chunkIndex, controller.signal);
      if (task.status !== "running") return;

      await putChunk(task.id, chunkIndex, blob);
      if (!task.downloadedChunks.includes(chunkIndex)) {
        task.downloadedChunks.push(chunkIndex);
        task.downloadedChunks.sort((a, b) => a - b);
      }
      task.retryMessage = "";
      task.updatedAt = new Date().toISOString();

      if (task.downloadedChunks.length >= task.totalChunks) {
        completeTask(task);
      } else {
        saveTasks();
        renderTray();
        pumpTask(task);
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        task.status = "paused";
        task.error = err.message;
        saveTasks();
        renderTray();
      }
    } finally {
      controllers.delete(chunkIndex);
      if (task.status === "running") pumpTask(task);
      renderTray();
    }
  }

  async function fetchChunkWithRetry(task, chunkIndex, signal) {
    const start = chunkIndex * task.chunkSize;
    const end = Math.min(start + task.chunkSize, task.fileSize) - 1;
    const expectedSize = end - start + 1;
    let attempt = 0;

    while (true) {
      try {
        const res = await fetch(task.url, {
          headers: { Range: `bytes=${start}-${end}` },
          cache: "no-store",
          signal,
        });

        if (!(res.status === 206 || (res.status === 200 && start === 0))) {
          throw new Error(`HTTP ${res.status}`);
        }

        const blob = await res.blob();
        if (blob.size !== expectedSize && !(res.status === 200 && blob.size === task.fileSize)) {
          throw new Error(`分片大小异常: ${blob.size}/${expectedSize}`);
        }

        return blob;
      } catch (err) {
        if (signal.aborted) throw new DOMException("Download paused", "AbortError");

        attempt++;
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        task.retryMessage = `分片 ${chunkIndex + 1} 失败(${err.message})，${Math.round(backoffMs / 1000)}秒后重试`;
        saveTasks();
        renderTray();
        await sleep(backoffMs, signal);
      }
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Download paused", "AbortError"));
      }, { once: true });
    });
  }

  function completeTask(task) {
    task.status = "completed";
    task.error = "";
    task.retryMessage = "";
    task.updatedAt = new Date().toISOString();
    saveTasks();
    renderTray();
    showDownloadToast(`${task.fileName} 已下载到浏览器缓存`);
  }

  function pauseTask(taskId) {
    const task = state.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    task.status = "paused";
    task.retryMessage = "已暂停";
    abortTaskControllers(taskId);
    saveTasks();
    renderTray();
  }

  function resumeTask(taskId) {
    const task = state.tasks.get(taskId);
    if (!task || task.status === "completed") return;

    task.status = "running";
    task.error = "";
    task.retryMessage = "";
    saveTasks();
    renderTray();
    pumpTask(task);
  }

  async function cancelTask(taskId) {
    abortTaskControllers(taskId);
    await deleteChunks(taskId);
    state.tasks.delete(taskId);
    saveTasks();
    renderTray();
  }

  function abortTaskControllers(taskId) {
    const controllers = getControllers(taskId);
    controllers.forEach((controller) => controller.abort());
    controllers.clear();
  }

  function setTaskThreads(taskId, value) {
    const task = state.tasks.get(taskId);
    if (!task) return;

    task.threads = Math.min(MAX_THREADS, Math.max(1, parseInt(value, 10) || DEFAULT_THREADS));
    saveTasks();
    renderTray();
    if (task.status === "running") pumpTask(task);
  }

  async function saveCompletedTask(taskId) {
    const task = state.tasks.get(taskId);
    if (!task || task.status !== "completed") return;

    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: task.fileName,
        });
        const writable = await handle.createWritable();
        for (let index = 0; index < task.totalChunks; index++) {
          const chunk = await getChunk(task.id, index);
          if (!chunk) throw new Error(`缺少分片 ${index + 1}`);
          await writable.write(chunk.blob);
        }
        await writable.close();
      } else {
        const chunks = [];
        for (let index = 0; index < task.totalChunks; index++) {
          const chunk = await getChunk(task.id, index);
          if (!chunk) throw new Error(`缺少分片 ${index + 1}`);
          chunks.push(chunk.blob);
        }
        const blob = new Blob(chunks, { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = task.fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }

      showDownloadToast("文件已保存");
    } catch (err) {
      showDownloadToast(`保存失败: ${err.message}`);
    }
  }

  function createTray() {
    const tray = document.createElement("div");
    tray.id = "downloadTray";
    tray.className = "download-tray";
    tray.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(tray);
    state.tray = tray;
  }

  function expandTray() {
    state.expanded = true;
    renderTray();
  }

  function collapseTray() {
    if (state.pinned) return;
    state.expanded = false;
    renderTray();
  }

  function renderTray() {
    if (!state.tray) return;

    const tasks = Array.from(state.tasks.values())
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const activeCount = tasks.filter((task) => task.status !== "completed").length;
    const completedCount = tasks.filter((task) => task.status === "completed").length;

    state.tray.className = `download-tray${state.expanded || state.pinned ? " expanded" : ""}`;
    state.tray.innerHTML = `
      <button class="download-tray-toggle" id="downloadTrayToggle" type="button">
        <span>下载</span>
        <span class="download-count">${activeCount + completedCount}</span>
      </button>
      <div class="download-tray-panel">
        <div class="download-tray-header">
          <strong>下载任务</strong>
          <button class="download-pin${state.pinned ? " active" : ""}" id="downloadPinBtn" type="button" title="固定下载面板">图钉</button>
        </div>
        <div class="download-tray-list">
          ${tasks.length === 0 ? "<div class=\"download-empty\">暂无下载任务</div>" : tasks.map(renderTask).join("")}
        </div>
      </div>
    `;

    state.tray.querySelector("#downloadTrayToggle").addEventListener("click", () => {
      state.expanded = !state.expanded;
      renderTray();
    });

    state.tray.querySelector("#downloadPinBtn").addEventListener("click", () => {
      state.pinned = !state.pinned;
      localStorage.setItem("lwt_download_tray_pinned", state.pinned ? "1" : "0");
      if (state.pinned) state.expanded = true;
      renderTray();
    });

    state.tray.querySelectorAll("[data-download-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const taskId = button.getAttribute("data-download-id");
        const action = button.getAttribute("data-download-action");

        if (action === "pause") pauseTask(taskId);
        if (action === "resume") resumeTask(taskId);
        if (action === "cancel") await cancelTask(taskId);
        if (action === "save") await saveCompletedTask(taskId);
      });
    });

    state.tray.querySelectorAll(".download-thread-select").forEach((select) => {
      select.addEventListener("change", () => {
        setTaskThreads(select.getAttribute("data-download-id"), select.value);
      });
    });
  }

  function renderTask(task) {
    const percent = task.fileSize > 0
      ? Math.round((getDownloadedBytes(task) / task.fileSize) * 100)
      : 0;
    const isRunning = task.status === "running";
    const isCompleted = task.status === "completed";
    const statusText = getStatusText(task);

    return `
      <div class="download-item" data-task-status="${task.status}">
        <div class="download-item-top">
          <div class="download-name" title="${escapeHtml(task.fileName)}">${escapeHtml(task.fileName)}</div>
          <div class="download-percent">${Math.min(100, percent)}%</div>
        </div>
        <div class="download-progress-bar">
          <div class="download-progress-fill" style="width: ${Math.min(100, percent)}%"></div>
        </div>
        <div class="download-meta">
          <span>${formatSize(getDownloadedBytes(task))} / ${formatSize(task.fileSize)}</span>
          <span>${statusText}</span>
        </div>
        ${task.retryMessage ? `<div class="download-retry">${escapeHtml(task.retryMessage)}</div>` : ""}
        <div class="download-controls">
          <label>线程
            <select class="download-thread-select" data-download-id="${task.id}" ${isCompleted ? "disabled" : ""}>
              ${renderThreadOptions(task.threads)}
            </select>
          </label>
          ${isCompleted
            ? `<button class="btn btn-copy-small" type="button" data-download-action="save" data-download-id="${task.id}">保存</button>
               <button class="btn btn-new" type="button" data-download-action="cancel" data-download-id="${task.id}">移除</button>`
            : `<button class="btn btn-copy-small" type="button" data-download-action="${isRunning ? "pause" : "resume"}" data-download-id="${task.id}">${isRunning ? "暂停" : "继续"}</button>
               <button class="btn btn-delete" type="button" data-download-action="cancel" data-download-id="${task.id}">取消</button>`}
        </div>
      </div>
    `;
  }

  function renderThreadOptions(currentThreads) {
    let html = "";
    for (let i = 1; i <= MAX_THREADS; i++) {
      html += `<option value="${i}"${i === currentThreads ? " selected" : ""}>${i}</option>`;
    }
    return html;
  }

  function getStatusText(task) {
    if (task.status === "completed") return "已缓存";
    if (task.status === "running") return `下载中 · ${getControllers(task.id).size}/${task.threads}`;
    if (task.status === "paused") return "已暂停";
    return task.error || "等待中";
  }

  function getDownloadedBytes(task) {
    return task.downloadedChunks.reduce((sum, index) => sum + getChunkSize(task, index), 0);
  }

  function getChunkSize(task, index) {
    const start = index * task.chunkSize;
    return Math.max(0, Math.min(task.chunkSize, task.fileSize - start));
  }

  function openDb() {
    if (state.dbPromise) return state.dbPromise;

    state.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const store = db.createObjectStore(CHUNK_STORE, { keyPath: "key" });
          store.createIndex("downloadId", "downloadId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return state.dbPromise;
  }

  async function putChunk(downloadId, index, blob) {
    const db = await openDb();
    return runStoreRequest(db, "readwrite", (store) => store.put({
      key: `${downloadId}:${index}`,
      downloadId,
      index,
      blob,
      size: blob.size,
    }));
  }

  async function getChunk(downloadId, index) {
    const db = await openDb();
    return runStoreRequest(db, "readonly", (store) => store.get(`${downloadId}:${index}`));
  }

  async function deleteChunks(downloadId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, "readwrite");
      const index = tx.objectStore(CHUNK_STORE).index("downloadId");
      const cursorRequest = index.openCursor(IDBKeyRange.only(downloadId));

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function runStoreRequest(db, mode, createRequest) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, mode);
      const request = createRequest(tx.objectStore(CHUNK_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str || "");
    return div.innerHTML;
  }

  function formatSize(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${units[i]}`;
  }

  function showDownloadToast(message) {
    if (typeof window.showToast === "function") {
      window.showToast(message);
      return;
    }

    const toast = document.createElement("div");
    toast.className = "toast show";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }
})();
