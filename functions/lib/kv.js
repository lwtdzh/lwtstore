// KV helper functions for Lwt's Store
//
// Two KV namespaces:
//   FILES    - each key is a fileId, value is the file's full data (metadata + parts + status)
//   METADATA - reserved for future use (e.g., site config, user settings, analytics)

/**
 * Get a file record from FILES KV
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @param {string} fileId - File ID
 * @returns {object|null} - File record or null
 */
export async function getFile(filesKv, fileId) {
  return await filesKv.get(fileId, "json");
}

/**
 * Save a file record to FILES KV
 * Stores fileName and status as KV metadata so list() can filter without get()
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @param {string} fileId - File ID
 * @param {object} data - File record object
 */
export async function setFile(filesKv, fileId, data) {
  await filesKv.put(fileId, JSON.stringify(data), {
    metadata: {
      fileName: data.fileName || "",
      status: data.status || "",
      fileSize: data.fileSize || 0,
      createdAt: data.createdAt || "",
    },
  });
}

/**
 * Delete a file record from FILES KV
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @param {string} fileId - File ID
 */
export async function deleteFile(filesKv, fileId) {
  await filesKv.delete(fileId);
}

/**
 * List all file records from FILES KV
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @returns {Array} - Array of file records
 */
export async function listFiles(filesKv) {
  const files = [];
  let cursor = null;

  do {
    const listOpts = { limit: 1000 };
    if (cursor) listOpts.cursor = cursor;

    const result = await filesKv.list(listOpts);

    for (const key of result.keys) {
      // Skip hash mapping keys (hash:xxx -> fileId)
      if (key.name.startsWith("hash:")) continue;

      const file = await filesKv.get(key.name, "json");
      if (file) {
        files.push(file);
      }
    }

    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);

  return files;
}

/**
 * Save a hash-to-fileId mapping for fast resume detection
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @param {string} fileHash - File hash (name+size+lastModified)
 * @param {string} fileId - File ID
 */
export async function setHashMapping(filesKv, fileHash, fileId) {
  await filesKv.put(`hash:${fileHash}`, fileId);
}

/**
 * Remove a hash-to-fileId mapping (after upload completes)
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @param {string} fileHash - File hash
 */
export async function deleteHashMapping(filesKv, fileHash) {
  await filesKv.delete(`hash:${fileHash}`);
}

/**
 * Find a file record by file hash (for resume detection)
 * Uses a direct hash->fileId mapping key for consistency (avoids list() eventual consistency)
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @param {string} fileHash - File hash (name+size+lastModified)
 * @returns {object|null} - File record if found
 */
export async function findByHash(filesKv, fileHash) {
  // Direct lookup via hash mapping key
  const fileId = await filesKv.get(`hash:${fileHash}`);
  if (fileId) {
    const file = await filesKv.get(fileId, "json");
    if (file && file.status === "uploading") {
      return file;
    }
  }
  return null;
}

/**
 * Collect all finished file keys with metadata, with fallback for legacy records.
 * Shared helper for both paged listing and search.
 */
async function collectAllFileKeys(filesKv) {
  const allKeys = [];
  let cursor = null;

  do {
    const listOpts = { limit: 1000 };
    if (cursor) listOpts.cursor = cursor;

    const result = await filesKv.list(listOpts);

    for (const key of result.keys) {
      if (key.name.startsWith("hash:")) continue;

      const meta = key.metadata || {};
      let fileName = meta.fileName || "";
      let fileSize = meta.fileSize || 0;
      let createdAt = meta.createdAt || "";
      let status = meta.status || "";

      // If metadata is missing (legacy records), fetch full record
      if (!fileName) {
        const file = await filesKv.get(key.name, "json");
        if (!file) continue;
        fileName = file.fileName || "";
        fileSize = file.fileSize || 0;
        createdAt = file.createdAt || "";
        status = file.status || "";

        // Backfill metadata for legacy records so future requests are fast
        if (fileName) {
          await filesKv.put(key.name, JSON.stringify(file), {
            metadata: { fileName, status, fileSize, createdAt },
          });
        }
      }

      // Filter: only finished files
      if (status && status !== "finished") continue;

      allKeys.push({ fileId: key.name, fileName, fileSize, createdAt });
    }

    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);

  // Sort by createdAt descending (newest first)
  allKeys.sort((a, b) => {
    if (!a.createdAt || !b.createdAt) return 0;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  return allKeys;
}

/**
 * List files with pagination and optional search.
 *
 * Two modes:
 *   - No search: uses KV list() with limit to quickly return the first page
 *     without scanning all keys. This makes initial page load fast.
 *   - With search: scans all keys (using metadata) to find matches across
 *     all files, then paginates the results.
 *
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @param {object} options - { page, pageSize, search }
 * @returns {object} - { files, total, page, pageSize, totalPages }
 */
export async function listFilesPaged(filesKv, { page = 1, pageSize = 20, search = "" } = {}) {
  // With search: must scan all keys to find matches across all pages
  if (search) {
    const allKeys = await collectAllFileKeys(filesKv);

    // Filter by search keyword
    const searchLower = search.toLowerCase();
    const matchedKeys = allKeys.filter((k) =>
      k.fileName.toLowerCase().includes(searchLower)
    );

    const total = matchedKeys.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (safePage - 1) * pageSize;
    const pageKeys = matchedKeys.slice(startIndex, startIndex + pageSize);

    const files = [];
    for (const key of pageKeys) {
      const file = await filesKv.get(key.fileId, "json");
      if (file) files.push(file);
    }

    return { files, total, page: safePage, pageSize, totalPages };
  }

  // No search: fast path using KV list() with limit for quick first-page load
  // We collect finished files page by page using KV cursor
  const collected = [];
  let kvCursor = null;
  const targetCount = page * pageSize; // Need enough items to fill up to current page

  do {
    const listOpts = { limit: 1000 };
    if (kvCursor) listOpts.cursor = kvCursor;

    const result = await filesKv.list(listOpts);

    for (const key of result.keys) {
      if (key.name.startsWith("hash:")) continue;

      const meta = key.metadata || {};
      let fileName = meta.fileName || "";
      let fileSize = meta.fileSize || 0;
      let createdAt = meta.createdAt || "";
      let status = meta.status || "";

      if (!fileName) {
        const file = await filesKv.get(key.name, "json");
        if (!file) continue;
        fileName = file.fileName || "";
        fileSize = file.fileSize || 0;
        createdAt = file.createdAt || "";
        status = file.status || "";

        // Backfill metadata
        if (fileName) {
          await filesKv.put(key.name, JSON.stringify(file), {
            metadata: { fileName, status, fileSize, createdAt },
          });
        }
      }

      if (status && status !== "finished") continue;

      collected.push({ fileId: key.name, fileName, fileSize, createdAt });
    }

    kvCursor = result.list_complete ? null : result.cursor;
  } while (kvCursor);

  // Sort by createdAt descending
  collected.sort((a, b) => {
    if (!a.createdAt || !b.createdAt) return 0;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const total = collected.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const pageKeys = collected.slice(startIndex, startIndex + pageSize);

  const files = [];
  for (const key of pageKeys) {
    const file = await filesKv.get(key.fileId, "json");
    if (file) files.push(file);
  }

  return { files, total, page: safePage, pageSize, totalPages };
}
