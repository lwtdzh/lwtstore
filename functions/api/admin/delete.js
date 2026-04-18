// POST /api/admin/delete - Delete a file (admin only, password protected)
// Deletes both the D1 metadata and the actual file parts from GitHub
import { getFile, deleteFile } from "../../lib/db.js";
import { deleteFileParts } from "../../lib/github.js";

export async function onRequestPost(context) {
  try {
    const { fileId, password } = await context.request.json();

    if (!fileId || !password) {
      return jsonResponse({ error: "Missing required fields: fileId, password" }, 400);
    }

    // Verify admin password (trim to handle env variable whitespace)
    const adminPwd = (context.env.ADMIN_PWD || "").trim();
    if (!adminPwd || password.trim() !== adminPwd) {
      return jsonResponse({ error: "Unauthorized: invalid password" }, 401);
    }

    const db = context.env.FILES;
    const pat = context.env.GITHUB_PRIVATE_KEY;

    // Check file exists
    const file = await getFile(db, fileId);
    if (!file) {
      return jsonResponse({ error: "File not found" }, 404);
    }

    // Delete file parts from GitHub first (best-effort)
    const githubErrors = [];
    if (pat && file.bucketRepo && file.parts && file.parts.length > 0) {
      try {
        await deleteFileParts(pat, file.bucketRepo, fileId, file.parts);
      } catch (e) {
        githubErrors.push(e.message);
      }
    }

    // Delete metadata from D1
    await deleteFile(db, fileId);

    const result = {
      success: true,
      message: `File "${file.fileName}" deleted successfully`,
      fileId,
    };

    if (githubErrors.length > 0) {
      result.warnings = githubErrors;
    }

    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
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
