// POST /api/upload/complete - Finalize a file upload
import { getFile, updateFileStatus } from "../../lib/db.js";
import { getActualPartSizes } from "../../lib/github.js";

export async function onRequestPost(context) {
  try {
    const { fileId } = await context.request.json();

    if (!fileId) {
      return jsonResponse({ error: "Missing required field: fileId" }, 400);
    }

    const db = context.env.FILES;

    // Get file record
    const metadata = await getFile(db, fileId);
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

    // Verify actual part sizes on GitHub match DB records.
    // This catches silent corruption (e.g. truncated uploads, PART_SIZE
    // changes mid-upload) before marking the file as "finished".
    const pat = context.env.GITHUB_PRIVATE_KEY;
    const actualSizes = await getActualPartSizes(pat, metadata.bucketRepo, fileId);

    if (actualSizes.length !== metadata.parts.length) {
      return jsonResponse({
        error: `Part count mismatch: DB has ${metadata.parts.length} parts but GitHub has ${actualSizes.length}`,
      }, 500);
    }

    const sizeMismatches = [];
    let actualTotal = 0;
    for (let i = 0; i < actualSizes.length; i++) {
      actualTotal += actualSizes[i];
      if (actualSizes[i] !== metadata.parts[i].size) {
        sizeMismatches.push({
          partIndex: i,
          expected: metadata.parts[i].size,
          actual: actualSizes[i],
        });
      }
    }

    if (sizeMismatches.length > 0) {
      return jsonResponse({
        error: "Part size mismatch detected — some parts may be corrupted",
        mismatches: sizeMismatches,
        expectedTotal: metadata.fileSize,
        actualTotal,
      }, 500);
    }

    // Update only the status column — avoids rewriting all parts rows
    const completedAt = new Date().toISOString();
    await updateFileStatus(db, fileId, "finished", completedAt);

    // Hash lookup uses status='uploading' filter, so no separate cleanup needed

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
