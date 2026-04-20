// Temporary debug endpoint to diagnose Range request failures
// GET /api/debug-download?fileId=xxx&start=500000000&end=500010000
import { getFile } from "../lib/db.js";
import { fetchRawFile } from "../lib/github.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const fileId = url.searchParams.get("fileId");
    const rangeStart = parseInt(url.searchParams.get("start") || "0", 10);
    const rangeEnd = parseInt(url.searchParams.get("end") || "10000", 10);

    const db = context.env.FILES;
    const pat = context.env.GITHUB_PRIVATE_KEY;

    const metadata = await getFile(db, fileId);
    if (!metadata) {
      return jsonResp({ error: "File not found" }, 404);
    }

    // Build part offsets
    const partOffsets = [];
    partOffsets[0] = 0;
    for (let i = 0; i < metadata.parts.length; i++) {
      partOffsets[i + 1] = partOffsets[i] + metadata.parts[i].size;
    }

    // Find part index for rangeStart
    let startPartIndex = 0;
    for (let i = partOffsets.length - 2; i >= 0; i--) {
      if (partOffsets[i] <= rangeStart) {
        startPartIndex = i;
        break;
      }
    }

    const partSize = metadata.parts[startPartIndex].size;
    const partGlobalStart = partOffsets[startPartIndex];
    const localStart = rangeStart - partGlobalStart;
    const localEnd = rangeEnd - partGlobalStart;

    const diagnostics = {
      fileId,
      totalParts: metadata.parts.length,
      rangeStart,
      rangeEnd,
      startPartIndex,
      partSize,
      partGlobalStart,
      localStart,
      localEnd,
      partOffsets: partOffsets.slice(0, Math.min(30, partOffsets.length)),
    };

    // Try to fetch the part
    const partPath = `${fileId}/part_${startPartIndex.toString().padStart(4, "0")}`;
    diagnostics.partPath = partPath;

    try {
      const fetchStart = Date.now();
      const response = await fetchRawFile(pat, metadata.bucketRepo, partPath);
      diagnostics.fetchTimeMs = Date.now() - fetchStart;
      diagnostics.fetchStatus = response.status;
      diagnostics.fetchHeaders = Object.fromEntries(response.headers.entries());

      // Try to read just a small amount to verify the stream works
      const reader = response.body.getReader();
      let totalRead = 0;
      let skipped = 0;
      let chunks = 0;
      const readStart = Date.now();

      while (totalRead < localEnd + 1 && chunks < 5000) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks++;
        totalRead += value.length;
        if (totalRead <= localStart) {
          skipped += value.length;
        }
      }
      reader.releaseLock();

      diagnostics.readTimeMs = Date.now() - readStart;
      diagnostics.totalBytesRead = totalRead;
      diagnostics.bytesSkipped = skipped;
      diagnostics.chunksRead = chunks;
      diagnostics.success = true;
    } catch (fetchErr) {
      diagnostics.fetchError = fetchErr.message;
      diagnostics.success = false;
    }

    return jsonResp(diagnostics);
  } catch (err) {
    return jsonResp({ error: err.message, stack: err.stack }, 500);
  }
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
