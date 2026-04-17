// GET /api/files - List all uploaded files
import { getIndex } from "../lib/kv.js";

export async function onRequestGet(context) {
  try {
    const kv = context.env.KV_STORE;
    const index = await getIndex(kv);

    // Only return finished files to visitors
    const finishedFiles = index.filter((f) => f.status === "finished");

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
