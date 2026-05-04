// GitHub API helper functions
import { BUCKET_PREFIX, MAX_BUCKET_SIZE_KB, GITHUB_API, RAW_GITHUB } from "./constants.js";

// Cache the GitHub owner username (resolved from PAT)
let _cachedOwner = null;
const RETRY_WAIT_MS = 1000;

/**
 * Common headers for GitHub API requests
 */
function headers(pat) {
  return {
    "Authorization": `Bearer ${pat}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "LwtStore/1.0",
  };
}

/**
 * Get the authenticated GitHub user's login name from the PAT.
 * Result is cached for the lifetime of the worker instance.
 * @param {string} pat - GitHub Personal Access Token
 * @returns {string} - GitHub username
 */
export async function getOwner(pat) {
  if (_cachedOwner) return _cachedOwner;

  const res = await fetch(`${GITHUB_API}/user`, {
    headers: headers(pat),
  });

  if (!res.ok) {
    throw new Error(`Failed to get GitHub user from PAT: ${res.status}. Please check your GITHUB_PRIVATE_KEY.`);
  }

  const data = await res.json();
  _cachedOwner = data.login;
  return _cachedOwner;
}

/**
 * Create a new GitHub repository under the configured owner
 * @param {string} pat - GitHub Personal Access Token
 * @param {string} repoName - Repository name (e.g., "lwtsub-bucket-001")
 * @returns {object} - Created repo info
 */
export async function createRepo(pat, repoName) {
  const res = await fetch(`${GITHUB_API}/user/repos`, {
    method: "POST",
    headers: { ...headers(pat), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: repoName,
      description: "Lwt Store storage bucket - auto managed",
      private: false,
      auto_init: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create repo ${repoName}: ${res.status} ${err}`);
  }

  return await res.json();
}

/**
 * Get repository size in KB
 * @param {string} pat - GitHub PAT
 * @param {string} repo - Repository name
 * @returns {number} - Size in KB
 */
export async function getRepoSize(pat, repo) {
  const owner = await getOwner(pat);
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: headers(pat),
  });

  if (!res.ok) {
    throw new Error(`Failed to get repo size for ${repo}: ${res.status}`);
  }

  const data = await res.json();
  return data.size; // size in KB
}

/**
 * List all bucket repositories (lwtsub-bucket-*)
 * @param {string} pat - GitHub PAT
 * @returns {Array} - Array of repo objects with name and size
 */
export async function listBuckets(pat) {
  const owner = await getOwner(pat);
  const buckets = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const res = await fetch(
      `${GITHUB_API}/users/${owner}/repos?per_page=${perPage}&page=${page}&sort=created`,
      { headers: headers(pat) }
    );

    if (!res.ok) {
      throw new Error(`Failed to list repos: ${res.status}`);
    }

    const repos = await res.json();
    if (repos.length === 0) break;

    for (const repo of repos) {
      if (repo.name.startsWith(BUCKET_PREFIX)) {
        buckets.push({
          name: repo.name,
          sizeKB: repo.size,
        });
      }
    }

    if (repos.length < perPage) break;
    page++;
  }

  return buckets;
}

/**
 * Select a suitable bucket for a file, or create a new one
 * @param {string} pat - GitHub PAT
 * @param {number} fileSize - File size in bytes
 * @returns {string} - Bucket repo name
 */
export async function selectBucket(pat, fileSize) {
  const fileSizeKB = Math.ceil(fileSize / 1024);
  const buckets = await listBuckets(pat);

  // Try to find an existing bucket with enough space
  for (const bucket of buckets) {
    if (bucket.sizeKB + fileSizeKB < MAX_BUCKET_SIZE_KB) {
      return bucket.name;
    }
  }

  // No suitable bucket found, create a new one
  const nextNum = (buckets.length + 1).toString().padStart(3, "0");
  const newBucketName = `${BUCKET_PREFIX}${nextNum}`;
  await createRepo(pat, newBucketName);

  // Wait a moment for GitHub to initialize the repo
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return newBucketName;
}

/**
 * Upload a file to a GitHub repository using the Contents API
 * @param {string} pat - GitHub PAT
 * @param {string} repo - Repository name
 * @param {string} path - File path within the repo
 * @param {string} contentBase64 - Base64 encoded file content
 * @param {string} message - Commit message
 * @returns {object} - Upload result with SHA
 */
export async function uploadFile(pat, repo, path, contentBase64, message) {
  const owner = await getOwner(pat);

  while (true) {
    try {
      // First check if file already exists (to get SHA for update).
      // This must be re-read on each retry because GitHub can return 409
      // when a previous timed-out request finished shortly before this one.
      let existingSha = null;
      try {
        existingSha = await getFileSha(pat, repo, path);
      } catch (e) {
        // File doesn't exist, that's fine.
      }

      const body = {
        message: message || `Upload ${path}`,
        content: contentBase64,
      };

      if (existingSha) {
        body.sha = existingSha;
      }

      const res = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
        {
          method: "PUT",
          headers: { ...headers(pat), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (res.ok) {
        const data = await res.json();
        return {
          sha: data.content.sha,
          size: data.content.size,
          downloadUrl: `${RAW_GITHUB}/${owner}/${repo}/main/${path}`,
        };
      }

      const err = await res.text();
      if (!isRetryableGitHubUploadStatus(res.status)) {
        throw new Error(`Failed to upload file ${path} to ${repo}: ${res.status} ${err}`);
      }
    } catch (err) {
      if (err.message && err.message.startsWith("Failed to upload file")) throw err;
    }

    await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
  }
}

function isRetryableGitHubUploadStatus(status) {
  return status === 409 || status === 429 || status >= 500;
}

/**
 * Get the SHA of a file in a repository
 * @param {string} pat - GitHub PAT
 * @param {string} repo - Repository name
 * @param {string} path - File path
 * @returns {string} - File SHA
 */
export async function getFileSha(pat, repo, path) {
  const owner = await getOwner(pat);
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    { headers: headers(pat) }
  );

  if (!res.ok) {
    throw new Error(`File not found: ${path} in ${repo}`);
  }

  const data = await res.json();
  return data.sha;
}

/**
 * Delete a file from a GitHub repository using the Contents API
 * @param {string} pat - GitHub PAT
 * @param {string} repo - Repository name
 * @param {string} path - File path within the repo
 * @param {string} sha - File blob SHA (required by GitHub API)
 * @param {string} message - Commit message
 */
export async function deleteRepoFile(pat, repo, path, sha, message) {
  const owner = await getOwner(pat);

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "DELETE",
      headers: { ...headers(pat), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message || `Delete ${path}`,
        sha,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to delete file ${path} from ${repo}: ${res.status} ${err}`);
  }

  return await res.json();
}

/**
 * Delete all parts of a file from GitHub
 * @param {string} pat - GitHub PAT
 * @param {string} repo - Repository name
 * @param {string} fileId - File ID
 * @param {Array} parts - Array of part objects with index and sha
 */
export async function deleteFileParts(pat, repo, fileId, parts) {
  for (const part of parts) {
    const partPath = `${fileId}/part_${part.index.toString().padStart(4, "0")}`;

    // If we have the SHA from D1, use it directly; otherwise fetch it
    let sha = part.sha;
    if (!sha) {
      try {
        sha = await getFileSha(pat, repo, partPath);
      } catch (e) {
        // Part may already be deleted or not exist, skip
        continue;
      }
    }

    try {
      await deleteRepoFile(pat, repo, partPath, sha, `Delete part ${part.index} of ${fileId}`);
    } catch (e) {
      // Log but continue deleting other parts
      console.error(`Warning: failed to delete ${partPath}: ${e.message}`);
    }
  }
}

/**
 * Fetch raw file content from GitHub with automatic retry.
 * GitHub raw CDN can occasionally return 5xx or time out, especially
 * when many parts are fetched in sequence (e.g. during range-resume downloads).
 *
 * Supports optional byte range via rangeStart/rangeEnd to avoid buffering
 * large parts into memory when only a slice is needed.
 *
 * @param {string} pat - GitHub PAT
 * @param {string} repo - Repository name
 * @param {string} path - File path
 * @param {number} maxRetries - Maximum retry attempts (default 3)
 * @param {number|null} rangeStart - Optional byte range start (inclusive)
 * @param {number|null} rangeEnd - Optional byte range end (inclusive)
 * @returns {Response} - Fetch response (streamable)
 */
export async function fetchRawFile(pat, repo, path, rangeStart = null, rangeEnd = null) {
  const owner = await getOwner(pat);
  const url = `${RAW_GITHUB}/${owner}/${repo}/main/${path}`;

  const requestHeaders = {
    "Authorization": `Bearer ${pat}`,
    "User-Agent": "LwtStore/1.0",
  };

  if (rangeStart !== null) {
    const rangeValue = rangeEnd !== null
      ? `bytes=${rangeStart}-${rangeEnd}`
      : `bytes=${rangeStart}-`;
    requestHeaders["Range"] = rangeValue;
  }

  // Retry forever with a fixed short wait.
  // Only 4xx errors are non-retryable (client error / file not found).
  while (true) {
    try {
      const res = await fetch(url, { headers: requestHeaders });

      // 200 (full) or 206 (partial) are both success
      if (res.ok || res.status === 206) return res;

      // 4xx = client error, not retryable (file doesn't exist, auth failed, etc.)
      if (res.status < 500) {
        throw new Error(`Failed to fetch raw file ${path} from ${repo}: ${res.status}`);
      }

      // 5xx = server error, retryable
    } catch (err) {
      // 4xx errors thrown above — don't retry
      if (err.message.includes("Failed to fetch raw file")) throw err;
      // Network errors (timeout, DNS, etc.) are retryable
    }

    await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
  }
}

/**
 * Get actual file sizes for all parts of a file by querying GitHub Contents API.
 * This is needed because DB part sizes may be inaccurate if PART_SIZE was
 * changed between upload sessions. The Contents API returns accurate sizes
 * without downloading file content.
 *
 * @param {string} pat - GitHub PAT
 * @param {string} repo - Repository name
 * @param {string} fileId - File ID (directory name in the repo)
 * @returns {number[]} - Array of actual part sizes in order
 */
export async function getActualPartSizes(pat, repo, fileId) {
  const owner = await getOwner(pat);
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${fileId}`,
    { headers: headers(pat) }
  );

  if (!res.ok) {
    throw new Error(`Failed to list parts for ${fileId} in ${repo}: ${res.status}`);
  }

  const files = await res.json();

  // Sort by filename to ensure correct order (part_0000, part_0001, ...)
  files.sort((a, b) => a.name.localeCompare(b.name));

  return files.map((f) => f.size);
}
