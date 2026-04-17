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
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @param {string} fileId - File ID
 * @param {object} data - File record object
 */
export async function setFile(filesKv, fileId, data) {
  await filesKv.put(fileId, JSON.stringify(data));
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
