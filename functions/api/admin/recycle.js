// POST /api/admin/recycle - List, restore, or permanently purge recycled metadata.
import {
  deleteFile,
  getFile,
  listFilesPaged,
  restoreFileFromRecycleBin,
} from "../../lib/db.js";

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const password = body.password;
    const action = body.action || "list";

    if (!password) {
      return jsonResponse({ error: "Missing required field: password" }, 400);
    }

    const adminPwd = (context.env.ADMIN_PWD || "").trim();
    if (!adminPwd || password.trim() !== adminPwd) {
      return jsonResponse({ error: "Unauthorized: invalid password" }, 401);
    }

    const db = context.env.FILES;

    if (action === "list") {
      const page = Math.max(1, parseInt(body.page, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(body.pageSize, 10) || 20));
      const search = (body.search || "").trim();

      const result = await listFilesPaged(db, {
        page,
        pageSize,
        search,
        status: "deleted",
      });

      return jsonResponse(result);
    }

    const ids = normalizeFileIds(body.fileId, body.fileIds);
    if (ids.length === 0) {
      return jsonResponse({ error: "Missing required field: fileId/fileIds" }, 400);
    }

    if (action === "restore") {
      const restored = [];
      const errors = [];

      for (const id of ids) {
        const file = await getFile(db, id);
        if (!file || file.status !== "deleted") {
          errors.push({ fileId: id, error: "File not found in recycle bin" });
          continue;
        }

        const changes = await restoreFileFromRecycleBin(db, id);
        if (changes > 0) {
          restored.push({ fileId: id, fileName: file.fileName });
        } else {
          errors.push({ fileId: id, error: "File not found in recycle bin" });
        }
      }

      if (restored.length === 0) {
        return jsonResponse({ error: "File not found in recycle bin", errors }, 404);
      }

      return jsonResponse({
        success: true,
        message: restored.length === 1
          ? `File "${restored[0].fileName}" restored`
          : `${restored.length} files restored`,
        fileId: restored.length === 1 ? restored[0].fileId : undefined,
        fileIds: restored.map((file) => file.fileId),
        errors,
      });
    }

    if (action === "purge") {
      const purged = [];
      const errors = [];

      for (const id of ids) {
        const file = await getFile(db, id);
        if (!file || file.status !== "deleted") {
          errors.push({ fileId: id, error: "File not found in recycle bin" });
          continue;
        }

        await deleteFile(db, id);
        purged.push({ fileId: id, fileName: file.fileName });
      }

      if (purged.length === 0) {
        return jsonResponse({ error: "File not found in recycle bin", errors }, 404);
      }

      return jsonResponse({
        success: true,
        message: purged.length === 1
          ? `File "${purged[0].fileName}" permanently removed from metadata`
          : `${purged.length} files permanently removed from metadata`,
        fileId: purged.length === 1 ? purged[0].fileId : undefined,
        fileIds: purged.map((file) => file.fileId),
        errors,
      });
    }

    return jsonResponse({ error: "Invalid action" }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function normalizeFileIds(fileId, fileIds) {
  const ids = [];
  if (typeof fileId === "string" && fileId.trim()) ids.push(fileId.trim());
  if (Array.isArray(fileIds)) {
    for (const id of fileIds) {
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  return [...new Set(ids)].slice(0, 100);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    },
  });
}
