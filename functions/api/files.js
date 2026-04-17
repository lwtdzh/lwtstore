// GET /api/files - List all uploaded files
import { listFiles } from "../lib/kv.js";

export async function onRequestGet(context) {
  try {
    const filesKv = context.env.FILES;
    const allFiles = await listFiles(filesKv);

    // Only return finished files to visitors
    const finishedFiles = allFiles.filter((f) => f.status === "finished");

    // Sort by creation date, newest first
    finishedFiles.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return new Response(JSON.stringify(finishedFiles), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
