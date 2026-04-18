// POST /api/upload/init - Initialize a new file upload or resume an existing one
import { PART_SIZE, MAX_FILE_SIZE } from "../../lib/constants.js";
import { getFile, setFile, findByHash, ensureTables } from "../../lib/db.js";
import { selectBucket } from "../../lib/github.js";

export async function onRequestPost(context) {
  try {
    const { fileName, fileSize, fileHash } = await context.request.json();

    // Validate inputs
    if (!fileName || !fileSize || !fileHash) {
      return jsonResponse({ error: "Missing required fields: fileName, fileSize, fileHash" }, 400);
    }

    if (fileSize > MAX_FILE_SIZE) {
      return jsonResponse({ error: `File size exceeds maximum of 5GB` }, 400);
    }

    const db = context.env.FILES;
    const pat = context.env.GITHUB_PRIVATE_KEY;

    // Ensure D1 tables exist
    await ensureTables(db);

    // Check for existing upload with same hash (resume support)
    const existing = await findByHash(db, fileHash);
    if (existing) {
      const uploadedParts = existing.parts
        .filter((p) => p.status === "done")
        .map((p) => p.index);

      return jsonResponse({
        fileId: existing.fileId,
        fileName: existing.fileName,
        fileSize: existing.fileSize,
        totalParts: existing.totalParts,
        uploadedParts,
        bucketRepo: existing.bucketRepo,
        resumed: true,
      });
    }

    // Generate a new file ID
    const fileId = generateFileId();

    // Calculate total parts
    const totalParts = Math.ceil(fileSize / PART_SIZE);

    // Select a bucket for this file
    const bucketRepo = await selectBucket(pat, fileSize);

    // Build parts list
    const parts = [];
    for (let i = 0; i < totalParts; i++) {
      const partStart = i * PART_SIZE;
      const partSize = Math.min(PART_SIZE, fileSize - partStart);
      parts.push({
        index: i,
        size: partSize,
        status: "pending",
        sha: null,
      });
    }

    // Create file record
    const fileRecord = {
      fileId,
      fileName,
      fileSize,
      fileHash,
      status: "uploading",
      bucketRepo,
      totalParts,
      parts,
      downloadUrl: `/api/download/${fileId}`,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    await setFile(db, fileId, fileRecord);

    // Hash is stored in the files table, no separate mapping needed

    return jsonResponse({
      fileId,
      fileName,
      fileSize,
      totalParts,
      uploadedParts: [],
      bucketRepo,
      resumed: false,
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function generateFileId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const timestamp = Date.now().toString(36);
  let random = "";
  for (let i = 0; i < 8; i++) {
    random += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${timestamp}-${random}`;
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
