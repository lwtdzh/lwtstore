// KV helper functions for Lwt's Store
// Uses a single KV namespace (KV_STORE) with key prefixes for METADATA and INDEX

const METADATA_PREFIX = "metadata:";
const INDEX_LIST_KEY = "index:files";

/**
 * Get file metadata from KV
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} fileId - File ID
 * @returns {object|null} - File metadata or null
 */
export async function getMetadata(kv, fileId) {
  const data = await kv.get(`${METADATA_PREFIX}${fileId}`, "json");
  return data;
}

/**
 * Set file metadata in KV
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} fileId - File ID
 * @param {object} data - Metadata object
 */
export async function setMetadata(kv, fileId, data) {
  await kv.put(`${METADATA_PREFIX}${fileId}`, JSON.stringify(data));
}

/**
 * Get the full file index (list of all files)
 * @param {KVNamespace} kv - KV namespace binding
 * @returns {Array} - Array of file index entries
 */
export async function getIndex(kv) {
  const data = await kv.get(INDEX_LIST_KEY, "json");
  return data || [];
}

/**
 * Add a file entry to the index
 * @param {KVNamespace} kv - KV namespace binding
 * @param {object} fileInfo - File info object { fileId, fileName, fileSize, status, createdAt, downloadUrl }
 */
export async function addToIndex(kv, fileInfo) {
  const index = await getIndex(kv);
  // Check if already exists (for resume scenarios)
  const existingIdx = index.findIndex((f) => f.fileId === fileInfo.fileId);
  if (existingIdx >= 0) {
    index[existingIdx] = { ...index[existingIdx], ...fileInfo };
  } else {
    index.push(fileInfo);
  }
  await kv.put(INDEX_LIST_KEY, JSON.stringify(index));
}

/**
 * Update a file entry in the index
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} fileId - File ID
 * @param {object} updates - Fields to update
 */
export async function updateIndex(kv, fileId, updates) {
  const index = await getIndex(kv);
  const idx = index.findIndex((f) => f.fileId === fileId);
  if (idx >= 0) {
    index[idx] = { ...index[idx], ...updates };
    await kv.put(INDEX_LIST_KEY, JSON.stringify(index));
  }
}

/**
 * Find a file metadata by file hash (for resume detection)
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} fileHash - File hash (name+size+lastModified)
 * @returns {object|null} - Metadata if found
 */
export async function findByHash(kv, fileHash) {
  // List all metadata keys to find matching hash
  const list = await kv.list({ prefix: METADATA_PREFIX });
  for (const key of list.keys) {
    const meta = await kv.get(key.name, "json");
    if (meta && meta.fileHash === fileHash && meta.status === "uploading") {
      return meta;
    }
  }
  return null;
}
