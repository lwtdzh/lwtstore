// Browser-side transfer manager for Lwt's Store.
// Downloads store byte ranges in IndexedDB. Uploads store resumable metadata
// and require the user to select the same local file after a page reload.

(function () {
  const DB_NAME = "lwt_download_cache";
  const DB_VERSION = 1;
  const CHUNK_STORE = "chunks";
  const TRANSFER_STORAGE_KEY = "lwt_downloads";
  const UPLOAD_STORAGE_KEY = "lwt_uploads";
  const DOWNLOAD_ACTIVE_COOKIE = "lwt_download_active";
  const UPLOAD_ACTIVE_COOKIE = "lwt_upload_active";
  const DEFAULT_THREADS = 3;
  const MAX_THREADS = 8;
  const CHUNK_SIZE = 2 * 1024 * 1024;
  const RETRY_WAIT_MS = 1000;
  const SPEED_SAMPLE_MS = 500;

  const state = {
    tasks: new Map(),
    controllers: new Map(),
    dbPromise: null,
    tray: null,
    expanded: false,
    pinned: localStorage.getItem("lwt_download_tray_pinned") === "1",
  };

  const api = {
    startDownload,
    startUploadTask,
    updateUploadTask,
    pauseUploadTask,
    completeUploadTask,
    expandTray,
  };

  window.lwtTransferManager = api;
  window.lwtDownloadManager = api;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTransferManager);
  } else {
    initTransferManager();
  }

  function initTransferManager() {
    loadTasks();
    createTray();
    renderTray();

    document.addEventListener("click", (event) => {
      if (!state.pinned && !isTrayInteraction(event)) collapseTray();
    });
  }

  async function startDownload(file) {
    const downloadFile = normalizeDownloadFile(file);
    if (!downloadFile.fileId || !downloadFile.url) {
      showTransferToast("无法开始下载：文件信息不完整");
      return;
    }

    expandTray();

    let task = state.tasks.get(downloadFile.fileId);
    if (!task) {
      try {
        task = await createDownloadTask(downloadFile);
      } catch (err) {
        showTransferToast(`无法开始下载: ${err.message}`);
        return;
      }
      state.tasks.set(task.id, task);
    }

    if (task.status !== "completed") {
      task.status = "running";
      task.error = "";
      task.retryMessage = "";
      task.updatedAt = new Date().toISOString();
      resetTransferSpeed(task, getTransferredBytes(task));
      saveTasks();
      pumpDownloadTask(task);
    }

    renderTray();
  }

  function startUploadTask(file) {
    if (!file.fileHash) return;

    const id = uploadTaskId(file.fileHash);
    let task = state.tasks.get(id);
    const now = new Date().toISOString();

    if (!task) {
      task = {
        type: "upload",
        id,
        fileHash: file.fileHash,
        fileId: file.fileId || "",
        fileName: file.fileName || "upload.bin",
        fileSize: Number(file.fileSize || 0),
        fileLastModified: file.lastModified || null,
        partSize: file.partSize || 0,
        totalParts: file.totalParts || 0,
        uploadedParts: [],
        uploadedBytes: 0,
        status: "running",
        retryMessage: "",
        error: "",
        downloadUrl: "",
        createdAt: now,
        updatedAt: now,
      };
      state.tasks.set(id, task);
    }

    Object.assign(task, {
      fileName: file.fileName || task.fileName,
      fileSize: Number(file.fileSize || task.fileSize || 0),
      fileLastModified: file.lastModified || task.fileLastModified || null,
      status: "running",
      retryMessage: "",
      error: "",
      updatedAt: now,
    });
    resetTransferSpeed(task, getTransferredBytes(task));

    saveTasks();
    expandTray();
    renderTray();
  }

  function updateUploadTask(fileHash, patch = {}) {
    const task = getUploadTask(fileHash);
    if (!task) return;

    Object.assign(task, patch, {
      type: "upload",
      status: patch.status || task.status || "running",
      updatedAt: new Date().toISOString(),
    });

    if (Array.isArray(patch.uploadedParts)) {
      task.uploadedParts = [...new Set(patch.uploadedParts)].sort((a, b) => a - b);
    }

    const hasUploadedBytes = Object.prototype.hasOwnProperty.call(patch, "uploadedBytes");
    if (task.status === "running" && hasUploadedBytes) {
      updateTransferSpeed(task, getTransferredBytes(task));
    } else if (task.status !== "running" || Object.prototype.hasOwnProperty.call(patch, "retryMessage")) {
      clearTransferSpeed(task);
    }

    saveTasks();
    renderTray();
  }

  function pauseUploadTask(fileHash, message = "已暂停，请选择同一文件继续上传") {
    const task = getUploadTask(fileHash);
    if (!task) return;

    task.status = "needs-file";
    task.retryMessage = message;
    task.updatedAt = new Date().toISOString();
    clearTransferSpeed(task);
    saveTasks();
    renderTray();
  }

  function completeUploadTask(fileHash, patch = {}) {
    const task = getUploadTask(fileHash);
    if (!task) return;

    Object.assign(task, patch, {
      status: "completed",
      uploadedBytes: task.fileSize,
      retryMessage: "",
      error: "",
      updatedAt: new Date().toISOString(),
    });
    clearTransferSpeed(task);
    saveTasks();
    renderTray();
    showTransferToast(`${task.fileName} 上传完成`);
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

  function uploadTaskId(fileHash) {
    return `upload:${fileHash}`;
  }

  function getUploadTask(fileHash) {
    return state.tasks.get(uploadTaskId(fileHash));
  }

  async function createDownloadTask(file) {
    const metadata = await resolveDownloadMetadata(file);
    const totalChunks = Math.max(1, Math.ceil(metadata.fileSize / CHUNK_SIZE));

    return {
      type: "download",
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
      const saved = JSON.parse(localStorage.getItem(TRANSFER_STORAGE_KEY) || "[]");
      state.tasks = new Map(saved.map((task) => {
        const type = task.type || "download";
        const restored = {
          ...task,
          type,
          status: task.status === "running" ? (type === "upload" ? "needs-file" : "paused") : task.status,
          retryMessage: task.status === "running"
            ? (type === "upload" ? "页面已重新打开，请选择同一文件继续上传" : "页面已重新打开，可继续下载")
            : task.retryMessage || "",
          downloadedChunks: Array.isArray(task.downloadedChunks) ? task.downloadedChunks : [],
          uploadedParts: Array.isArray(task.uploadedParts) ? task.uploadedParts : [],
        };
        resetTransferSpeed(restored, getTransferredBytes(restored), 0);
        return [restored.id, restored];
      }));
    } catch (err) {
      state.tasks = new Map();
    }

    loadLegacyUploadTasks();
  }

  function loadLegacyUploadTasks() {
    try {
      const uploads = JSON.parse(localStorage.getItem(UPLOAD_STORAGE_KEY) || "{}");
      for (const [fileHash, upload] of Object.entries(uploads)) {
        const id = uploadTaskId(fileHash);
        if (state.tasks.has(id)) continue;

        const restored = {
          type: "upload",
          id,
          fileHash,
          fileId: upload.fileId || "",
          fileName: upload.fileName || "upload.bin",
          fileSize: Number(upload.fileSize || 0),
          fileLastModified: upload.lastModified || null,
          partSize: upload.partSize || 0,
          totalParts: upload.totalParts || 0,
          uploadedParts: Array.isArray(upload.uploadedParts) ? upload.uploadedParts : [],
          uploadedBytes: upload.uploadedBytes || 0,
          status: upload.status === "completed" ? "completed" : "needs-file",
          retryMessage: "请选择同一文件继续上传",
          error: "",
          downloadUrl: upload.downloadUrl || "",
          createdAt: upload.createdAt || new Date().toISOString(),
          updatedAt: upload.updatedAt || new Date().toISOString(),
        };
        resetTransferSpeed(restored, getTransferredBytes(restored), 0);
        state.tasks.set(id, restored);
      }
    } catch (err) {
      // Ignore corrupt legacy upload state.
    }
  }

  function saveTasks() {
    const serializable = Array.from(state.tasks.values()).map((task) => ({
      type: task.type || "download",
      id: task.id,
      fileId: task.fileId,
      fileHash: task.fileHash,
      fileName: task.fileName,
      fileSize: task.fileSize,
      fileLastModified: task.fileLastModified || null,
      url: task.url,
      downloadUrl: task.downloadUrl || "",
      chunkSize: task.chunkSize,
      totalChunks: task.totalChunks,
      downloadedChunks: task.downloadedChunks,
      threads: task.threads,
      partSize: task.partSize,
      totalParts: task.totalParts,
      uploadedParts: task.uploadedParts,
      uploadedBytes: task.uploadedBytes || 0,
      status: task.status,
      error: task.error || "",
      retryMessage: task.retryMessage || "",
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }));

    localStorage.setItem(TRANSFER_STORAGE_KEY, JSON.stringify(serializable));
    syncLegacyUploadState(serializable);

    const activeDownloadIds = serializable
      .filter((task) => (task.type || "download") === "download" && task.status !== "completed")
      .map((task) => task.id)
      .join(",");
    document.cookie = `${DOWNLOAD_ACTIVE_COOKIE}=${encodeURIComponent(activeDownloadIds)}; path=/; max-age=2592000; SameSite=Lax`;
  }

  function syncLegacyUploadState(tasks) {
    const uploads = {};
    const activeUploadHashes = [];

    for (const task of tasks) {
      if (task.type !== "upload" || task.status === "completed") continue;

      uploads[task.fileHash] = {
        fileId: task.fileId || "",
        fileName: task.fileName,
        fileSize: task.fileSize,
        lastModified: task.fileLastModified || null,
        partSize: task.partSize || 0,
        totalParts: task.totalParts || 0,
        uploadedParts: Array.isArray(task.uploadedParts) ? task.uploadedParts : [],
        uploadedBytes: task.uploadedBytes || 0,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
      activeUploadHashes.push(task.fileHash);
    }

    localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(uploads));
    if (activeUploadHashes.length > 0) {
      document.cookie = `${UPLOAD_ACTIVE_COOKIE}=${encodeURIComponent(activeUploadHashes[0])}; path=/; max-age=2592000; SameSite=Lax`;
    } else {
      document.cookie = `${UPLOAD_ACTIVE_COOKIE}=; path=/; max-age=0`;
    }
  }

  function getControllers(taskId) {
    if (!state.controllers.has(taskId)) {
      state.controllers.set(taskId, new Map());
    }
    return state.controllers.get(taskId);
  }

  function pumpDownloadTask(task) {
    if (task.status !== "running") return;

    const controllers = getControllers(task.id);
    while (controllers.size < task.threads) {
      const nextChunk = findNextDownloadChunk(task, controllers);
      if (nextChunk === -1) break;
      downloadChunk(task, nextChunk);
    }

    if (controllers.size === 0 && task.downloadedChunks.length >= task.totalChunks) {
      completeDownloadTask(task);
    }
  }

  function findNextDownloadChunk(task, controllers) {
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
      updateTransferSpeed(task, getTransferredBytes(task));
      task.retryMessage = "";
      task.updatedAt = new Date().toISOString();

      if (task.downloadedChunks.length >= task.totalChunks) {
        completeDownloadTask(task);
      } else {
        saveTasks();
        renderTray();
        pumpDownloadTask(task);
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
      if (task.status === "running") pumpDownloadTask(task);
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
        const backoffMs = RETRY_WAIT_MS;
        task.retryMessage = `分片 ${chunkIndex + 1} 失败(${err.message})，${Math.round(backoffMs / 1000)}秒后重试`;
        clearTransferSpeed(task);
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

  function completeDownloadTask(task) {
    task.status = "completed";
    task.error = "";
    task.retryMessage = "";
    task.updatedAt = new Date().toISOString();
    clearTransferSpeed(task);
    saveTasks();
    renderTray();
    showTransferToast(`${task.fileName} 已下载到浏览器缓存`);
  }

  function pauseDownloadTask(taskId) {
    const task = state.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    task.status = "paused";
    task.retryMessage = "已暂停";
    clearTransferSpeed(task);
    abortTaskControllers(taskId);
    saveTasks();
    renderTray();
  }

  function resumeDownloadTask(taskId) {
    const task = state.tasks.get(taskId);
    if (!task || task.status === "completed") return;

    task.status = "running";
    task.error = "";
    task.retryMessage = "";
    resetTransferSpeed(task, getTransferredBytes(task));
    saveTasks();
    renderTray();
    pumpDownloadTask(task);
  }

  async function removeTask(taskId) {
    const task = state.tasks.get(taskId);
    if (!task) return;

    if ((task.type || "download") === "download") {
      abortTaskControllers(taskId);
      await deleteChunks(taskId);
    } else if (task.status === "running" && window.lwtUploadControls) {
      window.lwtUploadControls.cancelUpload(task.fileHash);
    }

    state.tasks.delete(taskId);
    saveTasks();
    renderTray();
  }

  function abortTaskControllers(taskId) {
    const controllers = getControllers(taskId);
    controllers.forEach((controller) => controller.abort());
    controllers.clear();
  }

  function setDownloadThreads(taskId, value) {
    const task = state.tasks.get(taskId);
    if (!task) return;

    task.threads = Math.min(MAX_THREADS, Math.max(1, parseInt(value, 10) || DEFAULT_THREADS));
    saveTasks();
    renderTray();
    if (task.status === "running") pumpDownloadTask(task);
  }

  function getTransferredBytes(task) {
    return (task.type || "download") === "upload"
      ? Math.min(task.fileSize || 0, task.uploadedBytes || 0)
      : getDownloadedBytes(task);
  }

  function resetTransferSpeed(task, transferredBytes = 0, timestamp = Date.now()) {
    if (!task) return;

    task.speedBytesPerSecond = 0;
    task.speedLastBytes = Number(transferredBytes || 0);
    task.speedLastTime = timestamp;
  }

  function clearTransferSpeed(task) {
    if (!task) return;

    task.speedBytesPerSecond = 0;
    task.speedLastBytes = getTransferredBytes(task);
    task.speedLastTime = 0;
  }

  function updateTransferSpeed(task, transferredBytes) {
    if (!task) return;

    const now = Date.now();
    const currentBytes = Number(transferredBytes || 0);
    if (!task.speedLastTime) {
      resetTransferSpeed(task, currentBytes, now);
      return;
    }

    const elapsedMs = now - task.speedLastTime;
    if (elapsedMs < SPEED_SAMPLE_MS) return;

    const bytesDelta = Math.max(0, currentBytes - Number(task.speedLastBytes || 0));
    const instantSpeed = elapsedMs > 0 ? (bytesDelta / elapsedMs) * 1000 : 0;
    task.speedBytesPerSecond = task.speedBytesPerSecond > 0
      ? 0.3 * instantSpeed + 0.7 * task.speedBytesPerSecond
      : instantSpeed;
    task.speedLastBytes = currentBytes;
    task.speedLastTime = now;
  }

  function getSpeedDisplay(task, transferredBytes) {
    if (task.status !== "running") return "";

    const speed = Number(task.speedBytesPerSecond || 0);
    if (speed <= 0) return "速度 计算中";

    const remaining = Math.max(0, (task.fileSize || 0) - transferredBytes);
    const eta = remaining > 0 ? ` · ${formatEta(remaining / speed)}` : "";
    return `速度 ${formatSpeed(speed)}${eta}`;
  }

  async function saveCompletedDownload(taskId) {
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

      showTransferToast("文件已保存");
    } catch (err) {
      showTransferToast(`保存失败: ${err.message}`);
    }
  }

  function copyUploadLink(taskId) {
    const task = state.tasks.get(taskId);
    if (!task || !task.downloadUrl) return;

    const url = new URL(task.downloadUrl, window.location.origin).toString();
    navigator.clipboard.writeText(url).then(() => {
      showTransferToast("链接已复制到剪贴板！");
    }).catch(() => {
      showTransferToast("复制失败");
    });
  }

  function chooseUploadFile(taskId) {
    const task = state.tasks.get(taskId);
    if (!task || !window.lwtUploadControls) return;

    window.lwtUploadControls.chooseFile(task.fileHash);
  }

  function pauseRunningUpload(taskId) {
    const task = state.tasks.get(taskId);
    if (!task || !window.lwtUploadControls) return;

    window.lwtUploadControls.cancelUpload(task.fileHash);
    pauseUploadTask(task.fileHash);
  }

  function createTray() {
    const tray = document.createElement("div");
    tray.id = "downloadTray";
    tray.className = "download-tray";
    ["pointerdown", "mousedown", "touchstart", "click"].forEach((eventName) => {
      tray.addEventListener(eventName, (event) => event.stopPropagation());
    });
    tray.addEventListener("focusin", () => {
      state.expanded = true;
      tray.classList.add("expanded");
    });
    document.body.appendChild(tray);
    state.tray = tray;
  }

  function isTrayInteraction(event) {
    if (!state.tray) return false;
    if (event.composedPath && event.composedPath().includes(state.tray)) return true;
    if (state.tray.contains(event.target)) return true;
    return state.tray.contains(document.activeElement);
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
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    const activeCount = tasks.filter((task) => task.status !== "completed").length;
    const completedCount = tasks.filter((task) => task.status === "completed").length;

    state.tray.className = `download-tray${state.expanded || state.pinned ? " expanded" : ""}`;
    state.tray.innerHTML = `
      <button class="download-tray-toggle" id="downloadTrayToggle" type="button">
        <span>传输</span>
        <span class="download-count">${activeCount + completedCount}</span>
      </button>
      <div class="download-tray-panel">
        <div class="download-tray-header">
          <strong>传输任务</strong>
          <button class="download-pin${state.pinned ? " active" : ""}" id="downloadPinBtn" type="button" title="固定传输面板">图钉</button>
        </div>
        <div class="download-tray-list">
          ${tasks.length === 0 ? "<div class=\"download-empty\">暂无传输任务</div>" : tasks.map(renderTask).join("")}
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
        const task = state.tasks.get(taskId);
        const type = task?.type || "download";

        if (type === "download") {
          if (action === "pause") pauseDownloadTask(taskId);
          if (action === "resume") resumeDownloadTask(taskId);
          if (action === "cancel") await removeTask(taskId);
          if (action === "save") await saveCompletedDownload(taskId);
          return;
        }

        if (action === "pause") pauseRunningUpload(taskId);
        if (action === "resume") chooseUploadFile(taskId);
        if (action === "cancel") await removeTask(taskId);
        if (action === "copy") copyUploadLink(taskId);
      });
    });

    state.tray.querySelectorAll(".download-thread-select").forEach((select) => {
      ["pointerdown", "mousedown", "touchstart", "click"].forEach((eventName) => {
        select.addEventListener(eventName, (event) => event.stopPropagation());
      });
      select.addEventListener("focus", () => {
        state.expanded = true;
        state.tray.classList.add("expanded");
      });
      select.addEventListener("change", () => {
        setDownloadThreads(select.getAttribute("data-download-id"), select.value);
      });
    });
  }

  function renderTask(task) {
    return (task.type || "download") === "upload" ? renderUploadTask(task) : renderDownloadTask(task);
  }

  function renderDownloadTask(task) {
    const downloadedBytes = getDownloadedBytes(task);
    const percent = task.fileSize > 0
      ? Math.round((downloadedBytes / task.fileSize) * 100)
      : 0;
    const isRunning = task.status === "running";
    const isCompleted = task.status === "completed";
    const statusText = getDownloadStatusText(task);
    const speedText = getSpeedDisplay(task, downloadedBytes);

    return `
      <div class="download-item" data-task-status="${task.status}" data-task-type="download">
        <div class="download-item-top">
          <div class="download-name" title="${escapeAttr(task.fileName)}"><span class="transfer-kind">下载</span>${escapeHtml(task.fileName)}</div>
          <div class="download-percent">${Math.min(100, percent)}%</div>
        </div>
        <div class="download-progress-bar">
          <div class="download-progress-fill" style="width: ${Math.min(100, percent)}%"></div>
        </div>
        <div class="download-meta">
          <span>${formatSize(downloadedBytes)} / ${formatSize(task.fileSize)}</span>
          <span>${statusText}</span>
        </div>
        ${speedText ? `<div class="transfer-speed">${escapeHtml(speedText)}</div>` : ""}
        ${task.retryMessage ? `<div class="download-retry">${escapeHtml(task.retryMessage)}</div>` : ""}
        <div class="download-controls">
          <label>线程
            <select class="download-thread-select" data-download-id="${escapeAttr(task.id)}" ${isCompleted ? "disabled" : ""}>
              ${renderThreadOptions(task.threads)}
            </select>
          </label>
          ${isCompleted
            ? `<button class="btn btn-copy-small" type="button" data-download-action="save" data-download-id="${escapeAttr(task.id)}">保存</button>
               <button class="btn btn-new" type="button" data-download-action="cancel" data-download-id="${escapeAttr(task.id)}">移除</button>`
            : `<button class="btn btn-copy-small" type="button" data-download-action="${isRunning ? "pause" : "resume"}" data-download-id="${escapeAttr(task.id)}">${isRunning ? "暂停" : "继续"}</button>
               <button class="btn btn-delete" type="button" data-download-action="cancel" data-download-id="${escapeAttr(task.id)}">取消</button>`}
        </div>
      </div>
    `;
  }

  function renderUploadTask(task) {
    const transferredBytes = Math.min(task.fileSize || 0, task.uploadedBytes || 0);
    const percent = task.fileSize > 0 ? Math.round((transferredBytes / task.fileSize) * 100) : 0;
    const isRunning = task.status === "running";
    const isCompleted = task.status === "completed";
    const statusText = getUploadStatusText(task);
    const speedText = getSpeedDisplay(task, transferredBytes);

    return `
      <div class="download-item" data-task-status="${task.status}" data-task-type="upload">
        <div class="download-item-top">
          <div class="download-name" title="${escapeAttr(task.fileName)}"><span class="transfer-kind upload-kind">上传</span>${escapeHtml(task.fileName)}</div>
          <div class="download-percent">${Math.min(100, percent)}%</div>
        </div>
        <div class="download-progress-bar">
          <div class="download-progress-fill upload-progress-fill" style="width: ${Math.min(100, percent)}%"></div>
        </div>
        <div class="download-meta">
          <span>${formatSize(transferredBytes)} / ${formatSize(task.fileSize)}</span>
          <span>${statusText}</span>
        </div>
        ${speedText ? `<div class="transfer-speed">${escapeHtml(speedText)}</div>` : ""}
        ${task.retryMessage ? `<div class="download-retry">${escapeHtml(task.retryMessage)}</div>` : ""}
        <div class="download-controls">
          ${isCompleted
            ? `${task.downloadUrl ? `<button class="btn btn-copy-small" type="button" data-download-action="copy" data-download-id="${escapeAttr(task.id)}">复制链接</button>` : ""}
               <button class="btn btn-new" type="button" data-download-action="cancel" data-download-id="${escapeAttr(task.id)}">移除</button>`
            : `<button class="btn btn-copy-small" type="button" data-download-action="${isRunning ? "pause" : "resume"}" data-download-id="${escapeAttr(task.id)}">${isRunning ? "暂停" : "选择同一文件继续"}</button>
               <button class="btn btn-delete" type="button" data-download-action="cancel" data-download-id="${escapeAttr(task.id)}">取消</button>`}
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

  function getDownloadStatusText(task) {
    if (task.status === "completed") return "已缓存";
    if (task.status === "running") return `下载中 · ${getControllers(task.id).size}/${task.threads}`;
    if (task.status === "paused") return "已暂停";
    return task.error || "等待中";
  }

  function getUploadStatusText(task) {
    if (task.status === "completed") return "已上传";
    if (task.status === "running") {
      const total = task.totalParts || "?";
      const done = Array.isArray(task.uploadedParts) ? task.uploadedParts.length : 0;
      return `上传中 · ${done}/${total}`;
    }
    if (task.status === "needs-file") return "等待同一文件";
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

  function escapeAttr(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatSize(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${units[i]}`;
  }

  function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond) return "0 B/s";
    if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return "";
    if (seconds < 60) return `剩余 ${Math.ceil(seconds)} 秒`;
    if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const secs = Math.ceil(seconds % 60);
      return `剩余 ${minutes} 分 ${secs} 秒`;
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.ceil((seconds % 3600) / 60);
    return `剩余 ${hours} 时 ${minutes} 分`;
  }

  function showTransferToast(message) {
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
