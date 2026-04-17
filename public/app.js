// Lwt's Store - Client-side application logic

const PART_SIZE = 20 * 1024 * 1024; // 20MB per part
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB

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
const cancelBtn = document.getElementById("cancelBtn");
const uploadComplete = document.getElementById("uploadComplete");
const downloadLinkInput = document.getElementById("downloadLinkInput");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const newUploadBtn = document.getElementById("newUploadBtn");
const fileListLoading = document.getElementById("fileListLoading");
const emptyState = document.getElementById("emptyState");
const fileTable = document.getElementById("fileTable");
const fileTableBody = document.getElementById("fileTableBody");

let currentUpload = null; // Track current upload state
let uploadCancelled = false;

// ==================== Initialization ====================

document.addEventListener("DOMContentLoaded", () => {
  loadFileList();
  setupUploadArea();
  setupButtons();
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
      startUpload(e.target.files[0]);
    }
  });
}

function setupButtons() {
  cancelBtn.addEventListener("click", () => {
    uploadCancelled = true;
    cancelBtn.style.display = "none";
    uploadStatus.textContent = "已取消";
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

async function startUpload(file) {
  if (file.size > MAX_FILE_SIZE) {
    showToast("文件大小超过 5GB 限制！");
    return;
  }

  uploadCancelled = false;

  // Show progress UI
  uploadArea.style.display = "none";
  uploadComplete.style.display = "none";
  uploadProgress.style.display = "block";
  cancelBtn.style.display = "inline-block";
  uploadFileName.textContent = file.name;
  totalSizeEl.textContent = formatSize(file.size);
  uploadStatus.textContent = "初始化中...";
  updateProgress(0, file.size);

  try {
    // Step 1: Initialize upload
    const fileHash = generateFileHash(file);
    const initRes = await fetch("/api/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        fileHash: fileHash,
      }),
    });

    if (!initRes.ok) {
      const err = await initRes.json();
      throw new Error(err.error || "Failed to initialize upload");
    }

    const initData = await initRes.json();
    const { fileId, totalParts, uploadedParts } = initData;

    // Save to localStorage for resume
    saveUploadState(fileHash, { fileId, fileName: file.name, fileSize: file.size });

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

    for (let i = 0; i < totalParts; i++) {
      if (uploadCancelled) {
        uploadStatus.textContent = "已取消";
        return;
      }

      if (uploadedSet.has(i)) {
        continue; // Skip already uploaded parts
      }

      uploadStatus.textContent = `上传分片 ${i + 1}/${totalParts}...`;

      const start = i * PART_SIZE;
      const end = Math.min(start + PART_SIZE, file.size);
      const chunk = file.slice(start, end);

      // Upload with retry
      let retries = 3;
      let success = false;

      while (retries > 0 && !success) {
        try {
          const formData = new FormData();
          formData.append("fileId", fileId);
          formData.append("partIndex", i.toString());
          formData.append("data", chunk);

          const partRes = await fetch("/api/upload/part", {
            method: "POST",
            body: formData,
          });

          if (!partRes.ok) {
            const err = await partRes.json();
            throw new Error(err.error || `Failed to upload part ${i}`);
          }

          success = true;
          completedBytes += (end - start);
          updateProgress(completedBytes, file.size);
        } catch (err) {
          retries--;
          if (retries === 0) {
            uploadStatus.textContent = `分片 ${i + 1} 上传失败，请刷新页面重试`;
            showToast(`上传失败: ${err.message}`);
            return;
          }
          // Wait before retry
          await new Promise((r) => setTimeout(r, 2000));
          uploadStatus.textContent = `重试分片 ${i + 1}... (剩余 ${retries} 次)`;
        }
      }
    }

    // Step 3: Complete upload
    uploadStatus.textContent = "正在完成上传...";

    const completeRes = await fetch("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId }),
    });

    if (!completeRes.ok) {
      const err = await completeRes.json();
      throw new Error(err.error || "Failed to complete upload");
    }

    const completeData = await completeRes.json();

    // Clear saved state
    clearUploadState(fileHash);

    // Show success
    uploadProgress.style.display = "none";
    uploadComplete.style.display = "block";
    const downloadUrl = `${window.location.origin}${completeData.downloadUrl}`;
    downloadLinkInput.value = downloadUrl;

    showToast("上传完成！");

    // Refresh file list
    loadFileList();
  } catch (err) {
    uploadStatus.textContent = `错误: ${err.message}`;
    showToast(`上传失败: ${err.message}`);
  }
}

// ==================== Resume Upload ====================

function saveUploadState(fileHash, state) {
  try {
    const uploads = JSON.parse(localStorage.getItem("lwt_uploads") || "{}");
    uploads[fileHash] = state;
    localStorage.setItem("lwt_uploads", JSON.stringify(uploads));

    // Also set a cookie for cross-tab resume detection
    document.cookie = `lwt_upload_active=${fileHash}; path=/; max-age=86400; SameSite=Lax`;
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

    const fileHash = activeCookie.split("=")[1];
    if (!fileHash) return;

    const uploads = JSON.parse(localStorage.getItem("lwt_uploads") || "{}");
    const state = uploads[fileHash];
    if (!state) return;

    // Show a notification that there's a resumable upload
    const resumeNotice = document.createElement("div");
    resumeNotice.className = "toast show";
    resumeNotice.style.cssText = "bottom: 24px; right: 24px; cursor: pointer; opacity: 1; transform: translateY(0);";
    resumeNotice.innerHTML = `
      <div>检测到未完成的上传: <strong>${state.fileName}</strong></div>
      <div style="font-size: 0.8rem; margin-top: 4px;">请重新选择同一文件以恢复上传</div>
    `;
    resumeNotice.addEventListener("click", () => {
      resumeNotice.remove();
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

// ==================== File List ====================

async function loadFileList() {
  try {
    fileListLoading.style.display = "block";
    emptyState.style.display = "none";
    fileTable.style.display = "none";

    const res = await fetch("/api/files");
    if (!res.ok) throw new Error("Failed to load file list");

    const files = await res.json();

    fileListLoading.style.display = "none";

    if (files.length === 0) {
      emptyState.style.display = "block";
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
    }
  } catch (err) {
    fileListLoading.textContent = "加载失败，请刷新页面重试";
  }
}

// ==================== UI Helpers ====================

function updateProgress(loaded, total) {
  const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
  progressText.textContent = `${percent}%`;
  progressFill.style.width = `${percent}%`;
  uploadedSizeEl.textContent = formatSize(loaded);
}

function resetUploadUI() {
  uploadArea.style.display = "block";
  uploadProgress.style.display = "none";
  uploadComplete.style.display = "none";
  fileInput.value = "";
  updateProgress(0, 0);
  uploadStatus.textContent = "";
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
