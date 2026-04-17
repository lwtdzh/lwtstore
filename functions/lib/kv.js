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
 * Find a file record by file hash (for resume detection)
 * Scans all keys in FILES KV to find a matching uploading file
 * @param {KVNamespace} filesKv - FILES KV namespace binding
 * @param {string} fileHash - File hash (name+size+lastModified)
 * @returns {object|null} - File record if found
 */
export async function findByHash(filesKv, fileHash) {
  let cursor = null;

  do {
    const listOpts = { limit: 1000 };
    if (cursor) listOpts.cursor = cursor;

    const result = await filesKv.list(listOpts);

    for (const key of result.keys) {
      const file = await filesKv.get(key.name, "json");
      if (file && file.fileHash === fileHash && file.status === "uploading") {
        return file;
      }
    }

    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);

  return null;
}
