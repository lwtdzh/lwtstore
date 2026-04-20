// D1 database helper functions for Lwt's Store
//
// Replaces the old KV-based storage (kv.js) with Cloudflare D1 (SQLite).
// The FILES binding is now a D1 database instead of a KV namespace.
//
// Two tables:
//   files - file metadata (fileId, fileName, fileSize, etc.)
//   parts - part/chunk info for each file (fileId, partIndex, size, status, sha)

let tablesEnsured = false;

/**
 * Ensure the required tables exist in the D1 database.
 * Uses CREATE TABLE IF NOT EXISTS so it's safe to call multiple times.
 * Cached per worker instance to avoid repeated DDL calls.
 * @param {D1Database} db - D1 database binding
 */
export async function ensureTables(db) {
  if (tablesEnsured) return;

  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS files (
        fileId TEXT PRIMARY KEY,
        fileName TEXT NOT NULL DEFAULT '',
        fileSize INTEGER NOT NULL DEFAULT 0,
        fileHash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'uploading',
        bucketRepo TEXT NOT NULL DEFAULT '',
        totalParts INTEGER NOT NULL DEFAULT 0,
        downloadUrl TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT '',
        completedAt TEXT
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS parts (
        fileId TEXT NOT NULL,
        partIndex INTEGER NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        sha TEXT,
        PRIMARY KEY (fileId, partIndex),
        FOREIGN KEY (fileId) REFERENCES files(fileId) ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_files_status ON files(status)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_files_hash_status ON files(fileHash, status)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_files_created ON files(createdAt DESC)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_files_filename ON files(fileName COLLATE NOCASE)
    `),
  ]);

  tablesEnsured = true;
}

/**
 * Get a file record from D1, assembled into the same JSON structure as the old KV version.
 * @param {D1Database} db - D1 database binding
 * @param {string} fileId - File ID
 * @returns {object|null} - File record or null
 */
export async function getFile(db, fileId) {
  await ensureTables(db);

  const fileRow = await db.prepare(
    "SELECT * FROM files WHERE fileId = ?"
  ).bind(fileId).first();

  if (!fileRow) return null;

  const partsResult = await db.prepare(
    "SELECT partIndex, size, status, sha FROM parts WHERE fileId = ? ORDER BY partIndex ASC"
  ).bind(fileId).all();

  const parts = (partsResult.results || []).map((p) => ({
    index: p.partIndex,
    size: p.size,
    status: p.status,
    sha: p.sha || null,
  }));

  return {
    fileId: fileRow.fileId,
    fileName: fileRow.fileName,
    fileSize: fileRow.fileSize,
    fileHash: fileRow.fileHash,
    status: fileRow.status,
    bucketRepo: fileRow.bucketRepo,
    totalParts: fileRow.totalParts,
    parts,
    downloadUrl: fileRow.downloadUrl,
    createdAt: fileRow.createdAt,
    completedAt: fileRow.completedAt || null,
  };
}

/**
 * Save a file record to D1 (INSERT OR REPLACE).
 * Replaces both the files row and all parts rows in a batch.
 * @param {D1Database} db - D1 database binding
 * @param {string} fileId - File ID
 * @param {object} data - File record object (same structure as old KV)
 */
export async function setFile(db, fileId, data) {
  await ensureTables(db);

  const statements = [];

  // Upsert the file row
  statements.push(
    db.prepare(`
      INSERT OR REPLACE INTO files (fileId, fileName, fileSize, fileHash, status, bucketRepo, totalParts, downloadUrl, createdAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      fileId,
      data.fileName || "",
      data.fileSize || 0,
      data.fileHash || "",
      data.status || "uploading",
      data.bucketRepo || "",
      data.totalParts || 0,
      data.downloadUrl || "",
      data.createdAt || "",
      data.completedAt || null
    )
  );

  // Delete existing parts and re-insert (simpler than individual upserts)
  statements.push(
    db.prepare("DELETE FROM parts WHERE fileId = ?").bind(fileId)
  );

  if (data.parts && data.parts.length > 0) {
    for (const part of data.parts) {
      statements.push(
        db.prepare(`
          INSERT INTO parts (fileId, partIndex, size, status, sha)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          fileId,
          part.index,
          part.size || 0,
          part.status || "pending",
          part.sha || null
        )
      );
    }
  }

  await db.batch(statements);
}

/**
 * Update a single part's status and SHA in D1.
 * Much faster than setFile() which replaces all parts.
 * @param {D1Database} db - D1 database binding
 * @param {string} fileId - File ID
 * @param {number} partIndex - Part index
 * @param {string} status - New status (e.g., "done")
 * @param {string|null} sha - Git blob SHA
 */
export async function updatePart(db, fileId, partIndex, status, sha) {
  await ensureTables(db);

  await db.prepare(
    "UPDATE parts SET status = ?, sha = ? WHERE fileId = ? AND partIndex = ?"
  ).bind(status, sha || null, fileId, partIndex).run();
}

/**
 * Get the list of uploaded (done) part indices for a file.
 * @param {D1Database} db - D1 database binding
 * @param {string} fileId - File ID
 * @returns {number[]} - Array of uploaded part indices
 */
export async function getUploadedParts(db, fileId) {
  await ensureTables(db);

  const result = await db.prepare(
    "SELECT partIndex FROM parts WHERE fileId = ? AND status = 'done' ORDER BY partIndex ASC"
  ).bind(fileId).all();

  return (result.results || []).map((r) => r.partIndex);
}

/**
 * Delete a file record and its parts from D1.
 * @param {D1Database} db - D1 database binding
 * @param {string} fileId - File ID
 */
export async function deleteFile(db, fileId) {
  await ensureTables(db);

  await db.batch([
    db.prepare("DELETE FROM parts WHERE fileId = ?").bind(fileId),
    db.prepare("DELETE FROM files WHERE fileId = ?").bind(fileId),
  ]);
}

/**
 * List files with pagination and optional fuzzy search.
 * Uses SQL LIKE for search and LIMIT/OFFSET for pagination.
 * Much faster than the old KV full-scan approach.
 *
 * @param {D1Database} db - D1 database binding
 * @param {object} options - { page, pageSize, search }
 * @returns {object} - { files, total, page, pageSize, totalPages }
 */
export async function listFilesPaged(db, { page = 1, pageSize = 20, search = "" } = {}) {
  await ensureTables(db);

  let countSql = "SELECT COUNT(*) as total FROM files WHERE status = 'finished'";
  let listSql = "SELECT fileId, fileName, fileSize, fileHash, status, bucketRepo, totalParts, downloadUrl, createdAt, completedAt FROM files WHERE status = 'finished'";
  const bindings = [];

  if (search) {
    const searchPattern = `%${search}%`;
    countSql += " AND fileName LIKE ? COLLATE NOCASE";
    listSql += " AND fileName LIKE ? COLLATE NOCASE";
    bindings.push(searchPattern);
  }

  // Get total count
  const countResult = await db.prepare(countSql).bind(...bindings).first();
  const total = countResult ? countResult.total : 0;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * pageSize;

  // Get paginated results, sorted by createdAt descending
  listSql += " ORDER BY createdAt DESC LIMIT ? OFFSET ?";
  const listBindings = [...bindings, pageSize, offset];

  const listResult = await db.prepare(listSql).bind(...listBindings).all();
  const rows = listResult.results || [];

  // Map rows to the same format as old KV version
  const files = rows.map((row) => ({
    fileId: row.fileId,
    fileName: row.fileName,
    fileSize: row.fileSize,
    fileHash: row.fileHash,
    status: row.status,
    bucketRepo: row.bucketRepo,
    totalParts: row.totalParts,
    downloadUrl: row.downloadUrl,
    createdAt: row.createdAt,
    completedAt: row.completedAt || null,
  }));

  return { files, total, page: safePage, pageSize, totalPages };
}

/**
 * Update only the status and completedAt fields of a file record.
 * Much cheaper than setFile() which deletes and re-inserts all parts.
 * @param {D1Database} db - D1 database binding
 * @param {string} fileId - File ID
 * @param {string} status - New status (e.g., "finished")
 * @param {string|null} completedAt - Completion timestamp (ISO string)
 */
export async function updateFileStatus(db, fileId, status, completedAt = null) {
  await ensureTables(db);

  await db.prepare(
    "UPDATE files SET status = ?, completedAt = ? WHERE fileId = ?"
  ).bind(status, completedAt, fileId).run();
}

/**
 * Find a file record by file hash (for resume detection).
 * Only matches files with status = 'uploading'.
 * @param {D1Database} db - D1 database binding
 * @param {string} fileHash - File hash (name+size+lastModified)
 * @returns {object|null} - File record if found
 */
export async function findByHash(db, fileHash) {
  await ensureTables(db);

  const row = await db.prepare(
    "SELECT fileId FROM files WHERE fileHash = ? AND status = 'uploading' LIMIT 1"
  ).bind(fileHash).first();

  if (!row) return null;

  // Return the full file record (with parts)
  return await getFile(db, row.fileId);
}
