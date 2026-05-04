// POST /api/admin/delete - Delete a file (admin only, password protected)
// Moves D1 metadata into the admin-only recycle bin. GitHub parts are left untouched.
import { getFile, moveFileToRecycleBin } from "../../lib/db.js";

export async function onRequestPost(context) {
  try {
    const { fileId, fileIds, password } = await context.request.json();
    const ids = normalizeFileIds(fileId, fileIds);

    if (ids.length === 0 || !password) {
      return jsonResponse({ error: "Missing required fields: fileId/fileIds, password" }, 400);
    }

    // Verify admin password (trim to handle env variable whitespace)
    const adminPwd = (context.env.ADMIN_PWD || "").trim();
    if (!adminPwd || password.trim() !== adminPwd) {
      return jsonResponse({ error: "Unauthorized: invalid password" }, 401);
    }

    const db = context.env.FILES;
    const deletedAt = new Date().toISOString();
    const moved = [];
    const errors = [];

    for (const id of ids) {
      const file = await getFile(db, id);
      if (!file || file.status !== "finished") {
        errors.push({ fileId: id, error: "File not found" });
        continue;
      }

      const changes = await moveFileToRecycleBin(db, id, deletedAt);
      if (changes > 0) {
        moved.push({
          fileId: id,
          fileName: file.fileName,
        });
      } else {
        errors.push({ fileId: id, error: "File not found" });
      }
    }

    if (moved.length === 0) {
      return jsonResponse({ error: "File not found", errors }, 404);
    }

    const result = {
      success: true,
      message: moved.length === 1
        ? `File "${moved[0].fileName}" moved to recycle bin`
        : `${moved.length} files moved to recycle bin`,
      fileId: moved.length === 1 ? moved[0].fileId : undefined,
      fileIds: moved.map((file) => file.fileId),
      deletedAt,
      errors,
    };

    return jsonResponse(result);
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
    },
  });
}
