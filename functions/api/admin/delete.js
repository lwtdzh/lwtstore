// POST /api/admin/delete - Delete a file (admin only, password protected)
import { getFile, deleteFile } from "../../lib/db.js";

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

    // Check file exists
    const file = await getFile(db, fileId);
    if (!file) {
      return jsonResponse({ error: "File not found" }, 404);
    }

    // Delete from D1
    await deleteFile(db, fileId);

    return jsonResponse({
      success: true,
      message: `File "${file.fileName}" deleted successfully`,
      fileId,
    });
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
