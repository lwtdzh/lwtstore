// POST /api/upload/part - Upload a single file part
import { getFile, updatePart, getUploadedParts } from "../../lib/db.js";
import { uploadFile } from "../../lib/github.js";

export async function onRequestPost(context) {
  try {
    const formData = await context.request.formData();
    const fileId = formData.get("fileId");
    const partIndexStr = formData.get("partIndex");
    const dataBlob = formData.get("data");

    if (!fileId || partIndexStr === null || !dataBlob) {
      return jsonResponse({ error: "Missing required fields: fileId, partIndex, data" }, 400);
    }

    const partIndex = parseInt(partIndexStr, 10);
    const db = context.env.FILES;
    const pat = context.env.GITHUB_PRIVATE_KEY;

    // Get file record
    const metadata = await getFile(db, fileId);
    if (!metadata) {
      return jsonResponse({ error: "File not found. Please initialize upload first." }, 404);
    }

    if (metadata.status !== "uploading") {
      return jsonResponse({ error: "File upload already completed." }, 400);
    }

    if (partIndex < 0 || partIndex >= metadata.totalParts) {
      return jsonResponse({ error: `Invalid part index. Must be 0-${metadata.totalParts - 1}` }, 400);
    }

    // Check if this part is already uploaded
    if (metadata.parts[partIndex].status === "done") {
      const uploadedParts = metadata.parts
        .filter((p) => p.status === "done")
        .map((p) => p.index);
      return jsonResponse({
        success: true,
        partIndex,
        uploadedParts,
        message: "Part already uploaded",
        skipped: true,
      });
    }

    // Read the blob data as ArrayBuffer then convert to Base64
    const arrayBuffer = await dataBlob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    const contentBase64 = uint8ArrayToBase64(uint8Array);

    // Upload to GitHub
    const partFileName = `part_${partIndex.toString().padStart(4, "0")}`;
    const repoPath = `${fileId}/${partFileName}`;

    const result = await uploadFile(
      pat,
      metadata.bucketRepo,
      repoPath,
      contentBase64,
      `Upload part ${partIndex} of ${metadata.fileName}`
    );

    // Update only this single part (much faster than rewriting all parts)
    await updatePart(db, fileId, partIndex, "done", result.sha);

    const uploadedParts = await getUploadedParts(db, fileId);

    return jsonResponse({
      success: true,
      partIndex,
      uploadedParts,
      totalParts: metadata.totalParts,
      skipped: false,
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

/**
 * Convert Uint8Array to Base64 string
 * Works in Cloudflare Workers environment
 */
function uint8ArrayToBase64(uint8Array) {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
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
