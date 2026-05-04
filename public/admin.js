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
const activeFilesTab = document.getElementById("activeFilesTab");
const recycleBinTab = document.getElementById("recycleBinTab");
const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");
const bulkRestoreBtn = document.getElementById("bulkRestoreBtn");
const bulkPurgeBtn = document.getElementById("bulkPurgeBtn");
const selectAllFiles = document.getElementById("selectAllFiles");
const deleteModal = document.getElementById("deleteModal");
const deleteModalText = document.getElementById("deleteModalText");
const deleteModalWarning = document.getElementById("deleteModalWarning");
const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");

let adminPwd = "";
let adminCurrentPage = 1;
let adminCurrentPageSize = 20;
let adminCurrentSearch = "";
let adminSearchDebounceTimer = null;
let adminView = "active";
let selectedFileIds = new Set();
let pendingAction = null;
let pendingFileIds = [];

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
  setupAdminToolbar();
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

function setupAdminToolbar() {
  activeFilesTab.addEventListener("click", () => switchAdminView("active"));
  recycleBinTab.addEventListener("click", () => switchAdminView("recycle"));

  selectAllFiles.addEventListener("change", () => {
    const checkboxes = adminFileTableBody.querySelectorAll(".admin-file-checkbox");
    selectedFileIds = new Set();

    checkboxes.forEach((checkbox) => {
      checkbox.checked = selectAllFiles.checked;
      if (checkbox.checked) selectedFileIds.add(checkbox.value);
    });

    updateBulkActionState();
  });

  bulkDeleteBtn.addEventListener("click", () => showBulkActionConfirm("delete"));
  bulkRestoreBtn.addEventListener("click", () => showBulkActionConfirm("restore"));
  bulkPurgeBtn.addEventListener("click", () => showBulkActionConfirm("purge"));
}

function switchAdminView(nextView) {
  if (adminView === nextView) return;

  adminView = nextView;
  adminCurrentPage = 1;
  clearSelection();

  activeFilesTab.classList.toggle("active", adminView === "active");
  recycleBinTab.classList.toggle("active", adminView === "recycle");
  bulkDeleteBtn.style.display = adminView === "active" ? "inline-block" : "none";
  bulkRestoreBtn.style.display = adminView === "recycle" ? "inline-block" : "none";
  bulkPurgeBtn.style.display = adminView === "recycle" ? "inline-block" : "none";

  loadAdminFileList();
}

async function loadAdminFileList() {
  try {
    adminFileListLoading.style.display = "block";
    adminFileListLoading.textContent = "加载中...";
    adminEmptyState.style.display = "none";
    adminFileTable.style.display = "none";
    adminPagination.style.display = "none";
    adminFileTableBody.innerHTML = "";
    clearSelection();

    const params = new URLSearchParams({
      page: adminCurrentPage,
      pageSize: adminCurrentPageSize,
    });
    if (adminCurrentSearch) {
      params.set("search", adminCurrentSearch);
    }

    const res = adminView === "active"
      ? await fetch(`/api/files?${params}`)
      : await fetch("/api/admin/recycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list",
          password: adminPwd,
          page: adminCurrentPage,
          pageSize: adminCurrentPageSize,
          search: adminCurrentSearch,
        }),
      });
    if (!res.ok) throw new Error("Failed to load file list");

    const data = await res.json();
    const { files, total, page, pageSize, totalPages } = data;

    adminFileListLoading.style.display = "none";

    if (files.length === 0) {
      adminEmptyState.style.display = "block";
      if (adminCurrentSearch) {
        adminEmptyState.textContent = `没有找到包含"${adminCurrentSearch}"的文件`;
      } else {
        adminEmptyState.textContent = adminView === "active" ? "暂无文件" : "回收站为空";
      }
      renderAdminPagination(total, page, pageSize, totalPages);
      return;
    }

    adminFileTable.style.display = "table";
    const dateHeader = adminFileTable.querySelector("thead th:nth-child(4)");
    if (dateHeader) dateHeader.textContent = adminView === "active" ? "上传时间" : "删除时间";

    for (const file of files) {
      const tr = document.createElement("tr");
      tr.setAttribute("data-file-id", file.fileId);
      const actionDate = adminView === "active" ? file.createdAt : (file.deletedAt || file.createdAt);

      tr.innerHTML = `
        <td class="select-cell">
          <input type="checkbox" class="admin-file-checkbox" value="${escapeHtml(file.fileId)}" aria-label="选择 ${escapeHtml(file.fileName)}">
        </td>
        <td class="file-name-cell" title="${escapeHtml(file.fileName)}">${escapeHtml(file.fileName)}</td>
        <td class="file-size-cell">${formatSize(file.fileSize)}</td>
        <td class="file-date-cell">${formatDate(actionDate)}</td>
        <td>
          <div class="file-actions">
            ${renderActionButtons(file)}
          </div>
        </td>
      `;

      adminFileTableBody.appendChild(tr);
      tr.querySelector(".admin-file-checkbox").addEventListener("change", handleRowSelectionChange);

      if (adminView === "active") {
        tr.querySelector(".admin-row-delete").addEventListener("click", () => {
          showDeleteConfirm(file.fileId, file.fileName);
        });
      } else {
        tr.querySelector(".admin-row-restore").addEventListener("click", () => {
          showSingleActionConfirm("restore", file.fileId, file.fileName);
        });
        tr.querySelector(".admin-row-purge").addEventListener("click", () => {
          showSingleActionConfirm("purge", file.fileId, file.fileName);
        });
      }
    }

    updateBulkActionState();
    renderAdminPagination(total, page, pageSize, totalPages);
  } catch (err) {
    adminFileListLoading.textContent = "加载失败，请刷新页面重试";
  }
}

function renderActionButtons(file) {
  if (adminView === "recycle") {
    return `
      <button class="btn btn-copy-small admin-row-restore" type="button">恢复</button>
      <button class="btn btn-delete admin-row-purge" type="button">永久移除</button>
    `;
  }

  return `
    <a href="${file.downloadUrl}" class="btn btn-download" download>下载</a>
    <button class="btn btn-delete admin-row-delete" type="button">删除</button>
  `;
}

function handleRowSelectionChange(e) {
  if (e.target.checked) {
    selectedFileIds.add(e.target.value);
  } else {
    selectedFileIds.delete(e.target.value);
  }

  updateBulkActionState();
}

function clearSelection() {
  selectedFileIds = new Set();
  if (selectAllFiles) {
    selectAllFiles.checked = false;
    selectAllFiles.indeterminate = false;
  }
  updateBulkActionState();
}

function updateBulkActionState() {
  const selectedCount = selectedFileIds.size;
  const checkboxes = adminFileTableBody.querySelectorAll(".admin-file-checkbox");

  if (selectAllFiles) {
    selectAllFiles.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
    selectAllFiles.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
    selectAllFiles.disabled = checkboxes.length === 0;
  }

  bulkDeleteBtn.disabled = selectedCount === 0;
  bulkRestoreBtn.disabled = selectedCount === 0;
  bulkPurgeBtn.disabled = selectedCount === 0;

  bulkDeleteBtn.textContent = selectedCount > 0 ? `批量删除 (${selectedCount})` : "批量删除";
  bulkRestoreBtn.textContent = selectedCount > 0 ? `批量恢复 (${selectedCount})` : "批量恢复";
  bulkPurgeBtn.textContent = selectedCount > 0 ? `永久移除 (${selectedCount})` : "永久移除";
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
  showSingleActionConfirm("delete", fileId, fileName);
};

function showSingleActionConfirm(action, fileId, fileName) {
  pendingAction = action;
  pendingFileIds = [fileId];
  configureActionModal(action, fileName, 1);
  deleteModal.style.display = "flex";
}

function showBulkActionConfirm(action) {
  const ids = Array.from(selectedFileIds);
  if (ids.length === 0) return;

  pendingAction = action;
  pendingFileIds = ids;
  configureActionModal(action, "", ids.length);
  deleteModal.style.display = "flex";
}

function configureActionModal(action, fileName, count) {
  if (action === "delete") {
    deleteModalText.innerHTML = count === 1
      ? `确定要删除文件 <strong id="deleteFileName">${escapeHtml(fileName)}</strong> 吗？`
      : `确定要删除选中的 ${count} 个文件吗？`;
    deleteModalWarning.textContent = "文件会进入回收站，可在管理后台恢复。";
    confirmDeleteBtn.textContent = "确认删除";
    return;
  }

  if (action === "restore") {
    deleteModalText.innerHTML = count === 1
      ? `确定要恢复文件 <strong id="deleteFileName">${escapeHtml(fileName)}</strong> 吗？`
      : `确定要恢复选中的 ${count} 个文件吗？`;
    deleteModalWarning.textContent = "恢复后文件会重新出现在公开文件列表。";
    confirmDeleteBtn.textContent = "确认恢复";
    return;
  }

  deleteModalText.innerHTML = count === 1
    ? `确定要永久移除文件 <strong id="deleteFileName">${escapeHtml(fileName)}</strong> 吗？`
    : `确定要永久移除选中的 ${count} 个文件吗？`;
  deleteModalWarning.textContent = "只会移除数据库 metadata，不会删除 GitHub 中的文件分片。此操作不可恢复。";
  confirmDeleteBtn.textContent = "永久移除";
}

function hideDeleteModal() {
  deleteModal.style.display = "none";
  pendingAction = null;
  pendingFileIds = [];
}

async function confirmDelete() {
  if (!pendingAction || pendingFileIds.length === 0) return;

  confirmDeleteBtn.disabled = true;
  const originalText = confirmDeleteBtn.textContent;
  confirmDeleteBtn.textContent = getActionProgressText(pendingAction);

  try {
    const res = await fetch(pendingAction === "delete" ? "/api/admin/delete" : "/api/admin/recycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: pendingAction === "delete" ? undefined : pendingAction,
        fileIds: pendingFileIds,
        password: adminPwd,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(`删除失败: ${data.error}`);
      return;
    }

    showToast(getActionSuccessText(pendingAction, pendingFileIds.length));
    hideDeleteModal();
    loadAdminFileList();
  } catch (err) {
    showToast(`${getActionName(pendingAction)}失败: ${err.message}`);
  } finally {
    confirmDeleteBtn.disabled = false;
    confirmDeleteBtn.textContent = originalText;
  }
}

function getActionName(action) {
  if (action === "restore") return "恢复";
  if (action === "purge") return "永久移除";
  return "删除";
}

function getActionProgressText(action) {
  return `${getActionName(action)}中...`;
}

function getActionSuccessText(action, count) {
  if (action === "restore") return count === 1 ? "文件已恢复" : `${count} 个文件已恢复`;
  if (action === "purge") return count === 1 ? "文件 metadata 已永久移除" : `${count} 个文件 metadata 已永久移除`;
  return count === 1 ? "文件已移入回收站" : `${count} 个文件已移入回收站`;
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
