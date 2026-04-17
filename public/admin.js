// Lwt's Store - Admin Panel Logic

// DOM Elements
const adminPassword = document.getElementById("adminPassword");
const loginBtn = document.getElementById("loginBtn");
const loginError = document.getElementById("loginError");
const loginSection = document.getElementById("loginSection");
const adminPanel = document.getElementById("adminPanel");
const adminSearchInput = document.getElementById("adminSearchInput");
const adminFileListLoading = document.getElementById("adminFileListLoading");
const adminEmptyState = document.getElementById("adminEmptyState");
const adminFileTable = document.getElementById("adminFileTable");
const adminFileTableBody = document.getElementById("adminFileTableBody");
const adminPagination = document.getElementById("adminPagination");
const adminPaginationInfo = document.getElementById("adminPaginationInfo");
const adminPageSizeSelect = document.getElementById("adminPageSizeSelect");
const adminPrevPageBtn = document.getElementById("adminPrevPageBtn");
const adminNextPageBtn = document.getElementById("adminNextPageBtn");
const adminPageNumbers = document.getElementById("adminPageNumbers");
const deleteModal = document.getElementById("deleteModal");
const deleteFileName = document.getElementById("deleteFileName");
const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");

let adminPwd = "";
let adminCurrentPage = 1;
let adminCurrentPageSize = 20;
let adminCurrentSearch = "";
let adminSearchDebounceTimer = null;
let pendingDeleteFileId = null;

// ==================== Initialization ====================

document.addEventListener("DOMContentLoaded", () => {
  // Check if already logged in via sessionStorage
  const savedPwd = sessionStorage.getItem("lwt_admin_pwd");
  if (savedPwd) {
    adminPwd = savedPwd;
    showAdminPanel();
  }

  setupLogin();
  setupAdminPagination();
  setupDeleteModal();
});

// ==================== Login ====================

function setupLogin() {
  loginBtn.addEventListener("click", attemptLogin);
  adminPassword.addEventListener("keydown", (e) => {
    if (e.key === "Enter") attemptLogin();
  });
}

async function attemptLogin() {
  const pwd = adminPassword.value.trim();
  if (!pwd) {
    showLoginError("请输入密码");
    return;
  }

  loginError.style.display = "none";
  loginBtn.disabled = true;
  loginBtn.textContent = "验证中...";

  try {
    // Verify password by trying to call admin API with a dummy request
    const res = await fetch("/api/admin/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: "__verify__", password: pwd }),
    });

    const data = await res.json();

    if (res.status === 401) {
      showLoginError("密码错误");
      return;
    }

    // If we get 404 (file not found) or any non-401 response, password is correct
    adminPwd = pwd;
    sessionStorage.setItem("lwt_admin_pwd", pwd);
    showAdminPanel();
  } catch (err) {
    showLoginError("网络错误，请重试");
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "登录";
  }
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.style.display = "block";
}

function showAdminPanel() {
  loginSection.style.display = "none";
  adminPanel.style.display = "block";
  loadAdminFileList();
}

// ==================== Admin File List ====================

function setupAdminPagination() {
  adminSearchInput.addEventListener("input", () => {
    clearTimeout(adminSearchDebounceTimer);
    adminSearchDebounceTimer = setTimeout(() => {
      adminCurrentSearch = adminSearchInput.value.trim();
      adminCurrentPage = 1;
      loadAdminFileList();
    }, 300);
  });

  adminPageSizeSelect.addEventListener("change", () => {
    adminCurrentPageSize = parseInt(adminPageSizeSelect.value);
    adminCurrentPage = 1;
    loadAdminFileList();
  });

  adminPrevPageBtn.addEventListener("click", () => {
    if (adminCurrentPage > 1) {
      adminCurrentPage--;
      loadAdminFileList();
    }
  });

  adminNextPageBtn.addEventListener("click", () => {
    adminCurrentPage++;
    loadAdminFileList();
  });
}

async function loadAdminFileList() {
  try {
    adminFileListLoading.style.display = "block";
    adminEmptyState.style.display = "none";
    adminFileTable.style.display = "none";
    adminPagination.style.display = "none";

    const params = new URLSearchParams({
      page: adminCurrentPage,
      pageSize: adminCurrentPageSize,
    });
    if (adminCurrentSearch) {
      params.set("search", adminCurrentSearch);
    }

    const res = await fetch(`/api/files?${params}`);
    if (!res.ok) throw new Error("Failed to load file list");

    const data = await res.json();
    const { files, total, page, pageSize, totalPages } = data;

    adminFileListLoading.style.display = "none";

    if (files.length === 0) {
      adminEmptyState.style.display = "block";
      if (adminCurrentSearch) {
        adminEmptyState.textContent = `没有找到包含"${adminCurrentSearch}"的文件`;
      } else {
        adminEmptyState.textContent = "暂无文件";
      }
      renderAdminPagination(total, page, pageSize, totalPages);
      return;
    }

    adminFileTable.style.display = "table";
    adminFileTableBody.innerHTML = "";

    for (const file of files) {
      const tr = document.createElement("tr");
      tr.setAttribute("data-file-id", file.fileId);

      tr.innerHTML = `
        <td class="file-name-cell" title="${escapeHtml(file.fileName)}">${escapeHtml(file.fileName)}</td>
        <td class="file-size-cell">${formatSize(file.fileSize)}</td>
        <td class="file-date-cell">${formatDate(file.createdAt)}</td>
        <td>
          <div class="file-actions">
            <a href="${file.downloadUrl}" class="btn btn-download" download>下载</a>
            <button class="btn btn-delete" onclick="showDeleteConfirm('${file.fileId}', '${escapeHtml(file.fileName)}')">删除</button>
          </div>
        </td>
      `;

      adminFileTableBody.appendChild(tr);
    }

    renderAdminPagination(total, page, pageSize, totalPages);
  } catch (err) {
    adminFileListLoading.textContent = "加载失败，请刷新页面重试";
  }
}

function renderAdminPagination(total, page, pageSize, totalPages) {
  if (total === 0) {
    adminPagination.style.display = "none";
    return;
  }

  adminPagination.style.display = "flex";
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  adminPaginationInfo.textContent = `共 ${total} 个文件，显示 ${start}-${end}`;

  adminPrevPageBtn.disabled = page <= 1;
  adminNextPageBtn.disabled = page >= totalPages;

  adminPageNumbers.innerHTML = "";
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
      adminCurrentPage = i;
      loadAdminFileList();
    });
    adminPageNumbers.appendChild(btn);
  }
}

// ==================== Delete File ====================

function setupDeleteModal() {
  cancelDeleteBtn.addEventListener("click", hideDeleteModal);
  confirmDeleteBtn.addEventListener("click", confirmDelete);

  // Close modal on overlay click
  deleteModal.addEventListener("click", (e) => {
    if (e.target === deleteModal) hideDeleteModal();
  });
}

window.showDeleteConfirm = function (fileId, fileName) {
  pendingDeleteFileId = fileId;
  deleteFileName.textContent = fileName;
  deleteModal.style.display = "flex";
};

function hideDeleteModal() {
  deleteModal.style.display = "none";
  pendingDeleteFileId = null;
}

async function confirmDelete() {
  if (!pendingDeleteFileId) return;

  confirmDeleteBtn.disabled = true;
  confirmDeleteBtn.textContent = "删除中...";

  try {
    const res = await fetch("/api/admin/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: pendingDeleteFileId,
        password: adminPwd,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(`删除失败: ${data.error}`);
      return;
    }

    showToast("文件已删除");
    hideDeleteModal();
    loadAdminFileList();
  } catch (err) {
    showToast(`删除失败: ${err.message}`);
  } finally {
    confirmDeleteBtn.disabled = false;
    confirmDeleteBtn.textContent = "确认删除";
  }
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

function showToast(message) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
