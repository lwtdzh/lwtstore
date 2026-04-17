// GET /api/upload/status?fileId={fileId} - Check upload status
import { getFile } from "../../lib/kv.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const fileId = url.searchParams.get("fileId");

    if (!fileId) {
      return jsonResponse({ error: "Missing required parameter: fileId" }, 400);
    }

    const filesKv = context.env.FILES;

    const metadata = await getFile(filesKv, fileId);
    if (!metadata) {
      return jsonResponse({ error: "File not found." }, 404);
    }

    const uploadedParts = metadata.parts
      .filter((p) => p.status === "done")
      .map((p) => p.index);

    return jsonResponse({
      fileId: metadata.fileId,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      status: metadata.status,
      totalParts: metadata.totalParts,
      uploadedParts,
      bucketRepo: metadata.bucketRepo,
      createdAt: metadata.createdAt,
      completedAt: metadata.completedAt,
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
