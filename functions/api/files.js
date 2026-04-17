// GET /api/files - List uploaded files with pagination and search
import { listFilesPaged } from "../lib/kv.js";

export async function onRequestGet(context) {
  try {
    const filesKv = context.env.FILES;
    const url = new URL(context.request.url);

    const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize")) || 20));
    const search = (url.searchParams.get("search") || "").trim();

    const result = await listFilesPaged(filesKv, { page, pageSize, search });

    return new Response(JSON.stringify(result), {
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
