// GET /api/download/{fileId} - Download a file with HTTP Range support
import { getMetadata } from "../../lib/kv.js";
import { fetchRawFile } from "../../lib/github.js";
import { PART_SIZE } from "../../lib/constants.js";

export async function onRequestGet(context) {
  try {
    const fileId = context.params.fileId;
    const kv = context.env.KV_STORE;
    const pat = context.env.GITHUB_PRIVATE_KEY;

    // Get file metadata
    const metadata = await getMetadata(kv, fileId);
    if (!metadata) {
      return new Response("File not found", { status: 404 });
    }

    if (metadata.status !== "finished") {
      return new Response("File upload not yet completed", { status: 404 });
    }

    const totalSize = metadata.fileSize;
    const fileName = metadata.fileName;
    const rangeHeader = context.request.headers.get("Range");

    // Common response headers
    const commonHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Type": "application/octet-stream",
      "ETag": `"${fileId}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
    };

    let rangeStart = 0;
    let rangeEnd = totalSize - 1;
    let isPartial = false;

    // Parse Range header
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        if (match[1] !== "") {
          rangeStart = parseInt(match[1], 10);
        }
        if (match[2] !== "") {
          rangeEnd = parseInt(match[2], 10);
        } else {
          rangeEnd = totalSize - 1;
        }

        // Validate range
        if (rangeStart >= totalSize || rangeEnd >= totalSize || rangeStart > rangeEnd) {
          return new Response("Range Not Satisfiable", {
            status: 416,
            headers: {
              "Content-Range": `bytes */${totalSize}`,
              ...commonHeaders,
            },
          });
        }

        isPartial = true;
      }
    }

    const contentLength = rangeEnd - rangeStart + 1;

    // Determine which parts we need to fetch
    const startPartIndex = Math.floor(rangeStart / PART_SIZE);
    const endPartIndex = Math.floor(rangeEnd / PART_SIZE);

    // Build a readable stream that assembles parts
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Start assembling parts in the background
    const assemblePromise = assembleParts(
      writer,
      pat,
      metadata,
      startPartIndex,
      endPartIndex,
      rangeStart,
      rangeEnd
    );

    // Don't await - let it stream
    assemblePromise.catch(async (err) => {
      try {
        await writer.abort(err);
      } catch (e) {
        // Writer may already be closed
      }
    });

    const responseHeaders = {
      ...commonHeaders,
      "Content-Length": contentLength.toString(),
    };

    if (isPartial) {
      responseHeaders["Content-Range"] = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
      return new Response(readable, {
        status: 206,
        headers: responseHeaders,
      });
    }

    return new Response(readable, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(`Download error: ${err.message}`, { status: 500 });
  }
}

// Also handle HEAD requests for download managers
export async function onRequestHead(context) {
  try {
    const fileId = context.params.fileId;
    const kv = context.env.KV_STORE;

    const metadata = await getMetadata(kv, fileId);
    if (!metadata || metadata.status !== "finished") {
      return new Response(null, { status: 404 });
    }

    return new Response(null, {
      status: 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": metadata.fileSize.toString(),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(metadata.fileName)}"; filename*=UTF-8''${encodeURIComponent(metadata.fileName)}`,
        "Content-Type": "application/octet-stream",
        "ETag": `"${fileId}"`,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
      },
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
