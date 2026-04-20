// Temporary debug endpoint to list actual parts on GitHub
// GET /api/debug-parts?fileId=xxx
import { getFile } from "../lib/db.js";
import { getOwner } from "../lib/github.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const fileId = url.searchParams.get("fileId");

    const db = context.env.FILES;
    const pat = context.env.GITHUB_PRIVATE_KEY;

    const metadata = await getFile(db, fileId);
    if (!metadata) {
      return jsonResp({ error: "File not found" }, 404);
    }

    const owner = await getOwner(pat);
    const repo = metadata.bucketRepo;

    // List files in the fileId directory on GitHub
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${fileId}`,
      {
        headers: {
          "Authorization": `Bearer ${pat}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "LwtStore/1.0",
        },
      }
    );

    let githubFiles = [];
    if (res.ok) {
      const data = await res.json();
      githubFiles = data.map((f) => ({ name: f.name, size: f.size }));
    }

    // Also check actual sizes by HEAD request for first few and last few parts
    const sampleParts = [0, 1, 2, 13, 26];
    const partSizes = {};
    for (const idx of sampleParts) {
      if (idx >= metadata.parts.length) continue;
      const partPath = `${fileId}/part_${idx.toString().padStart(4, "0")}`;
      try {
        const partRes = await fetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/main/${partPath}`,
          {
            method: "HEAD",
            headers: {
              "Authorization": `Bearer ${pat}`,
              "User-Agent": "LwtStore/1.0",
            },
          }
        );
        partSizes[`part_${idx}`] = {
          status: partRes.status,
          contentLength: partRes.headers.get("content-length"),
        };
      } catch (e) {
        partSizes[`part_${idx}`] = { error: e.message };
      }
    }

    return jsonResp({
      fileId,
      dbTotalParts: metadata.totalParts,
      dbFileSize: metadata.fileSize,
      dbPartSizes: metadata.parts.map((p) => p.size),
      githubFileCount: githubFiles.length,
      githubFiles,
      samplePartSizes: partSizes,
    });
  } catch (err) {
    return jsonResp({ error: err.message }, 500);
  }
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
