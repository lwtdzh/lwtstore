// POST /api/admin/delete - Delete a file (admin only, password protected)
import { getFile, deleteFile } from "../../lib/kv.js";

export async function onRequestPost(context) {
  try {
    const { fileId, password } = await context.request.json();

    if (!fileId || !password) {
      return jsonResponse({ error: "Missing required fields: fileId, password" }, 400);
    }

    // Verify admin password
    const adminPwd = context.env.ADMIN_PWD;
    if (!adminPwd || password !== adminPwd) {
      return jsonResponse({ error: "Unauthorized: invalid password" }, 401);
    }

    const filesKv = context.env.FILES;

    // Check file exists
    const file = await getFile(filesKv, fileId);
    if (!file) {
      return jsonResponse({ error: "File not found" }, 404);
    }

    // Delete from KV
    await deleteFile(filesKv, fileId);

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
