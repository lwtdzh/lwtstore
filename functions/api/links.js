// GET /api/links — fetch link exchange data from GitHub, parsed for frontend rendering.
// The source file is fetched fresh on every request (no caching) so changes
// to the GitHub file take effect immediately.

const LINKS_URL = "https://raw.githubusercontent.com/lwtdzh/link-exchange/refs/heads/main/links";

export async function onRequestGet() {
  try {
    const response = await fetch(LINKS_URL, {
      headers: { "User-Agent": "LwtStore/1.0" },
      cf: { cacheTtl: 0 },
    });

    if (!response.ok) {
      return jsonResponse({ error: `Failed to fetch links: ${response.status}` }, 502);
    }

    const text = await response.text();
    const links = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        // Format: "title https://url"
        // Find the last space-separated token that looks like a URL
        const lastSpaceIndex = line.lastIndexOf(" ");
        if (lastSpaceIndex === -1) return null;

        const title = line.substring(0, lastSpaceIndex).trim();
        const url = line.substring(lastSpaceIndex + 1).trim();

        if (!title || !url.startsWith("http")) return null;
        return { title, url };
      })
      .filter(Boolean);

    return jsonResponse({ links });
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
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
