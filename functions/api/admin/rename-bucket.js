// POST /api/admin/rename-bucket - One-time migration: rename bucket repo and update KV records
// This endpoint should be removed after migration is complete.

import { listFiles, setFile } from "../../lib/kv.js";
import { GITHUB_API } from "../../lib/constants.js";

export async function onRequestPost(context) {
  try {
    const { oldName, newName } = await context.request.json();

    if (!oldName || !newName) {
      return jsonResponse({ error: "Missing oldName or newName" }, 400);
    }

    const pat = context.env.GITHUB_PRIVATE_KEY;
    const filesKv = context.env.FILES;

    // Step 1: Rename the GitHub repository
    const ownerRes = await fetch(`${GITHUB_API}/user`, {
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "LwtStore/1.0",
      },
    });
    const ownerData = await ownerRes.json();
    const owner = ownerData.login;

    const renameRes = await fetch(`${GITHUB_API}/repos/${owner}/${oldName}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "LwtStore/1.0",
      },
      body: JSON.stringify({ name: newName }),
    });

    let renameResult;
    if (renameRes.ok) {
      renameResult = "Repo renamed successfully";
    } else {
      const err = await renameRes.text();
      renameResult = `Repo rename failed (${renameRes.status}): ${err}`;
    }

    // Step 2: Update all KV records that reference the old bucket name
    const allFiles = await listFiles(filesKv);
    let updatedCount = 0;

    for (const file of allFiles) {
      if (file.bucketRepo === oldName) {
        file.bucketRepo = newName;
        await setFile(filesKv, file.fileId, file);
        updatedCount++;
      }
    }

    return jsonResponse({
      success: true,
      renameResult,
      kvRecordsUpdated: updatedCount,
      totalFiles: allFiles.length,
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
