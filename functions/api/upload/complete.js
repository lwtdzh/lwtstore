// POST /api/upload/complete - Finalize a file upload
import { getFile, setFile } from "../../lib/kv.js";

export async function onRequestPost(context) {
  try {
    const { fileId } = await context.request.json();

    if (!fileId) {
      return jsonResponse({ error: "Missing required field: fileId" }, 400);
    }

    const filesKv = context.env.FILES;

    // Get file record
    const metadata = await getFile(filesKv, fileId);
    if (!metadata) {
      return jsonResponse({ error: "File not found." }, 404);
    }

    if (metadata.status === "finished") {
      return jsonResponse({
        success: true,
        message: "File already completed",
        downloadUrl: `/api/download/${fileId}`,
      });
    }

    // Verify all parts are uploaded
    const pendingParts = metadata.parts.filter((p) => p.status !== "done");
    if (pendingParts.length > 0) {
      return jsonResponse({
        error: "Not all parts have been uploaded",
        pendingParts: pendingParts.map((p) => p.index),
      }, 400);
    }

    // Update file record status
    metadata.status = "finished";
    metadata.completedAt = new Date().toISOString();
    await setFile(filesKv, fileId, metadata);

    return jsonResponse({
      success: true,
      downloadUrl: `/api/download/${fileId}`,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
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
