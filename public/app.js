// Lwt's Store - Client-side application logic

let PART_SIZE = 5 * 1024 * 1024; // 5MB default, overridden by server during upload init
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB
const RETRY_WAIT_MS = 1000;

// DOM Elements
const uploadArea = document.getElementById("uploadArea");
const fileInput = document.getElementById("fileInput");
const uploadProgress = document.getElementById("uploadProgress");
const uploadFileName = document.getElementById("uploadFileName");
const progressText = document.getElementById("progressText");
const progressFill = document.getElementById("progressFill");
const uploadedSizeEl = document.getElementById("uploadedSize");
const totalSizeEl = document.getElementById("totalSize");
const uploadStatus = document.getElementById("uploadStatus");
const uploadSpeedEl = document.getElementById("uploadSpeed");
const uploadEtaEl = document.getElementById("uploadEta");
const cancelBtn = document.getElementById("cancelBtn");
const uploadComplete = document.getElementById("uploadComplete");
const downloadLinkInput = document.getElementById("downloadLinkInput");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const newUploadBtn = document.getElementById("newUploadBtn");
const fileListLoading = document.getElementById("fileListLoading");
const emptyState = document.getElementById("emptyState");
const fileTable = document.getElementById("fileTable");
const fileTableBody = document.getElementById("fileTableBody");

const searchInput = document.getElementById("searchInput");
const pagination = document.getElementById("pagination");
const paginationInfo = document.getElementById("paginationInfo");
const pageSizeSelect = document.getElementById("pageSizeSelect");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageNumbers = document.getElementById("pageNumbers");

let currentUpload = null; // Track current upload state
let uploadCancelled = false;
let pendingResumeFileHash = null;
let activeUploadXhr = null;

// Speed tracking state
let speedTracker = {
  startTime: 0,
  startBytes: 0,
  lastTime: 0,
  lastBytes: 0,
  smoothedSpeed: 0,
};

// Pagination state
let currentPage = 1;
let currentPageSize = 20;
let currentSearch = "";
let searchDebounceTimer = null;

// ==================== Initialization ====================

document.addEventListener("DOMContentLoaded", () => {
  loadFileList();
  setupUploadArea();
  setupButtons();
  setupPagination();
  checkResumeUpload();
});

// ==================== Upload Area Setup ====================

function setupUploadArea() {
  uploadArea.addEventListener("click", () => fileInput.click());

  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
  });

  uploadArea.addEventListener("dragleave", () => {
    uploadArea.classList.remove("dragover");
  });

  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      startUpload(files[0]);
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      const file = e.target.files[0];
      const fileHash = generateFileHash(file);
      if (pendingResumeFileHash && pendingResumeFileHash !== fileHash) {
        showToast("请选择同一个文件位置继续上传");
        fileInput.value = "";
        return;
      }
      pendingResumeFileHash = null;
      startUpload(file);
    }
  });
}

function setupButtons() {
  cancelBtn.addEventListener("click", () => {
    uploadCancelled = true;
    if (activeUploadXhr) activeUploadXhr.abort();
    cancelBtn.style.display = "none";
    uploadStatus.textContent = "已暂停，可从传输面板选择同一文件继续";
    if (currentUpload?.fileHash && window.lwtTransferManager) {
      window.lwtTransferManager.pauseUploadTask(currentUpload.fileHash);
    }
  });

  copyLinkBtn.addEventListener("click", () => {
    downloadLinkInput.select();
    navigator.clipboard.writeText(downloadLinkInput.value).then(() => {
      showToast("链接已复制到剪贴板！");
    });
  });

  newUploadBtn.addEventListener("click", () => {
    resetUploadUI();
  });
}

// ==================== File Upload Logic ====================

function generateFileHash(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

window.lwtUploadControls = {
  chooseFile(fileHash) {
    pendingResumeFileHash = fileHash;
    fileInput.click();
  },
  cancelUpload(fileHash) {
    if (!fileHash || currentUpload?.fileHash === fileHash) {
      uploadCancelled = true;
      if (activeUploadXhr) activeUploadXhr.abort();
      uploadStatus.textContent = "已暂停，可从传输面板选择同一文件继续";
    }
  },
};

async function startUpload(file) {
  if (file.size > MAX_FILE_SIZE) {
    showToast("文件大小超过 5GB 限制！");
    return;
  }

  const fileHash = generateFileHash(file);
  const transferManager = window.lwtTransferManager || window.lwtDownloadManager;

  uploadCancelled = false;
  currentUpload = { fileHash };
  transferManager?.startUploadTask({
    fileHash,
    fileName: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
  });

  // Show progress UI
  uploadArea.style.display = "none";
  uploadComplete.style.display = "none";
  uploadProgress.style.display = "block";
  cancelBtn.style.display = "inline-block";
  uploadFileName.textContent = file.name;
  totalSizeEl.textContent = formatSize(file.size);
  uploadStatus.textContent = "初始化中...";
  resetSpeedTracker();
  updateProgress(0, file.size);

  try {
    // Step 1: Initialize upload
    const initData = await fetchJsonWithInfiniteRetry("/api/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        fileHash: fileHash,
      }),
    }, {
      isCancelled: () => uploadCancelled,
      onRetry: (attempt, err, backoffMs) => {
        const message = `初始化失败(${err.message})，${Math.round(backoffMs / 1000)}秒后重试...`;
        uploadStatus.textContent = message;
        transferManager?.updateUploadTask(fileHash, { retryMessage: message });
      },
    });
    const { fileId, totalParts, uploadedParts } = initData;
    currentUpload = { fileHash, fileId };

    // Use server-provided PART_SIZE to ensure client/server consistency
    if (initData.partSize) {
      PART_SIZE = initData.partSize;
    }

    // Save to localStorage for resume
    saveUploadState(fileHash, {
      fileHash,
      fileId,
      fileName: file.name,
      fileSize: file.size,
      lastModified: file.lastModified,
      partSize: PART_SIZE,
      totalParts,
      uploadedParts,
      uploadedBytes: 0,
      status: "running",
    });
    transferManager?.updateUploadTask(fileHash, {
      fileId,
      partSize: PART_SIZE,
      totalParts,
      uploadedParts,
      status: "running",
      retryMessage: "",
    });

    if (initData.resumed) {
      uploadStatus.textContent = `恢复上传 (${uploadedParts.length}/${totalParts} 已完成)`;
      showToast("检测到之前的上传，正在恢复...");
    }

    // Step 2: Upload parts sequentially
    const uploadedSet = new Set(uploadedParts);
    let completedBytes = uploadedParts.length * PART_SIZE;
    // Adjust for last part if already uploaded
    if (uploadedParts.includes(totalParts - 1)) {
      completedBytes = completedBytes - PART_SIZE + (file.size % PART_SIZE || PART_SIZE);
    }

    updateProgress(completedBytes, file.size);
    transferManager?.updateUploadTask(fileHash, {
      uploadedBytes: completedBytes,
      uploadedParts,
      retryMessage: "",
    });

    for (let i = 0; i < totalParts; i++) {
      if (uploadCancelled) {
        uploadStatus.textContent = "已暂停，可从传输面板选择同一文件继续";
        transferManager?.pauseUploadTask(fileHash);
        return;
      }

      if (uploadedSet.has(i)) {
        continue; // Skip already uploaded parts
      }

      uploadStatus.textContent = `上传分片 ${i + 1}/${totalParts}...`;
      transferManager?.updateUploadTask(fileHash, {
        status: "running",
        retryMessage: `上传分片 ${i + 1}/${totalParts}...`,
      });

      const start = i * PART_SIZE;
      const end = Math.min(start + PART_SIZE, file.size);
      const chunk = file.slice(start, end);

      // Upload with infinite retry until user cancels.
      // Keep the retry wait fixed so transient Cloudflare failures recover quickly.
      let success = false;
      let attempt = 0;
      const partSize = end - start;

      while (!success) {
        if (uploadCancelled) {
          uploadStatus.textContent = "已暂停，可从传输面板选择同一文件继续";
          transferManager?.pauseUploadTask(fileHash);
          return;
        }

        try {
          const formData = new FormData();
          formData.append("fileId", fileId);
          formData.append("partIndex", i.toString());
          formData.append("data", chunk);

          // Use XMLHttpRequest for real-time upload progress tracking
          const partResult = await uploadPartWithProgress(
            formData,
            (partLoaded) => {
              const totalLoaded = completedBytes + Math.min(partLoaded, partSize);
              updateProgress(totalLoaded, file.size);
              transferManager?.updateUploadTask(fileHash, {
                status: "running",
                uploadedBytes: totalLoaded,
                retryMessage: "",
              });
            },
            120000
          );

          if (!partResult.success) {
            throw new Error(partResult.error || `Failed to upload part ${i}`);
          }

          success = true;
          attempt = 0;
          uploadedSet.add(i);
          completedBytes += partSize;
          updateProgress(completedBytes, file.size);
          const uploadedPartsNow = Array.from(uploadedSet).sort((a, b) => a - b);
          saveUploadState(fileHash, {
            fileHash,
            fileId,
            fileName: file.name,
            fileSize: file.size,
            lastModified: file.lastModified,
            partSize: PART_SIZE,
            totalParts,
            uploadedParts: uploadedPartsNow,
            uploadedBytes: completedBytes,
            status: "running",
          });
          transferManager?.updateUploadTask(fileHash, {
            uploadedParts: uploadedPartsNow,
            uploadedBytes: completedBytes,
            retryMessage: "",
          });
        } catch (err) {
          attempt++;
          const errorMsg = err.message || "未知错误";
          const backoffMs = RETRY_WAIT_MS;
          uploadStatus.textContent = `分片 ${i + 1} 失败(${errorMsg})，${Math.round(backoffMs / 1000)}秒后重试...`;
          transferManager?.updateUploadTask(fileHash, {
            retryMessage: uploadStatus.textContent,
          });
          await sleepWithUploadCancel(backoffMs);
        }
      }
    }

    // Step 3: Complete upload
    uploadStatus.textContent = "正在完成上传...";
    transferManager?.updateUploadTask(fileHash, {
      retryMessage: "正在完成上传...",
    });

    const completeData = await fetchJsonWithInfiniteRetry("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId }),
    }, {
      isCancelled: () => uploadCancelled,
      onRetry: (attempt, err, backoffMs) => {
        const message = `完成上传失败(${err.message})，${Math.round(backoffMs / 1000)}秒后重试...`;
        uploadStatus.textContent = message;
        transferManager?.updateUploadTask(fileHash, { retryMessage: message });
      },
    });

    // Clear saved state
    clearUploadState(fileHash);
    transferManager?.completeUploadTask(fileHash, {
      fileId,
      downloadUrl: completeData.downloadUrl,
      uploadedBytes: file.size,
      uploadedParts: Array.from(uploadedSet).sort((a, b) => a - b),
    });

    // Show success
    uploadProgress.style.display = "none";
    uploadComplete.style.display = "block";
    const downloadUrl = `${window.location.origin}${completeData.downloadUrl}`;
    downloadLinkInput.value = downloadUrl;

    showToast("上传完成！");

    // Refresh file list
    loadFileList();
  } catch (err) {
    if (uploadCancelled) {
      uploadStatus.textContent = "已暂停，可从传输面板选择同一文件继续";
      transferManager?.pauseUploadTask(fileHash);
      showToast("上传已暂停");
    } else {
      uploadStatus.textContent = `错误: ${err.message}`;
      transferManager?.pauseUploadTask(fileHash, `上传中断: ${err.message}。请选择同一文件继续上传`);
      showToast(`上传失败: ${err.message}`);
    }
  } finally {
    activeUploadXhr = null;
  }
}

async function fetchJsonWithInfiniteRetry(url, options, { isCancelled, onRetry } = {}) {
  let attempt = 0;

  while (true) {
    if (isCancelled?.()) throw new Error("上传已暂停");

    try {
      const res = await fetch(url, options);
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }

      if (res.ok) return data || {};

      const message = data?.error || `HTTP ${res.status}`;
      const err = new Error(message);
      err.nonRetryable = res.status < 500 && res.status !== 429;
      throw err;
    } catch (err) {
      if (isCancelled?.()) throw err;
      if (err.nonRetryable) throw err;

      attempt++;
      const backoffMs = RETRY_WAIT_MS;
      if (onRetry) onRetry(attempt, err, backoffMs);
      await sleepWithUploadCancel(backoffMs);
    }
  }
}

function sleepWithUploadCancel(ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(check);
      resolve();
    }, ms);
    const check = setInterval(() => {
      if (uploadCancelled) {
        clearTimeout(timer);
        clearInterval(check);
        reject(new Error("上传已暂停"));
      }
    }, 200);
  });
}

// ==================== Resume Upload ====================

function saveUploadState(fileHash, state) {
  try {
    const uploads = JSON.parse(localStorage.getItem("lwt_uploads") || "{}");
    uploads[fileHash] = state;
    localStorage.setItem("lwt_uploads", JSON.stringify(uploads));

    // Also set a cookie for cross-tab resume detection
    document.cookie = `lwt_upload_active=${encodeURIComponent(fileHash)}; path=/; max-age=2592000; SameSite=Lax`;
  } catch (e) {
    // localStorage might be full or unavailable
  }
}

function clearUploadState(fileHash) {
  try {
    const uploads = JSON.parse(localStorage.getItem("lwt_uploads") || "{}");
    delete uploads[fileHash];
    localStorage.setItem("lwt_uploads", JSON.stringify(uploads));

    document.cookie = "lwt_upload_active=; path=/; max-age=0";
  } catch (e) {
    // Ignore
  }
}

function checkResumeUpload() {
  try {
    // Check cookie for active upload
    const cookies = document.cookie.split(";").map((c) => c.trim());
    const activeCookie = cookies.find((c) => c.startsWith("lwt_upload_active="));
    if (!activeCookie) return;

    const fileHash = decodeURIComponent(activeCookie.split("=")[1] || "");
    if (!fileHash) return;

    const uploads = JSON.parse(localStorage.getItem("lwt_uploads") || "{}");
    const state = uploads[fileHash];
    if (!state) return;

    if (window.lwtTransferManager) {
      window.lwtTransferManager.expandTray();
    }

    // Show a notification that there's a resumable upload
    const resumeNotice = document.createElement("div");
    resumeNotice.className = "toast show";
    resumeNotice.style.cssText = "bottom: 24px; right: 24px; cursor: pointer; opacity: 1; transform: translateY(0);";
    resumeNotice.innerHTML = `
      <div>检测到未完成的上传: <strong>${state.fileName}</strong></div>
      <div style="font-size: 0.8rem; margin-top: 4px;">请在传输面板中选择同一文件继续上传</div>
    `;
    resumeNotice.addEventListener("click", () => {
      resumeNotice.remove();
      pendingResumeFileHash = fileHash;
      fileInput.click();
    });
    document.body.appendChild(resumeNotice);

    // Auto-remove after 10 seconds
    setTimeout(() => {
      if (resumeNotice.parentNode) {
        resumeNotice.classList.remove("show");
        setTimeout(() => resumeNotice.remove(), 300);
      }
    }, 10000);
  } catch (e) {
    // Ignore
  }
}

// ==================== Pagination Setup ====================

function setupPagination() {
  // Search input with debounce
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentSearch = searchInput.value.trim();
      currentPage = 1;
      loadFileList();
    }, 300);
  });

  // Page size selector
  pageSizeSelect.addEventListener("change", () => {
    currentPageSize = parseInt(pageSizeSelect.value);
    currentPage = 1;
    loadFileList();
  });

  // Previous page
  prevPageBtn.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadFileList();
    }
  });

  // Next page
  nextPageBtn.addEventListener("click", () => {
    currentPage++;
    loadFileList();
  });
}

function renderPagination(total, page, pageSize, totalPages) {
  if (total === 0) {
    pagination.style.display = "none";
    return;
  }

  pagination.style.display = "flex";
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  paginationInfo.textContent = `共 ${total} 个文件，显示 ${start}-${end}`;

  prevPageBtn.disabled = page <= 1;
  nextPageBtn.disabled = page >= totalPages;

  // Render page numbers
  pageNumbers.innerHTML = "";
  const maxButtons = 5;
  let startPage = Math.max(1, page - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);
  if (endPage - startPage < maxButtons - 1) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }

  for (let i = startPage; i <= endPage; i++) {
    const btn = document.createElement("button");
    btn.className = `btn btn-page-num${i === page ? " active" : ""}`;
    btn.textContent = i;
    btn.addEventListener("click", () => {
      currentPage = i;
      loadFileList();
    });
    pageNumbers.appendChild(btn);
  }
}

// ==================== File List ====================

async function loadFileList() {
  try {
    fileListLoading.style.display = "block";
    emptyState.style.display = "none";
    fileTable.style.display = "none";
    pagination.style.display = "none";

    const params = new URLSearchParams({
      page: currentPage,
      pageSize: currentPageSize,
    });
    if (currentSearch) {
      params.set("search", currentSearch);
    }

    const res = await fetch(`/api/files?${params}`);
    if (!res.ok) throw new Error("Failed to load file list");

    const data = await res.json();
    const { files, total, page, pageSize, totalPages } = data;

    fileListLoading.style.display = "none";

    if (files.length === 0) {
      emptyState.style.display = "block";
      if (currentSearch) {
        emptyState.textContent = `没有找到包含"${currentSearch}"的文件`;
      } else {
        emptyState.textContent = "暂无文件，快来上传第一个文件吧！";
      }
      renderPagination(total, page, pageSize, totalPages);
      return;
    }

    fileTable.style.display = "table";
    fileTableBody.innerHTML = "";

    for (const file of files) {
      const tr = document.createElement("tr");
      const downloadUrl = `${window.location.origin}${file.downloadUrl}`;

      tr.innerHTML = `
        <td class="file-name-cell" title="${escapeHtml(file.fileName)}">${escapeHtml(file.fileName)}</td>
        <td class="file-size-cell">${formatSize(file.fileSize)}</td>
        <td class="file-date-cell">${formatDate(file.createdAt)}</td>
        <td>
          <div class="file-actions">
            <a href="${file.downloadUrl}" class="btn btn-download" download>下载</a>
            <button class="btn btn-copy-small" onclick="copyLink('${escapeHtml(downloadUrl)}')">复制链接</button>
          </div>
        </td>
      `;

      fileTableBody.appendChild(tr);
      tr.querySelector(".btn-download").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.lwtDownloadManager) {
          window.lwtDownloadManager.startDownload(file);
        } else {
          window.location.href = file.downloadUrl;
        }
      });
    }

    renderPagination(total, page, pageSize, totalPages);
  } catch (err) {
    fileListLoading.textContent = "加载失败，请刷新页面重试";
  }
}

// ==================== Upload Helper (XMLHttpRequest for progress) ====================

/**
 * Upload a part using XMLHttpRequest to get real-time upload progress.
 * fetch() does not support upload progress events.
 * @param {FormData} formData - Form data with fileId, partIndex, data
 * @param {function} onProgress - Callback with bytes uploaded so far
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<object>} - Parsed JSON response
 */
function uploadPartWithProgress(formData, onProgress, timeoutMs) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeUploadXhr = xhr;
    xhr.open("POST", "/api/upload/part");
    xhr.timeout = timeoutMs;

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded);
      }
    });

    xhr.addEventListener("load", () => {
      if (activeUploadXhr === xhr) activeUploadXhr = null;
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ success: true, ...data });
        } else {
          resolve({ success: false, error: data.error || `HTTP ${xhr.status}` });
        }
      } catch (parseError) {
        resolve({ success: false, error: `Server error: HTTP ${xhr.status}` });
      }
    });

    xhr.addEventListener("error", () => {
      if (activeUploadXhr === xhr) activeUploadXhr = null;
      reject(new Error("网络错误，请检查网络连接"));
    });

    xhr.addEventListener("timeout", () => {
      if (activeUploadXhr === xhr) activeUploadXhr = null;
      reject(new Error("请求超时"));
    });

    xhr.addEventListener("abort", () => {
      if (activeUploadXhr === xhr) activeUploadXhr = null;
      reject(new Error("上传已取消"));
    });

    xhr.send(formData);
  });
}

// ==================== UI Helpers ====================

function resetSpeedTracker() {
  const now = Date.now();
  speedTracker = {
    startTime: now,
    startBytes: 0,
    lastTime: now,
    lastBytes: 0,
    smoothedSpeed: 0,
  };
  if (uploadSpeedEl) uploadSpeedEl.textContent = "";
  if (uploadEtaEl) uploadEtaEl.textContent = "";
}

function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond <= 0) return "0 B/s";
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

function updateProgress(loaded, total) {
  const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
  progressText.textContent = `${percent}%`;
  progressFill.style.width = `${percent}%`;
  uploadedSizeEl.textContent = formatSize(loaded);

  // Calculate upload speed
  const now = Date.now();
  const elapsedSinceLastMs = now - speedTracker.lastTime;

  if (loaded > 0 && elapsedSinceLastMs >= 500) {
    const bytesDelta = loaded - speedTracker.lastBytes;
    const instantSpeed = (bytesDelta / elapsedSinceLastMs) * 1000;

    // Exponential moving average for smooth display (alpha = 0.3)
    if (speedTracker.smoothedSpeed === 0) {
      speedTracker.smoothedSpeed = instantSpeed;
    } else {
      speedTracker.smoothedSpeed = 0.3 * instantSpeed + 0.7 * speedTracker.smoothedSpeed;
    }

    speedTracker.lastTime = now;
    speedTracker.lastBytes = loaded;

    if (uploadSpeedEl) {
      uploadSpeedEl.textContent = `⚡ ${formatSpeed(speedTracker.smoothedSpeed)}`;
    }

    // Calculate ETA based on smoothed speed
    const remaining = total - loaded;
    if (uploadEtaEl && speedTracker.smoothedSpeed > 0) {
      const etaSeconds = remaining / speedTracker.smoothedSpeed;
      uploadEtaEl.textContent = remaining > 0 ? formatEta(etaSeconds) : "";
    }
  }

  // Clear speed/ETA when upload is complete
  if (loaded >= total && total > 0) {
    if (uploadSpeedEl) uploadSpeedEl.textContent = "";
    if (uploadEtaEl) uploadEtaEl.textContent = "";
  }
}

function resetUploadUI() {
  uploadArea.style.display = "block";
  uploadProgress.style.display = "none";
  uploadComplete.style.display = "none";
  fileInput.value = "";
  updateProgress(0, 0);
  uploadStatus.textContent = "";
  resetSpeedTracker();
}

function showToast(message) {
  // Remove existing toast
  const existing = document.querySelector(".toast:not([style*='cursor'])");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

window.showToast = showToast;

// ==================== Utility Functions ====================

function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + units[i];
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Global function for copy link buttons in file list
window.copyLink = function (url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast("链接已复制到剪贴板！");
  }).catch(() => {
    // Fallback
    const input = document.createElement("input");
    input.value = url;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    document.body.removeChild(input);
    showToast("链接已复制到剪贴板！");
  });
};

// ===== Link Exchange =====

async function loadLinkExchange() {
  try {
    const res = await fetch("/api/links");
    if (!res.ok) return;

    const data = await res.json();
    if (!data.links || data.links.length === 0) return;

    const grid = document.getElementById("linksGrid");
    const icons = ["✨", "🌐", "🔗", "💎", "🚀", "⭐", "🎯", "🌟"];

    grid.innerHTML = data.links
      .map((link, index) => {
        const icon = icons[index % icons.length];
        return `<a href="${link.url}" target="_blank" rel="noopener noreferrer" class="link-card">
          <span class="link-icon">${icon}</span>
          <span class="link-title">${link.title}</span>
        </a>`;
      })
      .join("");

    document.getElementById("linkExchange").style.display = "block";
  } catch (err) {
    // Silently fail — link exchange is non-critical
  }
}

// Load link exchange on page load
loadLinkExchange();
