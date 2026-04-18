// GET /api/download/{fileId} - Download a file with HTTP Range support
// Supports: multi-thread downloads, resume at disconnected position
import { getFile } from "../../lib/db.js";
import { fetchRawFile } from "../../lib/github.js";
import { PART_SIZE } from "../../lib/constants.js";

/**
 * Build common response headers shared by GET / HEAD / OPTIONS.
 * Includes Content-Length, Accept-Ranges, ETag, Last-Modified, CORS, etc.
 */
function buildCommonHeaders(fileId, fileName, totalSize, completedAt) {
  return {
    "Accept-Ranges": "bytes",
    "Content-Length": totalSize.toString(),
    "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Content-Type": "application/octet-stream",
    "ETag": `"${fileId}"`,
    "Last-Modified": completedAt
      ? new Date(completedAt).toUTCString()
      : new Date().toUTCString(),
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, If-Modified-Since",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified",
  };
}

/**
 * Handle CORS preflight requests.
 * Multi-thread download tools send OPTIONS before Range requests.
 */
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, If-Modified-Since",
      "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function onRequestGet(context) {
  try {
    const fileId = context.params.fileId;
    const db = context.env.FILES;
    const pat = context.env.GITHUB_PRIVATE_KEY;

    const metadata = await getFile(db, fileId);
    if (!metadata) {
      return new Response("File not found", { status: 404 });
    }
    if (metadata.status !== "finished") {
      return new Response("File upload not yet completed", { status: 404 });
    }

    const totalSize = metadata.fileSize;
    const fileName = metadata.fileName;
    const etag = `"${fileId}"`;
    const lastModified = metadata.completedAt
      ? new Date(metadata.completedAt).toUTCString()
      : new Date().toUTCString();
    const commonHeaders = buildCommonHeaders(fileId, fileName, totalSize, metadata.completedAt);

    // --- Handle conditional requests (If-None-Match / If-Modified-Since) ---
    const ifNoneMatch = context.request.headers.get("If-None-Match");
    if (ifNoneMatch && ifNoneMatch.replace(/W\//, "") === etag) {
      return new Response(null, { status: 304, headers: commonHeaders });
    }

    const ifModifiedSince = context.request.headers.get("If-Modified-Since");
    if (ifModifiedSince && new Date(ifModifiedSince) >= new Date(lastModified)) {
      return new Response(null, { status: 304, headers: commonHeaders });
    }

    // --- Parse Range header ---
    const rangeHeader = context.request.headers.get("Range");
    let rangeStart = 0;
    let rangeEnd = totalSize - 1;
    let isPartial = false;

    if (rangeHeader) {
      // If-Range: only honour Range when the resource hasn't changed
      const ifRange = context.request.headers.get("If-Range");
      let rangeValid = true;
      if (ifRange) {
        // If-Range can be an ETag or a date
        if (ifRange.startsWith('"') || ifRange.startsWith("W/")) {
          rangeValid = ifRange.replace(/W\//, "") === etag;
        } else {
          rangeValid = new Date(ifRange) >= new Date(lastModified);
        }
      }

      if (rangeValid) {
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (match) {
          if (match[1] !== "") rangeStart = parseInt(match[1], 10);
          if (match[2] !== "") rangeEnd = parseInt(match[2], 10);
          else rangeEnd = totalSize - 1;

          if (rangeStart >= totalSize || rangeEnd >= totalSize || rangeStart > rangeEnd) {
            return new Response("Range Not Satisfiable", {
              status: 416,
              headers: { "Content-Range": `bytes */${totalSize}`, ...commonHeaders },
            });
          }
          isPartial = true;
        }
      }
      // If rangeValid is false, ignore Range and serve full content (per RFC 7233)
    }

    const contentLength = rangeEnd - rangeStart + 1;

    // Determine which GitHub parts we need
    const startPartIndex = Math.floor(rangeStart / PART_SIZE);
    const endPartIndex = Math.floor(rangeEnd / PART_SIZE);

    // Use FixedLengthStream so Cloudflare preserves Content-Length instead of chunked encoding.
    // This is critical for browsers to show file size and for download managers to support resume.
    const { readable, writable } = new FixedLengthStream(contentLength);
    const writer = writable.getWriter();

    const assemblePromise = assembleParts(
      writer, pat, metadata, startPartIndex, endPartIndex, rangeStart, rangeEnd
    );
    assemblePromise.catch(async (err) => {
      try { await writer.abort(err); } catch (_) { /* already closed */ }
    });

    const responseHeaders = {
      ...commonHeaders,
      "Content-Length": contentLength.toString(),
    };

    if (isPartial) {
      responseHeaders["Content-Range"] = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
      return new Response(readable, { status: 206, headers: responseHeaders });
    }

    return new Response(readable, { status: 200, headers: responseHeaders });
  } catch (err) {
    return new Response(`Download error: ${err.message}`, { status: 500 });
  }
}

/**
 * HEAD handler — download managers / browsers probe file size here.
 * Returns all the same headers as GET but with no body.
 */
export async function onRequestHead(context) {
  try {
    const fileId = context.params.fileId;
    const db = context.env.FILES;

    const metadata = await getFile(db, fileId);
    if (!metadata || metadata.status !== "finished") {
      return new Response(null, { status: 404 });
    }

    return new Response(null, {
      status: 200,
      headers: buildCommonHeaders(
        fileId, metadata.fileName, metadata.fileSize, metadata.completedAt
      ),
    });
  } catch (err) {
    return new Response(null, { status: 500 });
  }
}

/**
 * Assemble file parts into a stream, handling byte ranges across parts
 */
async function assembleParts(writer, pat, metadata, startPartIndex, endPartIndex, rangeStart, rangeEnd) {
  try {
    for (let i = startPartIndex; i <= endPartIndex; i++) {
      const partPath = `${metadata.fileId}/part_${i.toString().padStart(4, "0")}`;

      // Fetch the part from GitHub
      const response = await fetchRawFile(pat, metadata.bucketRepo, partPath);
      const partData = new Uint8Array(await response.arrayBuffer());

      // Calculate the slice of this part we need
      const partGlobalStart = i * PART_SIZE;
      const partGlobalEnd = partGlobalStart + metadata.parts[i].size - 1;

      // Determine local byte offsets within this part
      let localStart = 0;
      let localEnd = metadata.parts[i].size - 1;

      if (i === startPartIndex) {
        localStart = rangeStart - partGlobalStart;
      }
      if (i === endPartIndex) {
        localEnd = rangeEnd - partGlobalStart;
      }

      // Write the relevant slice
      const slice = partData.slice(localStart, localEnd + 1);
      await writer.write(slice);
    }

    await writer.close();
  } catch (err) {
    try {
      await writer.abort(err);
    } catch (e) {
      // Already closed
    }
    throw err;
  }
}
